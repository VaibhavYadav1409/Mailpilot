/**
 * Deterministic backfill: marks every stored email that noReplySenders.ts can
 * settle from addresses alone as not needing a reply — mail from a known
 * automated sender, and mail between the two halves of a configured internal
 * pair (see NO_REPLY_PAIRS).
 *
 * Separate from backfillReplyWorthiness.ts on purpose: that script asks the
 * LLM and is paced against a tokens-per-day quota, which makes clearing a
 * backlog of bank/depository robots slow and, on a free tier, impossible once
 * the daily budget is gone. These verdicts come from the addresses, so they
 * need no model, no pacing, and no quota.
 *
 * Usage:
 *   npx tsx scripts/backfillNoReplySenders.ts
 *   npx tsx scripts/backfillNoReplySenders.ts --dry-run
 *
 * Safe to re-run: it only touches rows whose requiresReply isn't already false.
 */
import { PrismaClient } from "../src/generated/prisma";
import { NO_REPLY_SENDERS, NO_REPLY_PAIRS, isNoReplySender, isNoReplyPair } from "../src/services/noReplySenders";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

/** To/Cc are stored as JSON-encoded string[]; decode leniently. */
function parseAddressColumn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [String(raw)];
  } catch {
    return [raw];
  }
}

async function main() {
  // Matching happens in JS rather than SQL so the pattern rules (generic
  // no-reply@ local-parts, *@domain entries, pair direction, env additions)
  // are applied by the same functions the sync path uses, instead of being
  // re-implemented as a query that could drift from them.
  const rows = await prisma.email.findMany({
    where: { requiresReply: { not: false } },
    select: { id: true, fromAddress: true, toAddresses: true, ccAddresses: true },
  });

  const bySender: string[] = [];
  const byPair: string[] = [];
  for (const r of rows) {
    if (isNoReplySender(r.fromAddress)) {
      bySender.push(r.id);
    } else if (
      isNoReplyPair(r.fromAddress, [
        ...parseAddressColumn(r.toAddresses),
        ...parseAddressColumn(r.ccAddresses),
      ])
    ) {
      byPair.push(r.id);
    }
  }

  const ids = [...bySender, ...byPair];
  console.log(
    `[backfill:no-reply] scanned ${rows.length} unsettled email(s): ` +
      `${bySender.length} from listed senders, ${byPair.length} between listed pairs.`
  );
  console.log(
    `[backfill:no-reply] list: ${NO_REPLY_SENDERS.length} built-in sender(s), ${NO_REPLY_PAIRS.length} pair(s).`
  );

  if (ids.length === 0) {
    console.log("[backfill:no-reply] nothing to do.");
    return;
  }
  if (dryRun) {
    console.log(`[backfill:no-reply] --dry-run: ${ids.length} email(s) would be marked no-reply-needed.`);
    return;
  }

  // Chunked so a large backlog doesn't build one enormous IN (...) clause.
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const result = await prisma.email.updateMany({
      where: { id: { in: ids.slice(i, i + CHUNK) } },
      data: { requiresReply: false, replyClassification: "AUTOMATED", replyClassifiedAt: new Date() },
    });
    updated += result.count;
  }
  console.log(`[backfill:no-reply] marked ${updated} email(s) as no-reply-needed. No LLM calls used.`);
}

main()
  .catch((e) => {
    console.error("[backfill:no-reply] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
