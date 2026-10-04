-- Nightly MIS email: staff contact emails, granted Microsoft scopes, settings and a send log. Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
ALTER TABLE "MisConnection" ADD COLUMN IF NOT EXISTS "scopes" TEXT;
CREATE TABLE IF NOT EXISTS "MisEmailSettings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sendTime" TEXT NOT NULL DEFAULT '23:30',
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "skipOffDays" BOOLEAN NOT NULL DEFAULT true,
    "hrSummary" BOOLEAN NOT NULL DEFAULT true,
    "hrEmails" TEXT,
    "subject" TEXT,
    "intro" TEXT,
    "footer" TEXT,
    "cronToken" TEXT NOT NULL,
    "lastRunDate" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunSummary" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MisEmailSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MisEmailSettings_companyId_key" ON "MisEmailSettings"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "MisEmailSettings_cronToken_key" ON "MisEmailSettings"("cronToken");
CREATE TABLE IF NOT EXISTS "MisEmailLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "employeeId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MisEmailLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MisEmailLog_companyId_createdAt_idx" ON "MisEmailLog"("companyId", "createdAt");
