import { prisma } from "../lib/db";

// Narrow structural shapes for the fields this file actually reads off
// DailyAnalytics/Employee rows. These mirror the Prisma schema and let us
// keep noImplicitAny-clean callbacks even when the generated Prisma client
// isn't available in this environment; once `prisma generate` runs for
// real, these remain valid (structural) subtypes of the generated types.
interface DailyAnalyticsRow {
  employeeId: string;
  emailsReceived: number;
  emailsReplied: number;
  avgReplyTimeSec: number | null;
  productivityScore: number | null;
  aiReplies: number;
  manualReplies: number;
}
interface EmployeeIdRow {
  id: string;
}

function todayRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Company-wide live overview for the Admin Dashboard's top cards. */
export async function getCompanyOverview(companyId: string) {
  const { start, end } = todayRange();

  const [
    totalEmployees,
    onlineEmployees,
    connectedGmailAccounts,
    emailsToday,
    unreadEmails,
    pendingReplies,
    aiActionsToday,
    todaysAnalytics,
  ] = await Promise.all([
    prisma.employee.count({ where: { companyId } }),
    prisma.employee.count({ where: { companyId, status: "ONLINE" } }),
    prisma.gmailAccount.count({ where: { companyId, status: "CONNECTED" } }),
    prisma.email.count({
      where: { gmailAccount: { companyId }, receivedAt: { gte: start, lt: end } },
    }),
    prisma.email.count({
      where: { gmailAccount: { companyId }, receivedAt: { gte: start, lt: end }, isRead: false },
    }),
    prisma.email.count({
      where: { gmailAccount: { companyId }, receivedAt: { gte: start, lt: end }, isReplied: false },
    }),
    prisma.aIAction.count({
      where: { employee: { companyId }, createdAt: { gte: start, lt: end } },
    }),
    prisma.dailyAnalytics.findMany({
      where: {
        employeeId: {
          in: ((await prisma.employee.findMany({ where: { companyId }, select: { id: true } })) as EmployeeIdRow[]).map(
            (e: EmployeeIdRow) => e.id,
          ),
        },
        date: start,
      },
      select: { avgReplyTimeSec: true },
    }) as Promise<{ avgReplyTimeSec: number | null }[]>,
  ]);

  const replyTimes = todaysAnalytics
    .map((a: { avgReplyTimeSec: number | null }) => a.avgReplyTimeSec)
    .filter((v: number | null): v is number => v !== null);
  const avgResponseTimeSec =
    replyTimes.length > 0
      ? Math.round(replyTimes.reduce((s: number, v: number) => s + v, 0) / replyTimes.length)
      : null;

  return {
    totalEmployees,
    employeesOnline: onlineEmployees,
    employeesOffline: totalEmployees - onlineEmployees,
    connectedGmailAccounts,
    emailsToday,
    unreadEmails,
    pendingReplies,
    avgResponseTimeSec,
    aiActionsToday,
  };
}

/**
 * Department rollup — aggregates each member's DailyAnalytics over a date
 * range. DailyAnalytics has no declared Prisma relation back to Employee (it
 * only carries a plain employeeId column), so department scoping is a
 * two-step lookup — resolve the department's employee ids first, then filter
 * DailyAnalytics by `employeeId: { in: ... } }` — rather than the `where: {
 * employee: { departmentId } }` shape you'd reach for if the relation did
 * exist. Flagging this because it's an easy one-liner to get wrong.
 */
