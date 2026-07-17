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
    repliesToday,
    unreadEmails,
    pendingReplies,
    aiActionsToday,
    todaysAnalytics,
  ] = await Promise.all([
    prisma.employee.count({ where: { companyId } }),
    prisma.employee.count({ where: { companyId, status: "ONLINE" } }),
    prisma.gmailAccount.count({ where: { companyId, status: "CONNECTED", isActive: true } }),
    prisma.email.count({
      where: { gmailAccount: { companyId }, receivedAt: { gte: start, lt: end } },
    }),
    // Total replies today — counted by when the reply itself landed
    // (repliedAt, set by recordReply from either a sync-detected reply or a
    // MailPilot-sent one), not by when the original email arrived. An email
    // received yesterday and replied today counts toward today's replies,
    // same convention emailsToday uses the other direction for received.
    prisma.email.count({
      where: { gmailAccount: { companyId }, isReplied: true, repliedAt: { gte: start, lt: end } },
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
    repliesToday,
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

function daysInRange(range: "daily" | "weekly" | "monthly"): number {
  if (range === "daily") return 1;
  if (range === "monthly") return 30;
  return 7;
}

interface TrendPoint {
  date: string; // YYYY-MM-DD (UTC)
  emailsReceived: number;
  emailsReplied: number;
  avgReplyTimeSec: number | null;
  avgProductivityScore: number | null;
}

/**
 * Company-wide day-by-day trend series for the Admin Dashboard's "Daily /
 * Weekly / Monthly trends" chart. Was previously backed by nothing — the
 * dashboard rendered today's point-in-time counts as a flat bar chart and
 * left a comment noting there was no real time-series endpoint. This
 * buckets DailyAnalytics (already populated per-employee per-day by
 * runDailyAnalyticsRollup — see analyticsEngine.ts) by date across every
 * employee in the company, one point per day.
 *
 * Note this is a rollup of *rollups*: DailyAnalytics.avgReplyTimeSec is
 * itself an average of that employee's replies for the day, so
 * avgReplyTimeSec here is an average-of-averages across employees, not a
 * recomputed company-wide mean weighted by reply count. Good enough for a
 * trend line; flagging in case someone later wants the weighted version for
 * a precise metric elsewhere.
 */
export async function getCompanyTrends(companyId: string, range: "daily" | "weekly" | "monthly" = "weekly"): Promise<TrendPoint[]> {
  const days = daysInRange(range);
  const today = new Date();
  const rangeStartDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)));

  const employeeIds = (
    (await prisma.employee.findMany({ where: { companyId }, select: { id: true } })) as EmployeeIdRow[]
  ).map((e: EmployeeIdRow) => e.id);

  const rows: (DailyAnalyticsRow & { date: Date })[] = employeeIds.length
    ? ((await prisma.dailyAnalytics.findMany({
        where: { employeeId: { in: employeeIds }, date: { gte: rangeStartDate } },
        select: {
          date: true,
          emailsReceived: true,
          emailsReplied: true,
          avgReplyTimeSec: true,
          productivityScore: true,
        },
      })) as unknown as (DailyAnalyticsRow & { date: Date })[])
    : [];

  const byDate = new Map<string, (DailyAnalyticsRow & { date: Date })[]>();
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10);
    const bucket = byDate.get(key) ?? [];
    bucket.push(row);
    byDate.set(key, bucket);
  }

  const points: TrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(rangeStartDate.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const dayRows = byDate.get(key) ?? [];

    const emailsReceived = dayRows.reduce((s, r) => s + r.emailsReceived, 0);
    const emailsReplied = dayRows.reduce((s, r) => s + r.emailsReplied, 0);
    const replyTimes = dayRows.map((r) => r.avgReplyTimeSec).filter((v): v is number => v !== null);
    const scores = dayRows.map((r) => r.productivityScore).filter((v): v is number => v !== null);

    points.push({
      date: key,
      emailsReceived,
      emailsReplied,
      avgReplyTimeSec: replyTimes.length ? Math.round(replyTimes.reduce((s, v) => s + v, 0) / replyTimes.length) : null,
      avgProductivityScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    });
  }
  return points;
}

/**
 * Live per-employee snapshot — the counterpart to getCompanyOverview, but
 * scoped to one employee's mailbox instead of the whole company. Unlike
 * getEmployeeAnalytics (which reads the historical DailyAnalytics rollup),
 * this reads Email/GmailAccount directly so "active vs. closed
 * conversations," "last sync," and "last reply time" are always live —
 * DailyAnalytics only has a `date` granularity and doesn't carry
 * firstResponseAt/lastReplyAt at all.
 *
 * "Pending" and "unanswered" are the same underlying count (not-yet-replied
 * emails) under the two labels the spec uses interchangeably — there's no
 * behavioral difference implied anywhere else in the spec, so rather than
 * invent a second, arbitrary definition (e.g. "unanswered" = pending past
 * some age threshold) this keeps them as one number under two keys. If a
 * distinct SLA-breach definition is wanted later, pendingDurationSec
 * (Email — see replyTracking.ts) is exactly what to threshold on.
 */
