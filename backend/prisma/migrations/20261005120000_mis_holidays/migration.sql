-- MIS working calendar: company holidays on top of the built-in NSE trading
-- holidays (isOff = false turns a built-in holiday into a working day). Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
CREATE TABLE IF NOT EXISTS "MisHoliday" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "isOff" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MisHoliday_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MisHoliday_companyId_date_key" ON "MisHoliday"("companyId", "date");
