import cron from "node-cron";
import { runDailyAnalyticsRollup } from "./services/analyticsEngine";
import { runNotificationRules } from "./services/notificationEngine";
import { generateScheduledCompanyReports } from "./services/reportEngine";
import { purgeOldEmails, getRetentionDays } from "./services/retentionEngine";

/**
 * Registers all scheduled jobs. Called once from server.ts at startup.
 * Times are UTC (node-cron uses the server's local time zone by default;
 * set TZ=UTC in the deploy environment, or pass `{ timezone: "UTC" }` to
 * each job below, to make these times unambiguous across regions).
 */
export function startScheduler() {
  // 00:05 daily — after midnight UTC, so "today" has fully rolled over
  // before computing yesterday's DailyAnalytics rows.
  cron.schedule("5 0 * * *", async () => {
    console.log("[Scheduler] Running daily analytics rollup...");
    try {
      const result = await runDailyAnalyticsRollup();
      console.log(`[Scheduler] Analytics rollup: ${result.processed}/${result.total} employees processed`);
    } catch (e) {
      console.error("[Scheduler] Analytics rollup failed:", e);
    }
  });

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

  // 00:20 daily — purge emails older than EMAIL_RETENTION_DAYS (default 30)
  // so the database doesn't fill up and block new mail syncs. Runs after the
  // 00:05 analytics rollup so nothing is deleted before it's been counted.
  // Set EMAIL_RETENTION_DAYS=0 to disable.
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