export async function getDepartmentAnalytics(departmentId: string, start: Date, end: Date) {
  const memberIds = (
    (await prisma.employee.findMany({ where: { departmentId }, select: { id: true } })) as EmployeeIdRow[]
  ).map((e: EmployeeIdRow) => e.id);

  const rows: DailyAnalyticsRow[] = memberIds.length
    ? await prisma.dailyAnalytics.findMany({
        where: { employeeId: { in: memberIds }, date: { gte: start, lte: end } },
      })
    : [];

  const emailsReceived = rows.reduce((s, r) => s + r.emailsReceived, 0);
  const emailsReplied = rows.reduce((s, r) => s + r.emailsReplied, 0);
  const replyTimes = rows.map((r) => r.avgReplyTimeSec).filter((v): v is number => v !== null);
  const scores = rows.map((r) => r.productivityScore).filter((v): v is number => v !== null);
  const aiRows = rows.map((r) => r.aiReplies).reduce((s, v) => s + v, 0);
  const manualRows = rows.map((r) => r.manualReplies).reduce((s, v) => s + v, 0);

  return {
    emailsReceived,
    emailsReplied,
    pendingEmails: emailsReceived - emailsReplied,
    avgReplyTimeSec: replyTimes.length ? Math.round(replyTimes.reduce((s, v) => s + v, 0) / replyTimes.length) : null,
    performanceScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    aiUsageRatio: aiRows + manualRows > 0 ? aiRows / (aiRows + manualRows) : null,
  };
}

/** Single employee's analytics over a date range, for their own profile page or a manager/admin's view of them. */
export async function getEmployeeAnalytics(employeeId: string, start: Date, end: Date) {
  const rows = await prisma.dailyAnalytics.findMany({
    where: { employeeId, date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });
  return rows;
}

function rangeStart(range: "daily" | "weekly" | "monthly"): Date {
  const now = new Date();
  if (range === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === "monthly") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // weekly (default)
}

/**
 * Top performers company-wide by average productivity score over the chosen
 * window. Replaces the old admin backend's `analytics.groupBy` leaderboard —
 * same idea, rebuilt against DailyAnalytics/Employee instead of the old
 * single-table `analytics` model, and with response rate computed here
 * server-side (sum emailsReplied / sum emailsReceived) since the new schema
 * doesn't store a precomputed responseRate column the way the old one did.
 */
export async function getLeaderboard(companyId: string, range: "daily" | "weekly" | "monthly", limit = 10) {
  const start = rangeStart(range);

  interface LeaderboardEmployeeRow {
    id: string;
    firstName: string;
    lastName: string;
    department: { name: string } | null;
  }

  const companyEmployees = (await prisma.employee.findMany({
    where: { companyId },
    select: { id: true, firstName: true, lastName: true, department: { select: { name: true } } },
  })) as LeaderboardEmployeeRow[];
  if (companyEmployees.length === 0) return [];
  const employeeIds = companyEmployees.map((e) => e.id);

  const rows: DailyAnalyticsRow[] = await prisma.dailyAnalytics.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: start } },
  });

  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byEmployee.get(row.employeeId) ?? [];
    bucket.push(row);
    byEmployee.set(row.employeeId, bucket);
  }

  const employeeById = new Map(companyEmployees.map((e) => [e.id, e]));

  const leaderboard = Array.from(byEmployee.entries()).map(([employeeId, employeeRows]) => {
    const scores = employeeRows.map((r) => r.productivityScore).filter((v): v is number => v !== null);
    const replyTimes = employeeRows.map((r) => r.avgReplyTimeSec).filter((v): v is number => v !== null);
    const emailsReceived = employeeRows.reduce((s, r) => s + r.emailsReceived, 0);
    const emailsReplied = employeeRows.reduce((s, r) => s + r.emailsReplied, 0);

    return {
      employeeId,
      employee: employeeById.get(employeeId),
      avgProductivityScore: scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null,
      avgReplyTimeSec: replyTimes.length ? Math.round(replyTimes.reduce((s, v) => s + v, 0) / replyTimes.length) : null,
      responseRate: emailsReceived > 0 ? emailsReplied / emailsReceived : null,
      emailsReplied,
    };
  });

  leaderboard.sort((a, b) => (b.avgProductivityScore ?? -1) - (a.avgProductivityScore ?? -1));
  return leaderboard.slice(0, limit);
}
