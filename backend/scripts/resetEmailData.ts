/**
 * Wipes all synced mail data (emails, attachments, categories, replies,
 * AI actions) and clears each account's lastSyncedAt so the next sync runs
 * as a fresh full sync (last 30 days, see emailSync.ts) instead of picking
 * up from wherever it last left off. Connected accounts themselves are
 * NOT deleted or disconnected — this only clears synced content, so you
 * don't have to re-auth Gmail/IMAP after running it.
 *
 * Usage (from backend/):
 *   npx tsx scripts/resetEmailData.ts
 *
 * Make sure DATABASE_URL in backend/.env points at the Neon instance you
 * actually mean to wipe before running this.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";

async function main() {
  console.log("Wiping synced email data...");

  // Children first — none of these relations are onDelete: Cascade in the
  // schema, so Email rows can't be deleted while AIAction/Reply/
  // EmailCategory/Attachment rows still reference them.
  const aiActions = await prisma.aIAction.deleteMany({ where: { emailId: { not: null } } });
  const replies = await prisma.reply.deleteMany({});
  const categories = await prisma.emailCategory.deleteMany({});
  const attachments = await prisma.attachment.deleteMany({});
  const emails = await prisma.email.deleteMany({});

  console.log(
    `Deleted: ${emails.count} emails, ${attachments.count} attachments, ${categories.count} categories, ${replies.count} replies, ${aiActions.count} AI actions`
  );

  // Clear lastSyncedAt on every account (not just active ones) so the next
  // sync for each falls back to the "first sync" 30-day window in
  // syncEmployeeInbox, rather than syncing "since last time" against a
  // now-empty Email table (which would otherwise miss anything older).
  const accounts = await prisma.gmailAccount.updateMany({ data: { lastSyncedAt: null } });
  console.log(`Reset lastSyncedAt on ${accounts.count} account(s) — next sync will be a full 30-day resync.`);

  // Local-disk attachment bytes (default driver). If you're running with
  // ATTACHMENT_STORAGE_DRIVER=s3, the DB rows above are gone but the S3
  // objects are NOT deleted by this script — clear that bucket separately
  // if you want those bytes gone too.
  const attachmentsDir = path.resolve(process.cwd(), "generated-attachments");
  try {
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    console.log(`Removed local attachment directory: ${attachmentsDir}`);
  } catch (e) {
    console.warn(`Could not remove ${attachmentsDir}:`, e);
  }

  console.log("Done. Reconnect/resync your accounts now.");
}

main()
  .catch((e) => {
    console.error("resetEmailData failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
