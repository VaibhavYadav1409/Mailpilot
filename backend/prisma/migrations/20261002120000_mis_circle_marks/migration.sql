-- MIS Circle Report: one mark per person per day. Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
CREATE TABLE IF NOT EXISTS "MisCircleMark" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "autoCode" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MisCircleMark_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MisCircleMark_employeeId_date_key" ON "MisCircleMark"("employeeId", "date");
CREATE INDEX IF NOT EXISTS "MisCircleMark_companyId_date_idx" ON "MisCircleMark"("companyId", "date");
DO $$ BEGIN
  ALTER TABLE "MisCircleMark" ADD CONSTRAINT "MisCircleMark_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
