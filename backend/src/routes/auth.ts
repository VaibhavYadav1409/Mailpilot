import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/db";
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from "../lib/jwt";
import { requireAuth } from "../middleware/auth";
import { COOKIE_NAME } from "../../../shared/const";
import { emitToCompany } from "../sockets";

export const authRouter = Router();

// Browsers reject any cookie marked SameSite=None unless it is also Secure —
// so these two flags must always toggle together, not just `secure` alone.
// In production (cross-site: Vercel admin dashboard / Electron app talking to
// a Render backend on a different origin) that means SameSite=None + Secure.
// In local dev (plain http://localhost, no TLS) Secure can't be set, so we
// fall back to SameSite=Lax — which still works because different localhost
// ports are treated as "same-site" by browsers, only "cross-site" requests
// are restricted under Lax.
const isProd = process.env.NODE_ENV === "production";
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? "none" : "lax") as "none" | "lax",
} as const;

// The admin dashboard and the employee portal are two different sites that
// talk to the same backend, so the browser stores their refresh cookies on the
// same (Render) domain. With a single cookie name, signing in to the employee
// portal as an employee silently replaced the CEO's admin session, and the
// admin site then showed "Manager access required". Each site now gets its own
// cookie: the admin dashboard calls /auth/* with ?client=admin.
const ADMIN_COOKIE_NAME = `${COOKIE_NAME}_admin`;
const ADMIN_MIN_ROLES = new Set(["MANAGER", "ADMIN", "COO", "CEO"]);

function isAdminClient(req: Request): boolean {
  return req.query.client === "admin";
}

function cookieNameFor(req: Request): string {
  return isAdminClient(req) ? ADMIN_COOKIE_NAME : COOKIE_NAME;
}

// Browsers only drop a SameSite=None cookie when the clearing Set-Cookie
// carries the same flags, so clearing must reuse the options it was set with.
function clearRefreshCookie(req: Request, res: import("express").Response) {
  res.clearCookie(cookieNameFor(req), REFRESH_COOKIE_OPTIONS);
}

// `email` is the login identifier: a real email for most accounts, or a plain
// username (e.g. "anjali") for staff who were set up without an email address.
// Matched case-insensitively so "Anjali" and "ANJALI" both work.
const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password format" });
  }
  const { email, password } = parsed.data;

  try {
    const employee = await prisma.employee.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    // Deliberately identical error for "no such user" and "wrong password" —
    // distinguishing them lets an attacker enumerate valid company emails.
    const invalidMsg = { error: "Invalid email or password" };

    if (!employee) return res.status(401).json(invalidMsg);

    const ok = await bcrypt.compare(password, employee.password);
    if (!ok) return res.status(401).json(invalidMsg);

    if (employee.status === "SUSPENDED") {
      return res.status(403).json({ error: "This account has been suspended. Contact your administrator." });
    }

    if (isAdminClient(req) && !ADMIN_MIN_ROLES.has(employee.role)) {
      return res.status(403).json({
        error: "This is an employee account. Please sign in on the Employee Portal to use email and My MIS.",
      });
    }

    const accessToken = signAccessToken({
      employeeId: employee.id,
      companyId: employee.companyId,
      departmentId: employee.departmentId,
      role: employee.role,
    });
    const refreshToken = await issueRefreshToken(employee.id);

    await prisma.employee.update({
      where: { id: employee.id },
      data: { status: "ONLINE", lastActiveAt: new Date() },
    });

    emitToCompany(employee.companyId, "employee:status-changed", { employeeId: employee.id, status: "ONLINE" });

    res.cookie(cookieNameFor(req), refreshToken, {
      ...REFRESH_COOKIE_OPTIONS,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    return res.json({
      accessToken,
      employee: {
        id: employee.id,
        email: employee.email,
        firstName: employee.firstName,
        lastName: employee.lastName,
        role: employee.role,
        companyId: employee.companyId,
        departmentId: employee.departmentId,
      },
    });
  } catch (e) {
    // Almost always a transient database-connectivity error (e.g. the Neon
    // serverless DB waking from suspend, or an unreachable endpoint). Return a
    // clear 503 so the client can retry — and, critically, so this NEVER
    // becomes an unhandled rejection that crashes the whole server.
    console.error("[auth] login failed — database unreachable?", e);
    return res.status(503).json({ error: "Service temporarily unavailable. Please try again in a moment." });
  }
});

authRouter.post("/refresh", async (req, res) => {
  const oldToken = req.cookies?.[cookieNameFor(req)];
  if (!oldToken) return res.status(401).json({ error: "No refresh token" });

  const rotated = await rotateRefreshToken(oldToken);
  if (!rotated) {
    clearRefreshCookie(req, res);
    return res.status(401).json({ error: "Session expired, please log in again" });
  }

  const employee = await prisma.employee.findUnique({ where: { id: rotated.employeeId } });
  if (!employee || employee.status === "SUSPENDED" || (isAdminClient(req) && !ADMIN_MIN_ROLES.has(employee.role))) {
    await revokeRefreshToken(rotated.refreshToken);
    clearRefreshCookie(req, res);
    return res.status(401).json({ error: "Session expired, please log in again" });
  }

  const accessToken = signAccessToken({
    employeeId: employee.id,
    companyId: employee.companyId,
    departmentId: employee.departmentId,
    role: employee.role,
  });

  res.cookie(cookieNameFor(req), rotated.refreshToken, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });

  return res.json({ accessToken });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.user!.employeeId } });
  if (!employee) return res.status(401).json({ error: "Session expired, please log in again" });
  return res.json({
    employee: {
      id: employee.id,
      email: employee.email,
      firstName: employee.firstName,
      lastName: employee.lastName,
      role: employee.role,
      companyId: employee.companyId,
      departmentId: employee.departmentId,
    },
  });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  const token = req.cookies?.[cookieNameFor(req)];
  if (token) await revokeRefreshToken(token);

  await prisma.employee.update({
    where: { id: req.user!.employeeId },
    data: { status: "OFFLINE", lastActiveAt: new Date() },
  });

  emitToCompany(req.user!.companyId, "employee:status-changed", {
    employeeId: req.user!.employeeId,
    status: "OFFLINE",
  });

  clearRefreshCookie(req, res);
  return res.json({ success: true });
});