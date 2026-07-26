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
