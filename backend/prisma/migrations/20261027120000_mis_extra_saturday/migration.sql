-- 2 Saturdays off a month for chosen MIS staff (the 2nd Saturday + one more).
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "misExtraSaturdayOff" BOOLEAN NOT NULL DEFAULT false;
