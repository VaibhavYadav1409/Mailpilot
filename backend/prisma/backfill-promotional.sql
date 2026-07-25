-- ============================================================================
-- MailPilot — BACKFILL PROMOTIONAL LABELS (run in Neon SQL Editor)
-- ============================================================================
-- Relabels emails already in the database as "Spam/Promotional" so they move
-- out of "All" and into the "Promotions" mailbox.
--
-- This is the SQL twin of scripts/backfillPromotional.ts, for when your local
-- machine can't reach Neon directly on port 5432 (blocked network) but the
-- Neon SQL Editor (HTTPS) works. The original raw headers weren't stored on
-- these rows, so — exactly like the script's fallback — it detects promo mail
-- by the near-universal "unsubscribe" link/word in the body.
--
-- Safe to re-run. It never touches emails a human manually categorized
-- (source = 'MANUAL'), and skips ones already labeled promotional.
--
-- HOW TO RUN: Neon Console -> SQL Editor -> paste -> Run.
-- ============================================================================

-- Optional: preview how many WOULD be affected before changing anything.
SELECT count(*) AS would_relabel
FROM "Email" e
LEFT JOIN "EmailCategory" c ON c."emailId" = e.id
WHERE (c.id IS NULL OR (c.label <> 'Spam/Promotional' AND c.source <> 'MANUAL'))
  AND (e."bodyHtml" ILIKE '%unsubscribe%' OR e."bodyText" ILIKE '%unsubscribe%');

-- 1) Emails with NO category yet -> create a promotional one.
INSERT INTO "EmailCategory" (id, "emailId", label, source, confidence)
SELECT gen_random_uuid()::text, e.id, 'Spam/Promotional', 'HEURISTIC', 1
FROM "Email" e
WHERE NOT EXISTS (SELECT 1 FROM "EmailCategory" c WHERE c."emailId" = e.id)
  AND (e."bodyHtml" ILIKE '%unsubscribe%' OR e."bodyText" ILIKE '%unsubscribe%');

-- 2) Emails categorized as something else (not manual, not already promo)
--    -> relabel to promotional.
UPDATE "EmailCategory" c
SET label = 'Spam/Promotional', source = 'HEURISTIC', confidence = 1
FROM "Email" e
WHERE c."emailId" = e.id
  AND c.label <> 'Spam/Promotional'
  AND c.source <> 'MANUAL'
  AND (e."bodyHtml" ILIKE '%unsubscribe%' OR e."bodyText" ILIKE '%unsubscribe%');

-- Result: total promotional emails now filed under "Promotions".
SELECT count(*) AS promotional_emails
FROM "EmailCategory"
WHERE label = 'Spam/Promotional';
