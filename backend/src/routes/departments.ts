import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole } from "../middleware/rbac";

export const departmentsRouter = Router();

/**
 * GET / — every department in the caller's company, with manager info and a
 * head count. Open to any authenticated role (not just Manager+): department
 * *names* aren't sensitive, and the employee desktop app / reply flows may
 * eventually want this list too. Sensitive per-department numbers still live
 * behind /api/analytics/departments/:id, which does enforce Manager+ and
 * "your own department only" for Managers.
 */
departmentsRouter.get("/", requireAuth, async (req, res) => {
  const departments = await prisma.department.findMany({
    where: { companyId: req.user!.companyId },
    include: {
      manager: { select: { id: true, firstName: true, lastName: true, email: true } },
      _count: { select: { employees: true } },
    },
    orderBy: { name: "asc" },
  });
  return res.json(departments);
});

const createSchema = z.object({
  name: z.string().min(1),
  managerId: z.string().uuid().optional().nullable(),
});

async function assertManagerInCompany(managerId: string | null | undefined, companyId: string) {
  if (!managerId) return true;
  const manager = await prisma.employee.findUnique({ where: { id: managerId } });
  return Boolean(manager && manager.companyId === companyId);
}

departmentsRouter.post("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid department data" });

  if (!(await assertManagerInCompany(parsed.data.managerId, req.user!.companyId))) {
    return res.status(400).json({ error: "Manager must belong to your company" });
  }

  const department = await prisma.department.create({
    data: {
      name: parsed.data.name,
      companyId: req.user!.companyId,
      managerId: parsed.data.managerId ?? null,
    },
  });
  return res.status(201).json(department);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  managerId: z.string().uuid().nullable().optional(),
});

departmentsRouter.patch("/:id", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update payload" });

  const existing = await prisma.department.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.companyId !== req.user!.companyId) {
    return res.status(404).json({ error: "Department not found" });
  }
  if (!(await assertManagerInCompany(parsed.data.managerId, req.user!.companyId))) {
    return res.status(400).json({ error: "Manager must belong to your company" });
  }

  const department = await prisma.department.update({ where: { id: req.params.id }, data: parsed.data });
  return res.json(department);
});

departmentsRouter.delete("/:id", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const existing = await prisma.department.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { employees: true } } },
  });
  if (!existing || existing.companyId !== req.user!.companyId) {
    return res.status(404).json({ error: "Department not found" });
  }
  if (existing._count.employees > 0) {
    return res.status(400).json({ error: "Reassign or remove employees from this department before deleting it" });
  }

  await prisma.department.delete({ where: { id: req.params.id } });
  return res.json({ success: true });
});
