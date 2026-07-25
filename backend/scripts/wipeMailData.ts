/**
 * wipeMailData.ts
 *
 * Deletes ALL mail data so you can start fresh:
 *   - Email rows (bodyText/bodyHtml — the main Postgres/Neon storage hog)
 *   - Their child rows: Attachment, EmailCategory, Reply, AIAction (emailId FK)
 *   - Local attachment files on disk (generated-attachments/), if you're
 *     using the local storage driver (the default)
 *
 * Does NOT touch: Company, Employee, GmailAccount, Session, AuditLog,
 * Notification, Report, DailyAnalytics, Permission. Only mail content is
 * removed — accounts stay connected so you can re-sync immediately after.
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/wipeMailData.ts             # dry run — just counts rows
 *   npx tsx scripts/wipeMailData.ts --confirm    # actually deletes
 *
 * Make sure your DATABASE_URL (in backend/.env) points at your Neon DB
 * before running this. Double check it's not pointed at prod-with-data-you-
 * still-need before you pass --confirm.
 */

import { PrismaClient } from "../src/generated/prisma";
import { promises as fs } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes("--confirm");

async function main() {
  const [emailCount, attachmentCount, categoryCount, replyCount, aiActionCount] =
    await Promise.all([
      prisma.email.count(),
      prisma.attachment.count(),
      prisma.emailCategory.count(),
      prisma.reply.count(),
      prisma.aIAction.count({ where: { emailId: { not: null } } }),
    ]);

  console.log("Current mail-related row counts:");
  console.log(`  Email:          ${emailCount}`);
  console.log(`  Attachment:     ${attachmentCount}`);
  console.log(`  EmailCategory:  ${categoryCount}`);
  console.log(`  Reply:          ${replyCount}`);
  console.log(`  AIAction (w/ emailId): ${aiActionCount}`);

  if (!CONFIRM) {
    console.log("\nDry run only — nothing deleted. Re-run with --confirm to actually wipe this data.");
    await prisma.$disconnect();
    return;
  }

  console.log("\n--confirm passed. Deleting in FK-safe order...");

  // Children of Email first, then Email itself. AIAction.emailId is nullable
  // so those rows are deleted only when they reference an email (an AIAction
  // not tied to any email, if such rows exist, is left alone).
  const delAttachments = await prisma.attachment.deleteMany({});
  console.log(`  Deleted Attachment rows: ${delAttachments.count}`);

  const delCategories = await prisma.emailCategory.deleteMany({});
  console.log(`  Deleted EmailCategory rows: ${delCategories.count}`);

  const delReplies = await prisma.reply.deleteMany({});
  console.log(`  Deleted Reply rows: ${delReplies.count}`);

  const delAIActions = await prisma.aIAction.deleteMany({ where: { emailId: { not: null } } });
  console.log(`  Deleted AIAction rows (email-linked): ${delAIActions.count}`);

  const delEmails = await prisma.email.deleteMany({});
  console.log(`  Deleted Email rows: ${delEmails.count}`);

  // Reset lastSyncedAt so the next sync pulls everything fresh instead of
  // only "new since last sync".
  const resetAccounts = await prisma.gmailAccount.updateMany({
    data: { lastSyncedAt: null },
  });
  console.log(`  Reset lastSyncedAt on ${resetAccounts.count} mail account(s)`);

  // Clear local attachment files, if using the local driver.
  const driver = (process.env.ATTACHMENT_STORAGE_DRIVER ?? "local").toLowerCase();
  if (driver === "local") {
    const dir = path.resolve(process.cwd(), "generated-attachments");
    try {
      await fs.rm(dir, { recursive: true, force: true });
      console.log(`  Removed local attachments directory: ${dir}`);
    } catch (err) {
      console.log(`  Could not remove ${dir}:`, (err as Error).message);
    }
  } else {
    console.log(`  ATTACHMENT_STORAGE_DRIVER=${driver} — skipping local disk cleanup (nothing local to remove).`);
  }

  console.log("\nDone. All mail data cleared — you can trigger a fresh sync now.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
