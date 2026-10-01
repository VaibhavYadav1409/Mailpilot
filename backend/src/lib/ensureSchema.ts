import { prisma } from "./db";

/**
 * Applies small, additive schema changes at boot, so a deploy works even when
 * `prisma migrate deploy` can't be run from a developer PC (e.g. the office
 * network blocks the database port). Every statement is idempotent and
 * mirrors a migration in prisma/migrations, which uses the same IF NOT EXISTS
 * form — so running `prisma migrate deploy` later is still safe.
 */
const STATEMENTS: { migration: string; sql: string }[] = [
  { migration: "20261001120000_mis_reviewers", sql: `ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "checkedBy" TEXT` },
  { migration: "20261001120000_mis_reviewers", sql: `ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "approvedBy" TEXT` },
  { migration: "20261001120000_mis_reviewers", sql: `ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "lastETag" TEXT` },
  {
    migration: "20261002120000_mis_circle_marks",
    sql: `CREATE TABLE IF NOT EXISTS "MisCircleMark" (
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
      CONSTRAINT "MisCircleMark_pkey" PRIMARY KEY ("id"))`,
  },
  {
    migration: "20261002120000_mis_circle_marks",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS "MisCircleMark_employeeId_date_key" ON "MisCircleMark"("employeeId", "date")`,
  },
  {
    migration: "20261002120000_mis_circle_marks",
    sql: `CREATE INDEX IF NOT EXISTS "MisCircleMark_companyId_date_idx" ON "MisCircleMark"("companyId", "date")`,
  },
  {
    migration: "20261002120000_mis_circle_marks",
    sql: `DO $$ BEGIN
      ALTER TABLE "MisCircleMark" ADD CONSTRAINT "MisCircleMark_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`,
  },
];

export async function ensureSchema(): Promise<void> {
  for (const s of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(s.sql);
    } catch (e) {
      // Never block startup: log and carry on (the feature using it will report the error).
      console.error(`[boot] schema step for ${s.migration} failed:`, e instanceof Error ? e.message : e);
      return;
    }
  }
  console.log(`[boot] schema check ok (${STATEMENTS.length} statements)`);
}
