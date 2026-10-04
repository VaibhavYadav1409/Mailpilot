-- MIS evidence for HR: when each Excel file was last saved and by whom, every
-- change MailPilot saw per day, and the evidence locked with each circle mark.
-- Additive. IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "fileModifiedAt" TIMESTAMP(3);
ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "fileModifiedBy" TEXT;
ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "finalAt" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS "MisCheckEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "filledCount" INTEGER NOT NULL DEFAULT 0,
    "blankCount" INTEGER NOT NULL DEFAULT 0,
    "fileModifiedAt" TIMESTAMP(3),
    "fileModifiedBy" TEXT,
    "note" TEXT,
    CONSTRAINT "MisCheckEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MisCheckEvent_employeeId_checkDate_idx" ON "MisCheckEvent"("employeeId", "checkDate");
CREATE INDEX IF NOT EXISTS "MisCheckEvent_companyId_at_idx" ON "MisCheckEvent"("companyId", "at");
