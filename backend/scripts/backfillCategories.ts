/**
 * One-time backfill: categorizes every existing Email row that has no
 * EmailCategory yet.
 *
 * Why this is needed: categorizeEmail() only ever runs automatically for
 * emails created *during* a sync call (see emailSync.ts). Any email that
 * was already in the database before the AI categorization feature shipped
 * — which is most of a pre-existing inbox — was never touched by it and
 * never will be by future syncs either, since incremental syncs only fetch
 * mail newer than the account's lastSyncedAt (and a first sync only pulls
 * the last 30 days). This script sweeps up that backlog once.
 *
 * Usage:
 *   npx tsx scripts/backfillCategories.ts
 *
 * Safe to re-run: it only processes rows where category is still null, so
 * re-running after a partial run (or after an interruption) just picks up
 * where it left off.
 */
import { PrismaClient } from "../src/generated/prisma";
import { categorizeEmail } from "../src/services/aiPipeline";

const prisma = new PrismaClient();

// Keep this modest — categorizeEmail calls out to an LLM per email, and
// this may be sweeping up months of backlog across every employee at once.
// invokeLLM now has a 30s timeout (see lib/llm.ts), so a stalled request
// fails and gets logged instead of silently hanging the whole batch forever.
const CONCURRENCY = 5;
const BATCH_SIZE = 200;

async function processBatch(
  emails: { id: string; bodyText: string | null; gmailAccount: { employeeId: string } }[],
  processedSoFar: number,
  total: number
) {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const slice = emails.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((e) => categorizeEmail(e.gmailAccount.employeeId, e.id, e.bodyText ?? ""))
    );
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else {
        failed++;
        console.error("[backfill] failed:", r.reason);
      }
    }
    // Log after every slice of 5, not just once per 200 — otherwise a slow
    // stretch (rate limiting, a couple of slow LLM calls) can look identical
    // to the script being frozen for minutes at a time.
    console.log(`[backfill] progress: ${processedSoFar + i + slice.length}/${total}`);
  }
  return { ok, failed };
}

async function main() {
  const total = await prisma.email.count({ where: { category: null } });
  console.log(`[backfill] ${total} uncategorized emails to process`);
  if (total === 0) {
    console.log("[backfill] nothing to do — every email already has a category");
    return;
  }

  let totalOk = 0;
  let totalFailed = 0;
  let processedSoFar = 0;

  while (true) {
    const emails = await prisma.email.findMany({
      where: { category: null },
      take: BATCH_SIZE,
      select: { id: true, bodyText: true, gmailAccount: { select: { employeeId: true } } },
    });

    if (emails.length === 0) break;

    const { ok, failed } = await processBatch(emails, processedSoFar, total);
    totalOk += ok;
    totalFailed += failed;
    processedSoFar += emails.length;
    console.log(`[backfill] batch done — ok: ${ok}, failed: ${failed}, running total: ${totalOk} ok / ${totalFailed} failed`);
  }

  console.log(`[backfill] complete — ${totalOk} categorized, ${totalFailed} failed (re-run this script to retry failures)`);
}

main()
  .catch((e) => {
    console.error("[backfill] fatal error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
