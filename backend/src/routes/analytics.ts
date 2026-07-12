import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole, canActOnEmployee } from "../middleware/rbac";
import { getCompanyOverview, getDepartmentAnalytics, getEmployeeAnalytics, getLeaderboard } from "../services/analyticsQuery";
import { runDailyAnalyticsRollup } from "../services/analyticsEngine";

export const analyticsRouter = Router();

const rangeSchema = z.object({
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
});

function resolveRange(q: { start?: Date; end?: Date }) {
  const end = q.end ?? new Date();
  const start = q.start ?? new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000); // default: trailing 7 days
  return { start, end };
}

/** Company-wide dashboard overview — Manager and above (a Manager sees their own company's overview; department-level detail is the /departments/:id route below). */
analyticsRouter.get("/company/overview", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const overview = await getCompanyOverview(req.user!.companyId);
  return res.json(overview);
});

/** Department rollup — Managers can only view their own department; Admin+ can view any department in their company. */
analyticsRouter.get("/departments/:id", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid date range" });

  const department = await prisma.department.findUnique({ where: { id: req.params.id } });
  if (!department || department.companyId !== req.user!.companyId) {
    return res.status(404).json({ error: "Department not found" });
  }
  if (req.user!.role === "MANAGER" && department.id !== req.user!.departmentId) {
    return res.status(403).json({ error: "You can only view your own department" });
  }

  const { start, end } = resolveRange(parsed.data);
  const analytics = await getDepartmentAnalytics(department.id, start, end);
  return res.json({ department: { id: department.id, name: department.name }, range: { start, end }, ...analytics });
});

/**
 * Single employee's analytics. Self, or a manager of their department, or
 * Admin+ — enforced by the same canActOnEmployee check used for employee
 * management actions in Phase 2, so viewing analytics follows the identical
 * access rule as suspending/reassigning that employee.
 */
analyticsRouter.get("/employees/:id", requireAuth, async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid date range" });

  const allowed = await canActOnEmployee(req.user!, req.params.id);
  if (!allowed) return res.status(403).json({ error: "You do not have permission to view this employee" });

  const { start, end } = resolveRange(parsed.data);
  const rows = await getEmployeeAnalytics(req.params.id, start, end);
  return res.json({ employeeId: req.params.id, range: { start, end }, days: rows });
});

/**
 * Top performers company-wide by average productivity score. Manager+ only —
 * a plain Employee doesn't get a company-wide ranking of their coworkers.
 */
const leaderboardQuerySchema = z.object({
  range: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
});
analyticsRouter.get("/leaderboard", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid range" });

  const leaderboard = await getLeaderboard(req.user!.companyId, parsed.data.range);
  return res.json(leaderboard);
});

/**
 * Manually triggers the daily rollup. In production this belongs behind a
 * scheduler (cron/queue worker), not a user-facing route — this endpoint is
 * here for local testing and as a manual "recompute now" escape hatch, so
 * it's locked to Admin+ rather than exposed to Managers/Employees.
 */
analyticsRouter.post("/rollup/run", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const dateStr = req.body?.date;
  const date = dateStr ? new Date(dateStr) : new Date();
  const result = await runDailyAnalyticsRollup(date);
  return res.json(result);
});
