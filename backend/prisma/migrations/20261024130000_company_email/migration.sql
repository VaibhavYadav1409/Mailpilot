-- Custom emails to everyone (sent now or later).
CREATE TABLE IF NOT EXISTS "CompanyEmail" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "subject" TEXT NOT NULL,
      "body" TEXT NOT NULL,
      "audience" TEXT NOT NULL DEFAULT 'ALL',
      "employeeIds" JSONB,
      "sendAt" TIMESTAMP(3) NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
      "total" INTEGER NOT NULL DEFAULT 0,
      "sent" INTEGER NOT NULL DEFAULT 0,
      "failed" INTEGER NOT NULL DEFAULT 0,
      "error" TEXT,
      "createdById" TEXT,
      "sentAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "CompanyEmail_pkey" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "CompanyEmail_companyId_createdAt_idx" ON "CompanyEmail"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "CompanyEmail_status_sendAt_idx" ON "CompanyEmail"("status", "sendAt");
