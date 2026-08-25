import cron from "node-cron";
import { prisma } from "./lib/db";
import { syncEmployeeInbox } from "./services/emailSync";
import { runDailyAnalyticsRollup } from "./services/analyticsEngine";
import { runNotificationRules } from "./services/notificationEngine";
import { generateScheduledCompanyReports } from "./services/reportEngine";
import {
  purgeOldEmails,
  getRetentionDays,
  purgeEmailsBeforeToday,
  isDailyMailMode,
  getMailDayTimezone,
} from "./services/retentionEngine";

/**
 * Registers all scheduled jobs. Called once from server.ts at startup.
 * Times are UTC (node-cron uses the server's local time zone by default;
 * set TZ=UTC in the deploy environment, or pass `{ timezone: "UTC" }` to
 * each job below, to make these times unambiguous across regions).
 */
// How often the server syncs every connected mailbox on its own, with no
// client involved. 0 disables it. Kept modest by default: each run touches
// every account, and this instance has a 256MB heap.
const BACKGROUND_SYNC_MINUTES = Math.max(0, Number(process.env.BACKGROUND_SYNC_MINUTES) || 5);

// Guards against overlapping runs. A sync that takes longer than the interval
// would otherwise start again on top of itself and multiply peak memory —
// the exact condition that gets the process OOM-killed.
let backgroundSyncRunning = false;

/**
 * Syncs every active, connected mailbox. Accounts are processed one at a time
 * on purpose: syncing in parallel multiplies peak memory (each sync holds
 * message bodies and attachment buffers), and on a 256MB heap that's what
 * causes the SIGTERM restarts. Slower and alive beats faster and dead.
 */
async function runBackgroundSync(): Promise<void> {
  if (backgroundSyncRunning) {
    console.log("[BackgroundSync] Previous run still in progress, skipping this tick.");
    return;
  }
  backgroundSyncRunning = true;
  const startedAt = Date.now();

  try {
    const accounts = await prisma.gmailAccount.findMany({
      where: { isActive: true, status: "CONNECTED", provider: { not: "MANUAL" } },
      select: { employeeId: true, emailAddress: true },
    });

    if (accounts.length === 0) return;

    let totalSynced = 0;
    let failed = 0;
    for (const account of accounts) {
      try {
        const { synced } = await syncEmployeeInbox(account.employeeId);
        totalSynced += synced;
      } catch (e) {
        // One broken mailbox (revoked token, provider outage) must not stop
        // the rest from syncing.
        failed++;
        console.error(`[BackgroundSync] Failed for ${account.emailAddress}:`, e instanceof Error ? e.message : e);
      }
    }

    const secs = Math.round((Date.now() - startedAt) / 1000);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(
      `[BackgroundSync] ${accounts.length} account(s), ${totalSynced} new email(s), ${failed} failed, ${secs}s, rss=${rssMb}MB`
    );
  } catch (e) {
    console.error("[BackgroundSync] Run failed:", e);
  } finally {
    backgroundSyncRunning = false;
  }
}

// Keep-awake pinger.
//
// Render's free tier spins a service down after ~15 minutes with no INBOUND
// HTTP traffic. Internal cron ticks don't count as traffic, so a background
// sync alone won't keep the instance alive — it would sleep and stop syncing
// the moment nobody had the app open, which is the exact thing this is
// meant to prevent. Requesting our own public URL is real inbound traffic
// and resets that idle timer.
//
// RENDER_EXTERNAL_URL is injected by Render automatically; KEEP_AWAKE_URL
// overrides it if you host elsewhere. Set KEEP_AWAKE=false to turn this off
// (e.g. on a paid instance, where it's unnecessary).
const KEEP_AWAKE_MINUTES = Math.max(1, Number(process.env.KEEP_AWAKE_MINUTES) || 10);

