/**
 * Force a one-time deep backfill WITHOUT deleting any existing mail.
 *
 * Clears lastSyncedAt on every connected account so the next sync stops being
 * incremental and instead fetches the newest emails again (Gmail: last
 * SYNC_INITIAL_DAYS days; Outlook/Graph: newest, no date filter), still capped
 * and pruned to MAX_EMAILS_PER_ACCOUNT (75). Existing rows are kept and
 * de-duplicated on re-fetch, so this is safe to run anytime you switched
 * retention modes and want accounts topped back up to the 75-email window.
 *
 * Usage (from backend/):
 *   npx tsx scripts/forceBackfill.ts
 *
 * Make sure DATABASE_URL in backend/.env points at the Neon instance you mean.
 */
import { prisma } from "../src/lib/db";

async function main() {
  const r = await prisma.gmailAccount.updateMany({ data: { lastSyncedAt: null } });
  console.log(
    `Cleared lastSyncedAt on ${r.count} account(s). The next background sync ` +
      `(every BACKGROUND_SYNC_MINUTES) will deep-fetch newest mail up to the 75-email cap. ` +
      `No emails were deleted.`,
  );
}

main()
  .catch((e) => {
    console.error("forceBackfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
