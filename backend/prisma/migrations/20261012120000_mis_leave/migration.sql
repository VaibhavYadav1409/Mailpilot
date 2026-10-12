-- Leave records from the Google leave form (+ settings). Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
CREATE TABLE IF NOT EXISTS "MisLeave" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "employeeId" TEXT,
      "personName" TEXT NOT NULL,
      "email" TEXT,
      "fromDate" DATE NOT NULL,
      "toDate" DATE NOT NULL,
      "type" TEXT NOT NULL DEFAULT 'PLANNED',
      "status" TEXT NOT NULL DEFAULT 'APPROVED',
      "leaveKind" TEXT,
      "reason" TEXT,
      "submittedAt" TIMESTAMP(3),
      "source" TEXT NOT NULL DEFAULT 'FORM',
      "formKey" TEXT,
      "editedInApp" BOOLEAN NOT NULL DEFAULT false,
      "note" TEXT,
      "raw" JSONB,
      "updatedById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "MisLeave_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "MisLeave_companyId_formKey_key" ON "MisLeave"("companyId", "formKey");
CREATE INDEX IF NOT EXISTS "MisLeave_companyId_fromDate_idx" ON "MisLeave"("companyId", "fromDate");
CREATE INDEX IF NOT EXISTS "MisLeave_employeeId_fromDate_idx" ON "MisLeave"("employeeId", "fromDate");
CREATE TABLE IF NOT EXISTS "MisLeaveSettings" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "token" TEXT NOT NULL,
      "noticeDays" INTEGER NOT NULL DEFAULT 2,
      "lastReceivedAt" TIMESTAMP(3),
      "lastSummary" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "MisLeaveSettings_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "MisLeaveSettings_companyId_key" ON "MisLeaveSettings"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "MisLeaveSettings_token_key" ON "MisLeaveSettings"("token");
