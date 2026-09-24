-- MSI Daily Work Report.
--
-- Purely additive: two new tables, no changes to any existing table or row,
-- so this is safe to apply to the live database. All MSI data is temporary
-- (auto-deleted 2 days after its report date by the scheduler's MSI cleanup
-- job — see backend/src/services/msiService.ts).

-- CreateTable
CREATE TABLE "MsiDailyReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageReference" TEXT NOT NULL,
    "importantMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MsiDailyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsiReportFile" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MsiReportFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MsiDailyReport_storageReference_key" ON "MsiDailyReport"("storageReference");

-- CreateIndex
CREATE UNIQUE INDEX "MsiDailyReport_employeeId_reportDate_key" ON "MsiDailyReport"("employeeId", "reportDate");

-- CreateIndex
CREATE INDEX "MsiDailyReport_companyId_reportDate_idx" ON "MsiDailyReport"("companyId", "reportDate");

-- CreateIndex
CREATE INDEX "MsiDailyReport_expiresAt_idx" ON "MsiDailyReport"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MsiReportFile_storageKey_key" ON "MsiReportFile"("storageKey");

-- AddForeignKey
ALTER TABLE "MsiDailyReport" ADD CONSTRAINT "MsiDailyReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsiDailyReport" ADD CONSTRAINT "MsiDailyReport_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
