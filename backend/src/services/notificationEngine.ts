import { prisma } from "../lib/db";
import { emitToCompany } from "../sockets";

interface NotificationRules {
  employeeInactivityDays?: number;
  pendingOverflowThreshold?: number;
}

const DEFAULT_RULES: Required<NotificationRules> = {
  employeeInactivityDays: 3,
  pendingOverflowThreshold: 15,
};

async function getRules(companyId: string): Promise<Required<NotificationRules>> {
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  const configured = (settings?.notificationRules as NotificationRules | null) ?? {};
  return { ...DEFAULT_RULES, ...configured };
}

/**
 * Creates a Notification unless an identical one (same company, type,
 * message) was already created in the dedupe window — Notification has no
 * per-target foreign key to key off, so the message text itself (which
 * always names the employee/department) is what we compare. Without this, a
 * hardly-changing condition like "productivity below threshold" would create
 * a fresh notification on every scheduler tick.
 */
async function createIfNotDuplicate(opts: {
  companyId: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
  dedupeWindowHours?: number;
}) {
  const windowStart = new Date(Date.now() - (opts.dedupeWindowHours ?? 24) * 60 * 60 * 1000);
  const existing = await prisma.notification.findFirst({
    where: {
      companyId: opts.companyId,
      type: opts.type,
      message: opts.message,
      createdAt: { gte: windowStart },
    },
  });
  if (existing) return null;

  const notification = await prisma.notification.create({
    data: { companyId: opts.companyId, type: opts.type, severity: opts.severity, message: opts.message },
  });
  emitToCompany(opts.companyId, "notification:new", notification);
  return notification;
}

/** Employees who haven't come back online in `employeeInactivityDays` — a proxy for "may have gone quiet," not a disciplinary signal by itself. */
async function checkEmployeeInactivity(companyId: string, rules: Required<NotificationRules>) {
  const cutoff = new Date(Date.now() - rules.employeeInactivityDays * 24 * 60 * 60 * 1000);
  const inactive = await prisma.employee.findMany({
    where: {
      companyId,
      status: { not: "SUSPENDED" },
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: cutoff } }],
      gmailAccount: { isNot: null }, // only flag employees actually expected to be working the inbox
    },
    select: { id: true, firstName: true, lastName: true },
  });

  for (const employee of inactive) {
    await createIfNotDuplicate({
      companyId,
      type: "EMPLOYEE_INACTIVE",
      severity: "WARNING",
      message: `${employee.firstName} ${employee.lastName} hasn't been active in over ${rules.employeeInactivityDays} day(s).`,
      dedupeWindowHours: 24,
    });
  }
}

/** Employees sitting on more unreplied emails than the configured threshold. */
async function checkPendingOverflow(companyId: string, rules: Required<NotificationRules>) {
  const accounts = await prisma.gmailAccount.findMany({
    where: { companyId, status: "CONNECTED" },
    select: { id: true, employeeId: true },
  });

  for (const account of accounts) {
    const pending = await prisma.email.count({ where: { gmailAccountId: account.id, isReplied: false } });
    if (pending <= rules.pendingOverflowThreshold) continue;

    const employee = await prisma.employee.findUnique({
      where: { id: account.employeeId },
      select: { firstName: true, lastName: true },
    });
    if (!employee) continue;

    await createIfNotDuplicate({
      companyId,
      type: "PENDING_OVERFLOW",
      severity: "WARNING",
      message: `${employee.firstName} ${employee.lastName} has ${pending} unreplied emails, above the ${rules.pendingOverflowThreshold}-email threshold.`,
      dedupeWindowHours: 24,
    });
  }
}

/** Employees whose most recent productivity score is below the company's configured threshold. */
async function checkLowProductivity(companyId: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  const threshold = settings?.performanceThreshold ?? 70;

  const employees = await prisma.employee.findMany({
    where: { companyId, status: { not: "SUSPENDED" } },
    select: { id: true, firstName: true, lastName: true },
  });

  for (const employee of employees) {
    const latest = await prisma.dailyAnalytics.findFirst({
      where: { employeeId: employee.id },
      orderBy: { date: "desc" },
    });
    if (!latest || latest.productivityScore === null) continue;
    if (latest.productivityScore >= threshold) continue;

    await createIfNotDuplicate({
      companyId,
      type: "LOW_PRODUCTIVITY",
      severity: "INFO",
      message: `${employee.firstName} ${employee.lastName}'s productivity score (${Math.round(
        latest.productivityScore
      )}) is below the company threshold (${threshold}).`,
      dedupeWindowHours: 24,
    });
  }
}

/**
 * Runs every rule for one company (or every company, if none is given).
 * Intended to be called on a schedule (see scheduler.ts) and also exposed as
 * a manual "check now" endpoint for Admin+, same pattern as the analytics
 * rollup's escape hatch.
 */
export async function runNotificationRules(companyId?: string) {
  const companies = companyId
    ? [{ id: companyId }]
    : await prisma.company.findMany({ select: { id: true } });

  let checked = 0;
  for (const company of companies) {
    try {
      const rules = await getRules(company.id);
      await checkEmployeeInactivity(company.id, rules);
      await checkPendingOverflow(company.id, rules);
      await checkLowProductivity(company.id);
      checked++;
    } catch (e) {
      console.error(`[Notifications] Rule check failed for company ${company.id}:`, e);
    }
  }
  return { companiesChecked: checked, total: companies.length };
}
