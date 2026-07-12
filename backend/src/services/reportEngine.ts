import { prisma } from "../lib/db";
import { writeReport } from "../lib/reportStorage";

function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))];
  return lines.join("\n");
}

function summarizeRows(rows: { emailsReceived: number; emailsReplied: number; avgReplyTimeSec: number | null; productivityScore: number | null }[]) {
  const emailsReceived = rows.reduce((s, r) => s + r.emailsReceived, 0);
  const emailsReplied = rows.reduce((s, r) => s + r.emailsReplied, 0);
  const replyTimes = rows.map((r) => r.avgReplyTimeSec).filter((v): v is number => v !== null);
  const scores = rows.map((r) => r.productivityScore).filter((v): v is number => v !== null);
  return {
    emailsReceived,
    emailsReplied,
    responseRate: emailsReceived > 0 ? Math.round((emailsReplied / emailsReceived) * 100) : 0,
    avgReplyTimeMin: replyTimes.length ? Math.round(replyTimes.reduce((s, v) => s + v, 0) / replyTimes.length / 60) : 0,
    productivityScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0,
  };
}

type Scope = "COMPANY" | "DEPARTMENT" | "EMPLOYEE";

interface GenerateReportArgs {
  companyId: string;
  scope: Scope;
  scopeId?: string | null;
  period: "DAILY" | "WEEKLY" | "MONTHLY";
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Builds the CSV for a report and writes it to disk. companyId/scopeId are
 * always resolved server-side against the caller's own company — the route
 * layer is responsible for RBAC, this function just trusts the ids it's
 * given belong to the right company (routes/reports.ts enforces that).
 */
export async function generateReport(args: GenerateReportArgs) {
  const employeeWhere =
    args.scope === "EMPLOYEE" && args.scopeId
      ? { id: args.scopeId }
      : args.scope === "DEPARTMENT" && args.scopeId
      ? { companyId: args.companyId, departmentId: args.scopeId }
      : { companyId: args.companyId };

  const employees = await prisma.employee.findMany({
    where: employeeWhere,
    select: { id: true, firstName: true, lastName: true, email: true, department: { select: { name: true } } },
  });

  const rows: Record<string, string | number>[] = [];
  for (const employee of employees) {
    const dailyRows = await prisma.dailyAnalytics.findMany({
      where: { employeeId: employee.id, date: { gte: args.periodStart, lte: args.periodEnd } },
    });
    const summary = summarizeRows(dailyRows);
    rows.push({
      employee: `${employee.firstName} ${employee.lastName}`,
      email: employee.email,
      department: employee.department?.name ?? "",
      emailsReceived: summary.emailsReceived,
      emailsReplied: summary.emailsReplied,
      responseRatePct: summary.responseRate,
      avgReplyTimeMin: summary.avgReplyTimeMin,
      productivityScore: summary.productivityScore,
    });
  }

  const csv = toCsv(rows);

  // Report row is created first so its own id can double as the on-disk
  // filename — the schema has no separate "fileName" column, only fileUrl,
  // so the download route (GET /api/reports/:id/download) needs to be able
  // to derive the file location from :id alone.
  const report = await prisma.report.create({
    data: {
      companyId: args.companyId,
      scope: args.scope,
      scopeId: args.scopeId ?? null,
      period: args.period,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      fileUrl: null,
    },
  });

  await writeReport(report.id, csv);

  const finalized = await prisma.report.update({
    where: { id: report.id },
    data: { fileUrl: `/api/reports/${report.id}/download` },
  });

  return { report: finalized, fileName: `${report.id}.csv` };
}

function periodRange(period: "DAILY" | "WEEKLY" | "MONTHLY", end: Date): { start: Date; end: Date } {
  const days = period === "DAILY" ? 1 : period === "WEEKLY" ? 7 : 30;
  return { start: new Date(end.getTime() - days * 24 * 60 * 60 * 1000), end };
}

/** Used by the scheduler for automatic weekly company-wide reports (Phase 8's "scheduled report generation"). */
export async function generateScheduledCompanyReports(period: "DAILY" | "WEEKLY" | "MONTHLY" = "WEEKLY") {
  const companies = await prisma.company.findMany({ select: { id: true } });
  const end = new Date();
  const { start } = periodRange(period, end);

  let generated = 0;
  for (const company of companies) {
    try {
      await generateReport({
        companyId: company.id,
        scope: "COMPANY",
        scopeId: null,
        period,
        periodStart: start,
        periodEnd: end,
      });
      generated++;
    } catch (e) {
      console.error(`[Reports] Scheduled report failed for company ${company.id}:`, e);
    }
  }
  return { generated, total: companies.length };
}
