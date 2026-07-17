import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole, employeeScopeFilter, canActOnEmployee } from "../middleware/rbac";
import { ROLE_RANK, type Role } from "../../../shared/const";
import { emitToCompany } from "../sockets";
import { sendTempPasswordEmail } from "../lib/email";

export const employeesRouter = Router();

const employeeSummary = {
  id: true,
  employeeCode: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  lastActiveAt: true,
  createdAt: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  gmailAccounts: { where: { isActive: true }, take: 1, select: { emailAddress: true, status: true, lastSyncedAt: true } },
} as const;

// Employee.gmailAccounts is a one-to-many relation (an employee can have
// switched accounts over time), but the admin dashboard only ever needs
// "the one currently in use" — this flattens the (at most one, thanks to
// the isActive:true filter in employeeSummary) selected row back to a
// singular `gmailAccount` field so the frontend's existing
// `employee.gmailAccount?.status` etc. keeps working unchanged.
function withActiveGmailAccount<T extends { gmailAccounts?: unknown[] }>(
  employee: T
): Omit<T, "gmailAccounts"> & { gmailAccount: unknown } {
  const { gmailAccounts, ...rest } = employee;
  return { ...rest, gmailAccount: gmailAccounts?.[0] ?? null };
}

/**
 * GET / — list employees the caller is allowed to see.
 * CEO/COO/ADMIN: whole company. MANAGER: own department. EMPLOYEE: self only
 * (employeeScopeFilter already encodes all three, so this route never has to
 * branch on role itself).
 */
employeesRouter.get("/", requireAuth, async (req, res) => {
  const employees = await prisma.employee.findMany({
    where: employeeScopeFilter(req.user!),
    select: employeeSummary,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return res.json(employees.map(withActiveGmailAccount));
});

employeesRouter.get("/:id", requireAuth, async (req, res) => {
  const allowed = await canActOnEmployee(req.user!, req.params.id);
  if (!allowed) return res.status(403).json({ error: "You do not have permission to view this employee" });

  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    select: employeeSummary,
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  // DailyAnalytics.employeeId is a plain field, not a declared Prisma
  // relation on Employee (the schema has no back-reference array for it) —
  // filtering directly on employeeId here, rather than via a nested
  // `include`, is what actually works against the schema as written.
  const dailyAnalytics = await prisma.dailyAnalytics.findMany({
    where: { employeeId: employee.id },
    orderBy: { date: "desc" },
    take: 30,
  });

  return res.json({ ...withActiveGmailAccount(employee), dailyAnalytics });
});

const createSchema = z.object({
  employeeCode: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["CEO", "COO", "ADMIN", "MANAGER", "EMPLOYEE"]),
  departmentId: z.string().uuid().optional().nullable(),
});

/**
 * POST / — create an employee. Admin+ only. Two things are deliberately not
 * client-controlled: companyId (always the actor's own company) and the
 * ability to hand out a role above the actor's own rank — an Admin can't
 * mint a CEO.
 */
employeesRouter.post("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid employee data" });
  const data = parsed.data;

  if (ROLE_RANK[data.role as Role] > ROLE_RANK[req.user!.role]) {
    return res.status(403).json({ error: "You cannot assign a role higher than your own" });
  }

  if (data.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: data.departmentId } });
    if (!dept || dept.companyId !== req.user!.companyId) {
      return res.status(400).json({ error: "Department not found in your company" });
    }
  }

  const existing = await prisma.employee.findUnique({ where: { email: data.email } });
  if (existing) return res.status(409).json({ error: "An employee with this email already exists" });

  // Temp password, returned once so the admin can hand it to the new
  // employee directly — there's no outbound-email system in this backend
  // yet to send it for them (that belongs with Phase 8's notification work).
  const tempPassword = nanoid(12);
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const employee = await prisma.employee.create({
    data: {
      employeeCode: data.employeeCode,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role,
      companyId: req.user!.companyId,
      departmentId: data.departmentId ?? null,
      password: passwordHash,
    },
    select: employeeSummary,
  });

  await prisma.auditLog.create({
    data: {
      companyId: req.user!.companyId,
      employeeId: req.user!.employeeId,
      action: "EMPLOYEE_CREATED",
      metadata: { createdEmployeeId: employee.id, role: employee.role },
    },
  });

  void sendTempPasswordEmail(employee.email, tempPassword, false);

  return res.status(201).json({ employee: withActiveGmailAccount(employee), tempPassword });
});

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(["CEO", "COO", "ADMIN", "MANAGER", "EMPLOYEE"]).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  status: z.enum(["ONLINE", "OFFLINE", "IDLE", "SUSPENDED"]).optional(),
});

/** PATCH /:id — update profile fields, reassign department, change role, suspend/reactivate. */
employeesRouter.patch("/:id", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const allowed = await canActOnEmployee(req.user!, req.params.id);
  if (!allowed) return res.status(403).json({ error: "You do not have permission to modify this employee" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update payload" });
  const data = parsed.data;

  if (data.role && ROLE_RANK[data.role as Role] > ROLE_RANK[req.user!.role]) {
    return res.status(403).json({ error: "You cannot assign a role higher than your own" });
  }
  if (data.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: data.departmentId } });
    if (!dept || dept.companyId !== req.user!.companyId) {
      return res.status(400).json({ error: "Department not found in your company" });
    }
  }

  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data,
    select: employeeSummary,
  });

  await prisma.auditLog.create({
    data: {
      companyId: req.user!.companyId,
      employeeId: req.user!.employeeId,
      action: "EMPLOYEE_UPDATED",
      metadata: { targetEmployeeId: employee.id, changes: data },
    },
  });

  // Live-update the admin dashboard (e.g. a suspend takes effect on other
  // open dashboards immediately, not just after their next poll).
  emitToCompany(req.user!.companyId, "employee:updated", { employeeId: employee.id, status: employee.status });

  return res.json(withActiveGmailAccount(employee));
});

/** POST /:id/reset-password — Admin+ only. Returns the new temp password once; it is never stored in plaintext. */
employeesRouter.post("/:id/reset-password", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const allowed = await canActOnEmployee(req.user!, req.params.id);
  if (!allowed) return res.status(403).json({ error: "You do not have permission to reset this employee's password" });

  const tempPassword = nanoid(12);
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  await prisma.employee.update({ where: { id: req.params.id }, data: { password: passwordHash } });

  await prisma.auditLog.create({
    data: {
      companyId: req.user!.companyId,
      employeeId: req.user!.employeeId,
      action: "EMPLOYEE_PASSWORD_RESET",
      metadata: { targetEmployeeId: req.params.id },
    },
  });

  const target = await prisma.employee.findUnique({ where: { id: req.params.id }, select: { email: true } });
  if (target) void sendTempPasswordEmail(target.email, tempPassword, true);

  return res.json({ tempPassword });
});
