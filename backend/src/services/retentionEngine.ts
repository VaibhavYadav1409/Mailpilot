import { prisma } from "../lib/db";
import { deleteAttachment } from "../lib/attachmentStorage";

/**
 * Email retention / auto-purge.
 *
 * Deletes emails (and their attachments, categories, replies) older than a
 * configurable window so the database — Neon's free tier especially — doesn't
 * fill up and block new syncs. Runs on a schedule from scheduler.ts.
 *
 * Window is controlled by EMAIL_RETENTION_DAYS (default 30). Set it to 0 or a
 * negative number to disable purging entirely.
 *
 * What is preserved on purpose:
 *   - Starred emails (isStarred = true) are NEVER purged, regardless of age —
 *     starring is the user's explicit "keep this" signal.
 *   - AIAction rows are kept but detached (emailId set to null) rather than
 *     deleted, so per-employee AI-usage history stays intact for analytics.
 *   - DailyAnalytics is already a pre-aggregated rollup, so deleting the raw
 *     emails/replies behind it does not change historical numbers.
 *
 * FK-safe delete order (schema has no ON DELETE CASCADE): Attachment ->
 * EmailCategory -> Reply -> (detach AIAction) -> Email.
 */

const DEFAULT_RETENTION_DAYS = 30;

export function getRetentionDays(): number {
  const raw = process.env.EMAIL_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETENTION_DAYS;
}

// ---------------------------------------------------------------------------
// Daily mail mode
// ---------------------------------------------------------------------------
// The app only ever holds ONE day of mail: syncs fetch nothing older than the
// start of the current day, and a scheduled job wipes everything before the
// current day once the day rolls over. This keeps the Email table (bodyText /
// bodyHtml are the storage hogs) permanently tiny, which is what stops the
// 512MB Render instance from being OOM-killed mid-sync and keeps Neon's free
// tier from filling up.
//
// "Day" is a calendar day in MAIL_DAY_TIMEZONE, not a rolling 24h window, so
// the wipe lands at local midnight rather than drifting.
const DEFAULT_MAIL_DAY_TIMEZONE = "Asia/Kolkata";

export function getMailDayTimezone(): string {
  return process.env.MAIL_DAY_TIMEZONE || DEFAULT_MAIL_DAY_TIMEZONE;
}

/** Set DAILY_MAIL_MODE=false to fall back to the old N-day retention model. */
export function isDailyMailMode(): boolean {
  return (process.env.DAILY_MAIL_MODE ?? "true").toLowerCase() !== "false";
}

/**
 * How far `date` is offset from UTC in `tz`, in ms. Derived from Intl rather
 * than hardcoded so DST-observing zones stay correct (IST doesn't use DST,
 * but MAIL_DAY_TIMEZONE is configurable).
 */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUTC - date.getTime();
}

/** The instant the current mail-day began, in MAIL_DAY_TIMEZONE. */
export function startOfMailDay(now = new Date()): Date {
  const offset = tzOffsetMs(now, getMailDayTimezone());
  // Shift into "wall clock as if UTC" so the date parts can be read off
  // directly, take midnight there, then shift back to a real instant.
  const wall = new Date(now.getTime() + offset);
  const midnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return new Date(midnightWall - offset);
}

// Hard cap on how many emails are kept per mail account. Anything beyond the
// N most recent (by receivedAt) is deleted — this bounds both memory and Neon
// storage/transfer, and is what stops the sync from ballooning. Starred emails
// are always kept regardless. Override with MAX_EMAILS_PER_ACCOUNT.
const DEFAULT_MAX_EMAILS_PER_ACCOUNT = 75;

export function getMaxEmailsPerAccount(): number {
  const raw = process.env.MAX_EMAILS_PER_ACCOUNT;
  if (raw === undefined || raw === "") return DEFAULT_MAX_EMAILS_PER_ACCOUNT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_EMAILS_PER_ACCOUNT;
}

/**
 * Keeps only the `limit` most recent emails (by receivedAt) for one mail
 * account, deleting the rest along with their attachments, categories, and
 * replies (FK-safe order, same as purgeOldEmails). Starred emails are always
 * kept and don't count against the limit. Safe to run after every sync.
 */
