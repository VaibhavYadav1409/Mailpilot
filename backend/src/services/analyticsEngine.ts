import { prisma } from "../lib/db";

function dayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// Benchmark for the "speed" component of the productivity score: a reply
// within this many seconds scores 100 on that component, scaling down
// linearly to 0 at 4x the benchmark. This is a starting default, not a
// scientific constant — whoever owns this product should tune it (or make it
// per-company via CompanySettings) once real reply-time data exists to
// calibrate against.
const REPLY_TIME_BENCHMARK_SEC = 4 * 60 * 60; // 4 hours

/**
 * Productivity score (0-100) is a weighted blend of three components. The
 * weights below are a reasonable starting point, not a validated formula —
 * flagging this explicitly because this number will likely be shown to
 * managers as a judgment of employee performance, so it should be treated as
 * adjustable and disclosed to employees, not a black box.
 *
 *   50% reply rate      — emailsReplied / emailsReceived
 *   30% reply speed      — avgReplyTimeSec vs REPLY_TIME_BENCHMARK_SEC
 *   20% AI collaboration  — AI suggestion acceptance rate (proxy for
 *                           engagement with the tool, not raw output volume)
 */
function computeProductivityScore(opts: {
  emailsReceived: number;
  emailsReplied: number;
  avgReplyTimeSec: number | null;
  aiAcceptanceRate: number | null;
}): number {
  const replyRateComponent =
    opts.emailsReceived === 0 ? 100 : Math.min(100, (opts.emailsReplied / opts.emailsReceived) * 100);

  const speedComponent =
    opts.avgReplyTimeSec === null
      ? 100 // no replies yet today — don't penalize before there's data
      : Math.max(0, 100 - (opts.avgReplyTimeSec / (REPLY_TIME_BENCHMARK_SEC * 4)) * 100);

  const aiComponent = opts.aiAcceptanceRate === null ? 50 : opts.aiAcceptanceRate * 100;

  return Math.round(replyRateComponent * 0.5 + speedComponent * 0.3 + aiComponent * 0.2);
}

/** Computes and upserts one employee's DailyAnalytics row for a given date. */
export async function computeEmployeeDailyAnalytics(employeeId: string, date: Date) {
  const { start, end } = dayRange(date);

  const gmailAccount = await prisma.gmailAccount.findUnique({ where: { employeeId } });
  if (!gmailAccount) return null;

  const [emailsReceived, emailsRead, emailsReplied, replies, aiSuggestions] = await Promise.all([
    prisma.email.count({
      where: { gmailAccountId: gmailAccount.id, receivedAt: { gte: start, lt: end } },
    }),
    prisma.email.count({
      where: { gmailAccountId: gmailAccount.id, receivedAt: { gte: start, lt: end }, isRead: true },
    }),
    prisma.email.count({
      where: { gmailAccountId: gmailAccount.id, receivedAt: { gte: start, lt: end }, isReplied: true },
    }),
    prisma.reply.findMany({
      where: { employeeId, sentAt: { gte: start, lt: end } },
      select: { replyTimeSec: true, wasAIDraft: true },
    }) as Promise<{ replyTimeSec: number; wasAIDraft: boolean }[]>,
    prisma.aIAction.findMany({
      where: {
        employeeId,
        actionType: "SUGGEST_REPLY",
        accepted: { not: null },
        createdAt: { gte: start, lt: end },
      },
      select: { accepted: true },
    }) as Promise<{ accepted: boolean | null }[]>,
  ]);

  const manualReplies = replies.filter((r: { wasAIDraft: boolean }) => !r.wasAIDraft).length;
  const aiReplies = replies.filter((r: { wasAIDraft: boolean }) => r.wasAIDraft).length;
  const avgReplyTimeSec =
    replies.length > 0
      ? Math.round(
          replies.reduce((sum: number, r: { replyTimeSec: number }) => sum + r.replyTimeSec, 0) / replies.length,
        )
      : null;
  const aiAcceptanceRate =
    aiSuggestions.length > 0
      ? aiSuggestions.filter((a: { accepted: boolean | null }) => a.accepted).length / aiSuggestions.length
      : null;

  const productivityScore = computeProductivityScore({
    emailsReceived,
    emailsReplied,
    avgReplyTimeSec,
    aiAcceptanceRate,
  });

  return prisma.dailyAnalytics.upsert({
    where: { employeeId_date: { employeeId, date: start } },
    create: {
      employeeId,
      date: start,
      emailsReceived,
      emailsRead,
      emailsReplied,
      avgReplyTimeSec,
      manualReplies,
      aiReplies,
      aiAcceptanceRate,
      productivityScore,
    },
    update: {
      emailsReceived,
      emailsRead,
      emailsReplied,
      avgReplyTimeSec,
      manualReplies,
      aiReplies,
      aiAcceptanceRate,
      productivityScore,
    },
  });
}

/**
 * Runs the rollup for every employee with a connected Gmail account, for a
 * given date (defaults to today). Intended to be invoked by a scheduled job
 * (cron / a queue worker) — see docs/ARCHITECTURE.md for the note on wiring
 * this into an actual scheduler; Phase 5 provides the computation, not the
 * scheduler infrastructure itself.
 */
export async function runDailyAnalyticsRollup(date: Date = new Date()) {
  const accounts = await prisma.gmailAccount.findMany({
    where: { status: "CONNECTED" },
    select: { employeeId: true },
  });

  let processed = 0;
  for (const { employeeId } of accounts) {
    try {
      await computeEmployeeDailyAnalytics(employeeId, date);
      processed++;
    } catch (e) {
      console.error(`[Analytics] Failed to roll up employee ${employeeId}:`, e);
    }
  }
  return { processed, total: accounts.length };
}
