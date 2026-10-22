-- Every Saturday off for chosen MIS staff (personal calendar).
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "misSaturdaysOff" BOOLEAN NOT NULL DEFAULT false;