export async function pruneAccountToLimit(
  accountId: string,
  limit = getMaxEmailsPerAccount(),
): Promise<{ emailsDeleted: number; attachmentFilesDeleted: number }> {
  if (!Number.isFinite(limit) || limit <= 0) return { emailsDeleted: 0, attachmentFilesDeleted: 0 };

  // The ids to KEEP: the newest `limit` non-starred emails, plus every starred
  // email (starred are preserved regardless of age/position).
  const keep = await prisma.email.findMany({
    where: { gmailAccountId: accountId, isStarred: false },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: { id: true },
  });
  const keepIds = keep.map((e) => e.id);

  // Everything on this account that isn't in the keep set and isn't starred.
  const doomed = { gmailAccountId: accountId, isStarred: false, id: { notIn: keepIds } } as const;
  const viaEmail = { email: doomed } as const;

  // Delete attachment blobs before their rows disappear.
  const oldAttachments = await prisma.attachment.findMany({ where: viaEmail, select: { storageKey: true } });
  let attachmentFilesDeleted = 0;
  for (const a of oldAttachments) {
    try {
      await deleteAttachment(a.storageKey);
      attachmentFilesDeleted++;
    } catch (e) {
      console.error(`[Prune] Failed to delete attachment blob ${a.storageKey}:`, e);
    }
  }

  await prisma.attachment.deleteMany({ where: viaEmail });
  await prisma.emailCategory.deleteMany({ where: viaEmail });
  await prisma.reply.deleteMany({ where: viaEmail });
  await prisma.aIAction.updateMany({ where: viaEmail, data: { emailId: null } });
  const emails = await prisma.email.deleteMany({ where: doomed });

  if (emails.count > 0) {
    console.log(`[Prune] account ${accountId}: kept ${keepIds.length}, deleted ${emails.count} older emails`);
  }
  return { emailsDeleted: emails.count, attachmentFilesDeleted };
}

export interface PurgeResult {
  skipped: boolean;
  reason?: string;
  retentionDays: number;
  cutoff?: string;
  emailsDeleted: number;
  attachmentRowsDeleted: number;
  attachmentFilesDeleted: number;
  categoriesDeleted: number;
  repliesDeleted: number;
  aiActionsDetached: number;
}

/**
 * Purge emails older than `retentionDays` (defaults to EMAIL_RETENTION_DAYS).
 * Safe to run repeatedly; only ever removes rows past the cutoff.
 */
export async function purgeOldEmails(retentionDays = getRetentionDays()): Promise<PurgeResult> {
  const base: PurgeResult = {
    skipped: true,
    retentionDays,
    emailsDeleted: 0,
    attachmentRowsDeleted: 0,
    attachmentFilesDeleted: 0,
    categoriesDeleted: 0,
    repliesDeleted: 0,
    aiActionsDetached: 0,
  };

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { ...base, reason: `retention disabled (EMAIL_RETENTION_DAYS=${retentionDays})` };
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return purgeEmailsBefore(cutoff, retentionDays);
}

/**
 * Deletes every non-starred email received before `cutoff`, plus its
 * attachments (blobs and rows), categories and replies, detaching AIActions.
 * Shared by the N-day retention purge and the end-of-day wipe.
 */
async function purgeEmailsBefore(cutoff: Date, retentionDays: number): Promise<PurgeResult> {
  // Matches every email past the cutoff that the user hasn't starred.
  const oldEmailFilter = { receivedAt: { lt: cutoff }, isStarred: false } as const;
  const viaEmail = { email: oldEmailFilter } as const;

  // 1) Remove the attachment blobs (disk/S3) before their rows disappear.
  const oldAttachments = await prisma.attachment.findMany({
    where: viaEmail,
    select: { storageKey: true },
  });
  let attachmentFilesDeleted = 0;
  for (const a of oldAttachments) {
    try {
      await deleteAttachment(a.storageKey);
      attachmentFilesDeleted++;
    } catch (e) {
      console.error(`[Retention] Failed to delete attachment blob ${a.storageKey}:`, e);
    }
  }

  // 2) Delete DB rows in FK-safe order (children first, parent last).
  const attachmentRows = await prisma.attachment.deleteMany({ where: viaEmail });
  const categories = await prisma.emailCategory.deleteMany({ where: viaEmail });
  const replies = await prisma.reply.deleteMany({ where: viaEmail });

  // AIAction.emailId is optional — keep the activity log, just unlink the email.
  const aiActions = await prisma.aIAction.updateMany({
    where: viaEmail,
    data: { emailId: null },
  });

  const emails = await prisma.email.deleteMany({ where: oldEmailFilter });

  return {
    skipped: false,
    retentionDays,
    cutoff: cutoff.toISOString(),
    emailsDeleted: emails.count,
    attachmentRowsDeleted: attachmentRows.count,
    attachmentFilesDeleted,
    categoriesDeleted: categories.count,
    repliesDeleted: replies.count,
    aiActionsDetached: aiActions.count,
  };
}

/**
 * End-of-day wipe: removes everything received before the current mail-day
 * began, leaving only today's mail. Scheduled just after local midnight, so
 * in practice it deletes the day that just ended.
 *
 * Starred emails survive, same as every other purge here — starring is an
 * explicit "keep this" from the user and stays exempt.
 */
export async function purgeEmailsBeforeToday(): Promise<PurgeResult> {
  const cutoff = startOfMailDay();
  // retentionDays is reported as 1 purely so the PurgeResult shape stays
  // consistent for callers/logging; the cutoff is what actually governs.
  return purgeEmailsBefore(cutoff, 1);
}
