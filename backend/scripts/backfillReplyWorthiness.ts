/**
 * One-time backfill: assesses reply-worthiness (Email.requiresReply /
 * replyClassification) for every existing email that predates the feature.
 *
 * Why this is needed: categorizeEmail() sets both the category and the
 * reply-worthiness verdict, but it only runs automatically for emails created
 * *during* a sync. Every email already in the database when this feature
 * shipped has requiresReply = NULL, which the app deliberately treats as
 * "needs a reply" — safe, but it means the existing backlog all shows up in
 * Unreplied/Pending until it's assessed. This script sweeps that up.
 *
 * Usage:
 *   npx tsx scripts/backfillReplyWorthiness.ts
 *   npx tsx scripts/backfillReplyWorthiness.ts --include-replied
 *
 * Safe to re-run: by default it only processes rows where requiresReply is
 * still NULL, so a re-run after an interruption picks up where it left off.
 *
 * By default it also skips already-replied mail — reply-worthiness only
 * affects which emails appear as *pending*, so spending an LLM call to
 * classify something already answered buys nothing. --include-replied
 * classifies those too, for complete data (e.g. if you later want to report
 * on how much genuinely-actionable mail a person handles).
 */
import { PrismaClient } from "../src/generated/prisma";
import { categorizeEmail, markNoReplyNeeded } from "../src/services/aiPipeline";
import { isGroqCoolingDown } from "../src/lib/llm";

const prisma = new PrismaClient();

const includeReplied = process.argv.includes("--include-replied");

const whereClause = {
  requiresReply: null,
  ...(includeReplied ? {} : { isReplied: false }),
};

// This is a bulk backfill against a tokens-per-minute quota, which makes it a
// fundamentally different problem from a live sync.
//
// The first version ran 5 calls concurrently (copied from
// backfillCategories.ts) and failed 77 of 109 emails on a free-tier Groq key:
// at ~2,000 tokens per call against a 12,000 TPM ceiling, five simultaneous
// requests exhaust the minute's budget immediately, trip the circuit breaker,
// and then every remaining call in the run fails instantly against the open
// breaker. Concurrency actively hurts here — there is no throughput to win,
// only a shared quota to overrun.
//
// So: one call at a time, paced. Slower per email, but it finishes, which the
// concurrent version did not.
const CONCURRENCY = 1;
const BATCH_SIZE = 200;

// Spacing between calls. ~2,000 tokens each against a 12,000 TPM budget
// allows roughly six per minute; 10s keeps a comfortable margin under that.
// Override with BACKFILL_DELAY_MS on a paid tier with a higher ceiling.
const DELAY_MS = Math.max(0, Number(process.env.BACKFILL_DELAY_MS) || 10_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Blocks until the LLM circuit breaker closes.
 *
 * Waiting is correct for a backfill and wrong for a sync — which is why
 * lib/llm.ts fails fast instead. During a sync, a call that sleeps keeps its
 * email body in memory, and hundreds of those piling up is what previously
 * OOM-killed the Render instance. This script processes one email at a time
 * in a standalone process, so sleeping holds nothing and simply lets the
 * quota refill rather than burning through the remaining rows against an
 * open breaker (the exact failure mode of the first run).
 */
async function waitOutCooldown(): Promise<void> {
  let announced = false;
  while (isGroqCoolingDown()) {
    if (!announced) {
      console.log("[backfill:reply] Groq is cooling down — waiting for the quota to refill…");
      announced = true;
    }
    await sleep(5_000);
  }
}

interface Row {
  id: string;
  bodyText: string | null;
  subject: string | null;
  category: { label: string } | null;
  gmailAccount: { employeeId: string };
}

/**
 * Promotional mail is settled by headers at sync time, so it never needs an
 * LLM call here — resolving it locally keeps a newsletter-heavy backlog from
 * burning most of the quota on foregone conclusions.
 */
async function classifyOne(e: Row): Promise<void> {
  if (e.category?.label === "Spam/Promotional") {
    await markNoReplyNeeded(e.id);
    return;
  }
  // Subject carries real signal for short acknowledgments ("Re: invoice —
  // thanks!") where the body may be almost empty, so include it.
  const content = [e.subject ? `Subject: ${e.subject}` : "", e.bodyText ?? ""].filter(Boolean).join("\n\n");
  await categorizeEmail(e.gmailAccount.employeeId, e.id, content);
}

async function processBatch(emails: Row[], processedSoFar: number, total: number) {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const slice = emails.slice(i, i + CONCURRENCY);

    // Refill the quota before spending it, rather than burning rows against
    // an open breaker.
    await waitOutCooldown();

    const results = await Promise.allSettled(slice.map(classifyOne));
    let neededLLM = false;
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        ok++;
        // Promotional mail resolves locally with no LLM call, so it doesn't
        // consume quota and shouldn't trigger the pacing delay.
        if (slice[j].category?.label !== "Spam/Promotional") neededLLM = true;
      } else {
        failed++;
        // One line per failure — the full stack traces were pure noise at
        // this volume, and every one of them was the same rate-limit error.
        console.error(`[backfill:reply] failed (${slice[j].id}):`, (r.reason as Error)?.message ?? r.reason);
        neededLLM = true;
      }
    }
    console.log(`[backfill:reply] progress: ${processedSoFar + i + slice.length}/${total}`);

    const isLast = i + CONCURRENCY >= emails.length;
    if (neededLLM && !isLast && DELAY_MS > 0) await sleep(DELAY_MS);
  }
  return { ok, failed };
}

async function main() {
  const total = await prisma.email.count({ where: whereClause });
  console.log(
    `[backfill:reply] ${total} email(s) to assess${includeReplied ? " (including already-replied)" : " (unreplied only)"}`
  );
  if (total === 0) {
    console.log("[backfill:reply] nothing to do");
    return;
  }
  if (DELAY_MS > 0) {
    const mins = Math.ceil((total * DELAY_MS) / 60_000);
    console.log(
      `[backfill:reply] pacing at ~${DELAY_MS / 1000}s per email to stay under the Groq rate limit — ` +
        `roughly ${mins} minute(s). Safe to stop with Ctrl+C and re-run later; progress is saved per email. ` +
        `Set BACKFILL_DELAY_MS lower if you're on a paid tier.`
    );
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
      select: {
        id: true,
        bodyText: true,
        subject: true,
        category: { select: { label: true } },
        gmailAccount: { select: { employeeId: true } },
      },
    });

    if (emails.length === 0) break;
    cursor = emails[emails.length - 1].id;

    const { ok, failed } = await processBatch(emails, processedSoFar, total);
    totalOk += ok;
    totalFailed += failed;
    processedSoFar += emails.length;
    console.log(
      `[backfill:reply] batch done — ok: ${ok}, failed: ${failed}, running total: ${totalOk} ok / ${totalFailed} failed`
    );
  }

  console.log(
    `[backfill:reply] complete — ${totalOk} assessed, ${totalFailed} failed (re-run this script to retry failures)`
  );
}

main()
  .catch((e) => {
    console.error("[backfill:reply] fatal error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
