-- Only the first To address has to reply (Farsight rule).
ALTER TABLE "Email" ADD COLUMN IF NOT EXISTS "isSecondaryTo" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Email_gmailAccountId_isSecondaryTo_idx" ON "Email"("gmailAccountId", "isSecondaryTo");
UPDATE "Email" SET "isSecondaryTo" = true WHERE "id" IN (
  SELECT e."id" FROM "Email" e
  JOIN "GmailAccount" a ON a."id" = e."gmailAccountId"
  CROSS JOIN LATERAL (SELECT CASE WHEN e."toAddresses" LIKE '[%]' THEN e."toAddresses"::jsonb END AS j) x
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x.j) = 'array' THEN x.j ELSE '[]'::jsonb END AS arr) y
  WHERE e."isSecondaryTo" = false
    AND e."createdAt" < TIMESTAMP '2026-10-24 00:00:00'
    AND jsonb_array_length(y.arr) > 1
    AND lower(trim(y.arr->>0)) NOT IN (lower(a."emailAddress"), lower(COALESCE(a."imapUser", a."emailAddress")))
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(y.arr) AS t(addr)
      WHERE lower(trim(t.addr)) IN (lower(a."emailAddress"), lower(COALESCE(a."imapUser", a."emailAddress")))
    )
);