export async function getEmployeeOverview(employeeId: string) {
  const { start: todayStart, end: todayEnd } = todayRange();
  const now = new Date();
  const weekStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

  const account = await prisma.gmailAccount.findFirst({
    where: { employeeId, isActive: true },
    select: { id: true, lastSyncedAt: true, provider: true, status: true },
  });
  if (!account) return null;

  const [
    emailsReceivedToday,
    emailsRepliedToday,
    emailsReceivedThisWeek,
    emailsRepliedThisWeek,
    pendingEmails,
    unreadEmails,
    readEmails,
    activeConversations,
    closedConversations,
    replyStats,
  ] = await Promise.all([
    prisma.email.count({ where: { gmailAccountId: account.id, receivedAt: { gte: todayStart, lt: todayEnd } } }),
    prisma.email.count({ where: { gmailAccountId: account.id, isReplied: true, repliedAt: { gte: todayStart, lt: todayEnd } } }),
    prisma.email.count({ where: { gmailAccountId: account.id, receivedAt: { gte: weekStart } } }),
    prisma.email.count({ where: { gmailAccountId: account.id, isReplied: true, repliedAt: { gte: weekStart } } }),
    prisma.email.count({ where: { gmailAccountId: account.id, isReplied: false } }),
    prisma.email.count({ where: { gmailAccountId: account.id, isRead: false } }),
    prisma.email.count({ where: { gmailAccountId: account.id, isRead: true } }),
    // "Conversation" = thread. Distinct threadIds among not-yet-replied vs.
    // replied emails — an email with no threadId (manual/pasted, or a
    // provider that never set one) counts as its own single-message thread
    // via its own id, so it isn't silently dropped from either count.
    prisma.email.findMany({
      where: { gmailAccountId: account.id, isReplied: false },
      select: { id: true, threadId: true },
    }),
    prisma.email.findMany({
      where: { gmailAccountId: account.id, isReplied: true },
      select: { id: true, threadId: true },
    }),
    prisma.email.aggregate({
      where: { gmailAccountId: account.id, isReplied: true, replyTimeSec: { not: null } },
      _avg: { replyTimeSec: true },
    }),
  ]);

  const activeThreadIds = new Set(activeConversations.map((e) => e.threadId ?? e.id));
  const closedThreadIds = new Set(closedConversations.map((e) => e.threadId ?? e.id));

  const lastReply = await prisma.email.findFirst({
    where: { gmailAccountId: account.id, lastReplyAt: { not: null } },
    orderBy: { lastReplyAt: "desc" },
    select: { lastReplyAt: true },
  });

  // avgReplyTimeSec and firstResponseTimeSec are the same number today:
  // Email.replyTimeSec is defined (see recordReply in replyTracking.ts) as
  // firstResponseAt - receivedAt, i.e. it *is* first-response time, not a
  // running average across every reply in a thread. Not duplicating the
  // query under a second label to avoid implying they're independently
  // measured — if "average reply time across all replies in a thread"
  // becomes a distinct requirement later, that needs its own column (the
  // Reply model, not Email, would be the source for it).
  const avgReplyTimeSec = replyStats._avg.replyTimeSec !== null ? Math.round(replyStats._avg.replyTimeSec) : null;

  return {
    lastSync: account.lastSyncedAt,
    provider: account.provider,
    emailsReceivedToday,
    emailsRepliedToday,
    emailsReceivedThisWeek,
    emailsRepliedThisWeek,
    pendingEmails,
    unansweredEmails: pendingEmails,
    unreadEmails,
    readEmails,
    activeConversations: activeThreadIds.size,
    closedConversations: closedThreadIds.size,
    avgReplyTimeSec,
    firstResponseTimeSec: avgReplyTimeSec,
    lastReplyAt: lastReply?.lastReplyAt ?? null,
  };
}

/**
 * Subject/sender/date list of an employee's pending or replied emails, for
 * the admin dashboard's expanded row view. Deliberately excludes
 * bodyText/snippet — the rest of this file only ever exposes aggregated
 * counts/timings to admins/managers (see the ownership comment in
 * routes/emails.ts: raw inbox content is employee-only). This is a
 * narrow, explicit exception that surfaces just enough to identify *which*
 * email is pending/replied, not what it says.
 */
export async function getEmployeeEmailList(
  employeeId: string,
  status: "pending" | "replied",
  limit = 20,
  cursor?: string
) {
  const account = await prisma.gmailAccount.findFirst({
    where: { employeeId, isActive: true },
    select: { id: true },
  });
  if (!account) return null;

  const emails = await prisma.email.findMany({
    where: { gmailAccountId: account.id, isTrashed: false, isReplied: status === "replied" },
    orderBy: status === "replied" ? { repliedAt: "desc" } : { receivedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      fromName: true,
      receivedAt: true,
      repliedAt: true,
      pendingDurationSec: true,
    },
  });

  const nextCursor = emails.length > limit ? emails[limit].id : null;
  return { emails: emails.slice(0, limit), nextCursor };
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
