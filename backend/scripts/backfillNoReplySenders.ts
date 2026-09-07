/**
 * Deterministic backfill: marks every stored email from a known automated
 * sender (see src/services/noReplySenders.ts) as not needing a reply.
 *
 * Separate from backfillReplyWorthiness.ts on purpose: that script asks the
 * LLM and is paced against a tokens-per-day quota, which makes clearing a
 * backlog of bank/depository robots slow and, on a free tier, impossible once
 * the daily budget is gone. This verdict comes from the sender address, so it
 * needs no model, no pacing, and no quota — it's a single UPDATE per address.
 *
 * Usage:
 *   npx tsx scripts/backfillNoReplySenders.ts
 *   npx tsx scripts/backfillNoReplySenders.ts --dry-run
 *
 * Safe to re-run: it only touches rows whose requiresReply isn't already false.
 */
import { PrismaClient } from "../src/generated/prisma";
import { NO_REPLY_SENDERS, isNoReplySender } from "../src/services/noReplySenders";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  // Match on the stored fromAddress. Distinct addresses first, so the pattern
  // rules (generic no-reply@ local-parts, *@domain entries, env additions)
  // are applied by the same function the sync path uses rather than being
  // re-implemented as SQL.
  const senders = await prisma.email.findMany({
    where: { requiresReply: { not: false } },
    select: { fromAddress: true },
    distinct: ["fromAddress"],
  });

  const matched = senders.map((s) => s.fromAddress).filter((a) => isNoReplySender(a));

  if (matched.length === 0) {
    console.log("[backfill:no-reply] nothing to do — no unsettled mail from listed senders.");
    console.log(`[backfill:no-reply] list currently has ${NO_REPLY_SENDERS.length} built-in address(es).`);
    return;
  }

  console.log(`[backfill:no-reply] ${matched.length} matching sender address(es):`);
  for (const a of matched) console.log(`  - ${a}`);

  if (dryRun) {
    const count = await prisma.email.count({
      where: { fromAddress: { in: matched }, requiresReply: { not: false } },
    });
    console.log(`[backfill:no-reply] --dry-run: ${count} email(s) would be marked no-reply-needed.`);
    return;
  }

  const result = await prisma.email.updateMany({
    where: { fromAddress: { in: matched }, requiresReply: { not: false } },
    data: { requiresReply: false, replyClassification: "AUTOMATED", replyClassifiedAt: new Date() },
  });

  console.log(`[backfill:no-reply] marked ${result.count} email(s) as no-reply-needed. No LLM calls used.`);
}

main()
  .catch((e) => {
    console.error("[backfill:no-reply] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
