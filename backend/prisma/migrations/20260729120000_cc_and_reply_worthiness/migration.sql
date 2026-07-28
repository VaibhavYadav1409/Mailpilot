-- CC tracking + AI-assessed reply-worthiness.
--
-- All columns are additive and nullable (or defaulted), so this migration is
-- safe to apply to a live database with existing mail: nothing is rewritten,
-- and every pre-existing row simply starts out with requiresReply = NULL,
-- which the application treats as "needs a reply" (the safe default — see the
-- schema comment on Email.requiresReply). Existing rows are re-assessed
-- lazily as they're re-synced, or in bulk via
-- `backend/scripts/backfillReplyWorthiness.ts`.

ALTER TABLE "Email" ADD COLUMN "ccAddresses" TEXT;
ALTER TABLE "Email" ADD COLUMN "isCc" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Email" ADD COLUMN "requiresReply" BOOLEAN;
ALTER TABLE "Email" ADD COLUMN "replyClassification" TEXT;
ALTER TABLE "Email" ADD COLUMN "replyClassifiedAt" TIMESTAMP(3);

CREATE INDEX "Email_gmailAccountId_isReplied_requiresReply_idx"
  ON "Email"("gmailAccountId", "isReplied", "requiresReply");
CREATE INDEX "Email_gmailAccountId_isCc_idx"
  ON "Email"("gmailAccountId", "isCc");

-- Mail already deterministically identified as bulk/promotional never needs a
-- reply, and that verdict doesn't depend on the LLM. Settling it here means
-- the existing promotional backlog drops out of Pending immediately on deploy
-- rather than waiting for a re-sync or a backfill run.
UPDATE "Email" e
SET "requiresReply" = false,
    "replyClassification" = 'AUTOMATED',
    "replyClassifiedAt" = NOW()
FROM "EmailCategory" c
WHERE c."emailId" = e."id"
  AND c."label" = 'Spam/Promotional'
  AND e."requiresReply" IS NULL;
