/**
 * One-time backfill: relabels already-stored emails as "Spam/Promotional"
 * using the deterministic detector (promoDetector.ts) — no LLM calls.
 *
 * Why this is needed: promotional detection now happens at sync time from
 * Gmail labels / bulk-mail headers, but emails already in the database were
 * synced before that and may be uncategorized or mislabeled as "Other",
 * which is why they show up in "All" instead of "Promotions". Normal
 * incremental syncs won't revisit them (they only fetch mail newer than
 * lastSyncedAt), so this script sweeps the existing backlog once.
 *
 * Headers weren't retained on those rows, so this relies on the detector's
 * body-based fallback (an "unsubscribe" link/word), plus subject/from — which
 * catches the overwhelming majority of marketing/newsletter mail.
 *
 * Usage (from backend/):
 *   npx tsx scripts/backfillPromotional.ts            # dry run: only reports
 *   npx tsx scripts/backfillPromotional.ts --apply    # actually relabels
 *
 * By default it will NOT overwrite an email a human manually categorized
 * (source = "MANUAL"); pass --include-manual to override that too.
 */
import { PrismaClient } from "../src/generated/prisma";
import { isPromotionalEmail, PROMOTIONAL_LABEL } from "../src/services/promoDetector";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const includeManual = process.argv.includes("--include-manual");
const BATCH_SIZE = 500;

async function main() {
  console.log(
    apply
      ? "[promo-backfill] APPLY mode — promotional emails will be relabeled."
      : "[promo-backfill] DRY RUN — nothing will be changed. Re-run with --apply to commit.",
  );

  let cursor: string | undefined;
  let scanned = 0;
  let matched = 0;
  let relabeled = 0;
  let skippedManual = 0;

  while (true) {
    const emails = await prisma.email.findMany({
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        subject: true,
        fromAddress: true,
        bodyText: true,
        bodyHtml: true,
        category: { select: { label: true, source: true } },
      },
    });
    if (emails.length === 0) break;
    cursor = emails[emails.length - 1].id;

    for (const e of emails) {
      scanned++;

      // Already correctly filed — leave it alone.
      if (e.category?.label === PROMOTIONAL_LABEL) continue;

      const promo = isPromotionalEmail({
        bodyText: e.bodyText,
        bodyHtml: e.bodyHtml,
      });
      if (!promo) continue;
      matched++;

      if (e.category?.source === "MANUAL" && !includeManual) {
        skippedManual++;
        continue;
      }

      if (apply) {
        await prisma.emailCategory.upsert({
          where: { emailId: e.id },
          create: { emailId: e.id, label: PROMOTIONAL_LABEL, source: "HEURISTIC", confidence: 1 },
          update: { label: PROMOTIONAL_LABEL, source: "HEURISTIC", confidence: 1 },
        });
        relabeled++;
      } else {
        console.log(`  would relabel: ${(e.fromAddress || "").slice(0, 40)}  |  ${(e.subject || "(no subject)").slice(0, 60)}`);
      }
    }
    console.log(`[promo-backfill] scanned ${scanned}...`);
  }

  console.log("[promo-backfill] done.");
  console.log(`  scanned:        ${scanned}`);
  console.log(`  promotional:    ${matched}`);
  console.log(`  skipped manual: ${skippedManual}`);
  console.log(apply ? `  relabeled:      ${relabeled}` : `  (dry run — re-run with --apply to relabel ${matched - skippedManual})`);
}

main()
  .catch((e) => {
    console.error("[promo-backfill] fatal error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
