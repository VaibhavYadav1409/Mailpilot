-- Why a mail account needs reconnecting.
ALTER TABLE "GmailAccount" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "GmailAccount" ADD COLUMN IF NOT EXISTS "lastErrorAt" TIMESTAMP(3);