function keepAwakeUrl(): string | null {
  if ((process.env.KEEP_AWAKE ?? "true").toLowerCase() === "false") return null;
  const base = process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/health`;
}

async function pingSelf(url: string): Promise<void> {
  try {
    // Short timeout: this is a liveness nudge, not something worth holding
    // a socket open for.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) console.warn(`[KeepAwake] Ping returned ${res.status}`);
  } catch (e) {
    // A failed ping is not fatal — the next tick tries again.
    console.warn("[KeepAwake] Ping failed:", e instanceof Error ? e.message : e);
  }
}

export function startScheduler() {
  // 00:05 daily — just after midnight UTC. We roll up YESTERDAY, the day that
  // just fully completed. Passing no date defaulted to `new Date()` (today),
  // which at 00:05 has ~5 minutes of data — so every day's DailyAnalytics row
  // was written near-empty and never recomputed, silently zeroing out every
  // admin history chart (trends, leaderboard, department performance) that
  // reads DailyAnalytics. Compute the completed day instead.
  cron.schedule(
    "5 0 * * *",
    async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      console.log(`[Scheduler] Running daily analytics rollup for ${yesterday.toISOString().slice(0, 10)}...`);
      try {
        const result = await runDailyAnalyticsRollup(yesterday);
        console.log(`[Scheduler] Analytics rollup: ${result.processed}/${result.total} employees processed`);
      } catch (e) {
        console.error("[Scheduler] Analytics rollup failed:", e);
      }
    },
    { timezone: "UTC" },
  );

  // Keep the instance awake so the background sync below actually gets to
  // run. Registered first: if the service is asleep, nothing else matters.
  const awakeUrl = keepAwakeUrl();
  if (awakeUrl) {
    cron.schedule(`*/${KEEP_AWAKE_MINUTES} * * * *`, () => void pingSelf(awakeUrl));
    console.log(`[Scheduler] Keep-awake ping every ${KEEP_AWAKE_MINUTES} min -> ${awakeUrl}`);
  } else {
    console.log("[Scheduler] Keep-awake disabled (set KEEP_AWAKE_URL or RENDER_EXTERNAL_URL to enable)");
  }

  // Server-side mail sync, independent of any client. Without this, mail only
  // syncs while someone has the app open and polling /api/emails/sync — so
  // closing the app stopped the sync entirely.
  if (BACKGROUND_SYNC_MINUTES > 0) {
    cron.schedule(`*/${BACKGROUND_SYNC_MINUTES} * * * *`, runBackgroundSync);
    console.log(`[Scheduler] Background mail sync every ${BACKGROUND_SYNC_MINUTES} minute(s)`);
    // Kick one off shortly after boot so a restart doesn't leave mailboxes
    // stale until the next tick. Delayed so it doesn't compete with startup.
    setTimeout(() => void runBackgroundSync(), 30_000);
  } else {
    console.log("[Scheduler] Background mail sync disabled (BACKGROUND_SYNC_MINUTES=0)");
  }

  // Every hour, on the hour — notification rules are cheap checks against
  // already-computed data, so hourly is frequent enough to catch things
  // without hammering the DB.
  cron.schedule("0 * * * *", async () => {
    console.log("[Scheduler] Running notification rules...");
    try {
      const result = await runNotificationRules();
      console.log(`[Scheduler] Notification rules: ${result.companiesChecked}/${result.total} companies checked`);
    } catch (e) {
      console.error("[Scheduler] Notification rules failed:", e);
    }
  });

  if (isDailyMailMode()) {
    // Daily mail mode: the app holds only the current day's mail. At 00:20
    // local time (MAIL_DAY_TIMEZONE) the day that just ended is wiped, so the
    // Email table never accumulates — this is what keeps the 512MB instance
    // from being OOM-killed and Neon from filling up.
    //
    // 00:20 rather than 00:00 so it lands after the 00:05 analytics rollup:
    // DailyAnalytics is pre-aggregated, so yesterday's numbers are already
    // recorded before the raw emails behind them are deleted.
    const tz = getMailDayTimezone();
    cron.schedule(
      "20 0 * * *",
      async () => {
        console.log(`[Scheduler] Daily mail wipe: deleting everything before today (${tz})...`);
        try {
          const r = await purgeEmailsBeforeToday();
          console.log(
            `[Scheduler] Daily wipe: ${r.emailsDeleted} emails, ${r.attachmentRowsDeleted} attachments ` +
              `(${r.attachmentFilesDeleted} blobs), ${r.repliesDeleted} replies removed; cutoff ${r.cutoff}`,
          );
        } catch (e) {
          console.error("[Scheduler] Daily mail wipe failed:", e);
        }
      },
      { timezone: tz },
    );
  } else {
    // Legacy N-day retention (DAILY_MAIL_MODE=false).
    cron.schedule(
      "20 0 * * *",
      async () => {
        const days = getRetentionDays();
        if (days <= 0) {
          console.log("[Scheduler] Email retention disabled (EMAIL_RETENTION_DAYS<=0), skipping purge.");
          return;
        }
        console.log(`[Scheduler] Purging emails older than ${days} days...`);
        try {
          const r = await purgeOldEmails(days);
          console.log(
            `[Scheduler] Retention purge: ${r.emailsDeleted} emails, ${r.attachmentRowsDeleted} attachments ` +
              `(${r.attachmentFilesDeleted} blobs), ${r.repliesDeleted} replies removed; cutoff ${r.cutoff}`,
          );
        } catch (e) {
          console.error("[Scheduler] Retention purge failed:", e);
        }
      },
      { timezone: "UTC" },
    );
  }

  // Monday 00:10 UTC — one company-wide WEEKLY report per company,
  // automatically, satisfying Phase 8's "scheduled report generation."
  // Runs after the daily rollup so Monday's report includes Sunday's data.
  cron.schedule("10 0 * * 1", async () => {
    console.log("[Scheduler] Generating scheduled weekly reports...");
    try {
      const result = await generateScheduledCompanyReports("WEEKLY");
      console.log(`[Scheduler] Weekly reports: ${result.generated}/${result.total} companies`);
    } catch (e) {
      console.error("[Scheduler] Weekly report generation failed:", e);
    }
  });

  console.log(
    `[Scheduler] Cron jobs registered: daily rollup (00:05), notification rules (hourly), ` +
      `email retention purge (00:20, ${getRetentionDays()}d), weekly reports (Mon 00:10)`,
  );
}
