import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/db";
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from "../lib/jwt";
import { requireAuth } from "../middleware/auth";
import { COOKIE_NAME } from "../../../shared/const";
import { emitToCompany } from "../sockets";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password format" });
  }
  const { email, password } = parsed.data;

  const employee = await prisma.employee.findUnique({ where: { email } });
  // Deliberately identical error for "no such user" and "wrong password" —
  // distinguishing them lets an attacker enumerate valid company emails.
  const invalidMsg = { error: "Invalid email or password" };

  if (!employee) return res.status(401).json(invalidMsg);

  const ok = await bcrypt.compare(password, employee.password);
  if (!ok) return res.status(401).json(invalidMsg);

  if (employee.status === "SUSPENDED") {
    return res.status(403).json({ error: "This account has been suspended. Contact your administrator." });
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

  res.cookie(COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
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
});

authRouter.post("/refresh", async (req, res) => {
  const oldToken = req.cookies?.[COOKIE_NAME];
  if (!oldToken) return res.status(401).json({ error: "No refresh token" });

  const rotated = await rotateRefreshToken(oldToken);
  if (!rotated) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: "Session expired, please log in again" });
  }

  const employee = await prisma.employee.findUnique({ where: { id: rotated.employeeId } });
  if (!employee) return res.status(401).json({ error: "Session expired, please log in again" });

  const accessToken = signAccessToken({
    employeeId: employee.id,
    companyId: employee.companyId,
    departmentId: employee.departmentId,
    role: employee.role,
  });

  res.cookie(COOKIE_NAME, rotated.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
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
  const token = req.cookies?.[COOKIE_NAME];
  if (token) await revokeRefreshToken(token);

  await prisma.employee.update({
    where: { id: req.user!.employeeId },
    data: { status: "OFFLINE", lastActiveAt: new Date() },
  });

  emitToCompany(req.user!.companyId, "employee:status-changed", {
    employeeId: req.user!.employeeId,
    status: "OFFLINE",
  });

  res.clearCookie(COOKIE_NAME);
  return res.json({ success: true });
});