-- Daily intimation reports (photo -> leave records).
CREATE TABLE IF NOT EXISTS "MisIntimationReport" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "reportDate" DATE NOT NULL,
      "fileName" TEXT NOT NULL,
      "fileType" TEXT NOT NULL,
      "storageReference" TEXT NOT NULL,
      "uploadedById" TEXT,
      "rows" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "MisIntimationReport_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "MisIntimationReport_storageReference_key" ON "MisIntimationReport"("storageReference");
CREATE UNIQUE INDEX IF NOT EXISTS "MisIntimationReport_companyId_reportDate_key" ON "MisIntimationReport"("companyId", "reportDate");
