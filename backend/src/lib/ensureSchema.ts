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
  { migration: "20261003120000_mis_circle_reason", sql: `ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "reason" TEXT` },
  {
    migration: "20261005120000_mis_holidays",
    sql: `CREATE TABLE IF NOT EXISTS "MisHoliday" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "date" DATE NOT NULL,
      "name" TEXT NOT NULL,
      "isOff" BOOLEAN NOT NULL DEFAULT true,
      "createdById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "MisHoliday_pkey" PRIMARY KEY ("id"))`,
  },
  {
    migration: "20261005120000_mis_holidays",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS "MisHoliday_companyId_date_key" ON "MisHoliday"("companyId", "date")`,
  },
  { migration: "20261005130000_mis_evidence", sql: `ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "fileModifiedAt" TIMESTAMP(3)` },
  { migration: "20261005130000_mis_evidence", sql: `ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "fileModifiedBy" TEXT` },
  { migration: "20261005130000_mis_evidence", sql: `ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "evidence" JSONB` },
  { migration: "20261005130000_mis_evidence", sql: `ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "finalAt" TIMESTAMP(3)` },
  {
    migration: "20261005130000_mis_evidence",
    sql: `CREATE TABLE IF NOT EXISTS "MisCheckEvent" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "employeeId" TEXT NOT NULL,
      "checkDate" DATE NOT NULL,
      "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "status" TEXT NOT NULL,
      "filledCount" INTEGER NOT NULL DEFAULT 0,
      "blankCount" INTEGER NOT NULL DEFAULT 0,
      "fileModifiedAt" TIMESTAMP(3),
      "fileModifiedBy" TEXT,
      "note" TEXT,
      CONSTRAINT "MisCheckEvent_pkey" PRIMARY KEY ("id"))`,
  },
  {
    migration: "20261005130000_mis_evidence",
    sql: `CREATE INDEX IF NOT EXISTS "MisCheckEvent_employeeId_checkDate_idx" ON "MisCheckEvent"("employeeId", "checkDate")`,
  },
  {
    migration: "20261005130000_mis_evidence",
    sql: `CREATE INDEX IF NOT EXISTS "MisCheckEvent_companyId_at_idx" ON "MisCheckEvent"("companyId", "at")`,
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
