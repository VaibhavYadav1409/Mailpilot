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
 *   npx tsx scripts/backfillCategories.ts --include-other
 *
 * Safe to re-run: by default it only processes rows where category is
 * still null, so re-running after a partial run (or after an interruption)
 * just picks up where it left off.
 *
 * --include-other also re-processes rows already labeled "Other". Before
 * categorizeEmail's label matching was hardened to be case/whitespace
 * insensitive, a model response like "Promotional" (instead of the exact
 * string "Spam/Promotional") silently fell back to "Other" — so mail that
 * really is promotional may be stuck under "Other" from a run before that
 * fix. This flag re-classifies that bucket; leave it off for a normal
 * incremental run since it re-spends an LLM call on every "Other" email,
 * not just uncategorized ones.
 */
import { PrismaClient } from "../src/generated/prisma";
import { categorizeEmail } from "../src/services/aiPipeline";

const prisma = new PrismaClient();

const includeOther = process.argv.includes("--include-other");
const whereClause = includeOther
  ? { OR: [{ category: null }, { category: { label: "Other" } }] }
  : { category: null };

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
  const total = await prisma.email.count({ where: whereClause });
  console.log(`[backfill] ${total} email(s) to process${includeOther ? " (including existing 'Other')" : ""}`);
  if (total === 0) {
    console.log("[backfill] nothing to do");
    return;
  }

  let totalOk = 0;
  let totalFailed = 0;
  let processedSoFar = 0;
  let cursor: string | undefined;

  while (true) {
    const emails = await prisma.email.findMany({
      where: whereClause,
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, bodyText: true, gmailAccount: { select: { employeeId: true } } },
    });

    if (emails.length === 0) break;
    cursor = emails[emails.length - 1].id;

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
