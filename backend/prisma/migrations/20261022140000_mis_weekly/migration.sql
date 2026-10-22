-- Weekly reporters (a weekly PDF instead of a daily MIS).
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "misWeeklySince" DATE;
CREATE TABLE IF NOT EXISTS "MisWeeklyReport" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "employeeId" TEXT NOT NULL,
      "weekStart" DATE NOT NULL,
      "fileName" TEXT NOT NULL,
      "fileType" TEXT NOT NULL,
      "fileSize" INTEGER NOT NULL,
      "storageReference" TEXT NOT NULL,
      "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "uploadedById" TEXT,
      "note" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "MisWeeklyReport_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "MisWeeklyReport_storageReference_key" ON "MisWeeklyReport"("storageReference");
CREATE UNIQUE INDEX IF NOT EXISTS "MisWeeklyReport_employeeId_weekStart_key" ON "MisWeeklyReport"("employeeId", "weekStart");
CREATE INDEX IF NOT EXISTS "MisWeeklyReport_companyId_weekStart_idx" ON "MisWeeklyReport"("companyId", "weekStart");
