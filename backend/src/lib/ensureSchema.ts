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
