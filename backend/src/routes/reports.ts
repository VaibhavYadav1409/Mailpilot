import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole, canActOnEmployee } from "../middleware/rbac";
import { generateReport } from "../services/reportEngine";
import { readReport } from "../lib/reportStorage";

export const reportsRouter = Router();

const generateSchema = z.object({
  scope: z.enum(["COMPANY", "DEPARTMENT", "EMPLOYEE"]),
  scopeId: z.string().uuid().optional(),
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).default("WEEKLY"),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
});

function defaultRangeFor(period: "DAILY" | "WEEKLY" | "MONTHLY", end: Date) {
  const days = period === "DAILY" ? 1 : period === "WEEKLY" ? 7 : 30;
  return new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Admin+ only — report generation is heavier than a normal read and produces a file, unlike the read-only analytics routes. */
reportsRouter.post("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid report request" });
  const { scope, scopeId, period } = parsed.data;

  if (scope !== "COMPANY" && !scopeId) {
    return res.status(400).json({ error: "scopeId is required for DEPARTMENT or EMPLOYEE scope" });
  }

  if (scope === "DEPARTMENT" && scopeId) {
    const dept = await prisma.department.findUnique({ where: { id: scopeId } });
    if (!dept || dept.companyId !== req.user!.companyId) {
      return res.status(404).json({ error: "Department not found" });
    }
  }
  if (scope === "EMPLOYEE" && scopeId) {
    const allowed = await canActOnEmployee(req.user!, scopeId);
    if (!allowed) return res.status(403).json({ error: "You do not have permission to report on this employee" });
  }

  const periodEnd = parsed.data.periodEnd ?? new Date();
  const periodStart = parsed.data.periodStart ?? defaultRangeFor(period, periodEnd);

  const { report } = await generateReport({
    companyId: req.user!.companyId,
    scope,
    scopeId: scopeId ?? null,
    period,
    periodStart,
    periodEnd,
  });

  return res.status(201).json(report);
});

reportsRouter.get("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const reports = await prisma.report.findMany({
    where: { companyId: req.user!.companyId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return res.json(reports);
});

reportsRouter.get("/:id/download", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report || report.companyId !== req.user!.companyId) {
    return res.status(404).json({ error: "Report not found" });
  }

  try {
    const csv = await readReport(report.id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="mailpilot-report-${report.id}.csv"`);
    return res.send(csv);
  } catch {
    return res.status(404).json({ error: "Report file not found in storage" });
  }
});
