-- MIS auto-check.
--
-- Purely additive: three new tables, no changes to existing tables or rows.

-- CreateTable
CREATE TABLE "MisConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MisConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MisSource" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "shareUrl" TEXT NOT NULL,
    "driveId" TEXT,
    "itemId" TEXT,
    "fileName" TEXT,
    "webUrl" TEXT,
    "sheetName" TEXT,
    "dateColumn" TEXT,
    "requiredColumns" JSONB,
    "detectedColumns" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MisSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MisDailyCheck" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "missingColumns" JSONB,
    "incompleteRows" JSONB,
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MisDailyCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MisConnection_companyId_key" ON "MisConnection"("companyId");

-- CreateIndex
CREATE INDEX "MisSource_companyId_idx" ON "MisSource"("companyId");

-- CreateIndex
CREATE INDEX "MisSource_employeeId_idx" ON "MisSource"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "MisDailyCheck_sourceId_checkDate_key" ON "MisDailyCheck"("sourceId", "checkDate");

-- CreateIndex
CREATE INDEX "MisDailyCheck_companyId_checkDate_idx" ON "MisDailyCheck"("companyId", "checkDate");

-- CreateIndex
CREATE INDEX "MisDailyCheck_employeeId_checkDate_idx" ON "MisDailyCheck"("employeeId", "checkDate");

-- AddForeignKey
ALTER TABLE "MisSource" ADD CONSTRAINT "MisSource_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MisDailyCheck" ADD CONSTRAINT "MisDailyCheck_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MisSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
