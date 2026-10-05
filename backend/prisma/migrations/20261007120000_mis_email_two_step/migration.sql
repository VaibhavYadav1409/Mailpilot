-- MIS emails: 9:30 AM warning + 11:00 AM result (instead of one nightly email). Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
ALTER TABLE "MisEmailSettings" ADD COLUMN IF NOT EXISTS "warnEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MisEmailSettings" ADD COLUMN IF NOT EXISTS "warnTime" TEXT NOT NULL DEFAULT '09:30';
ALTER TABLE "MisEmailSettings" ADD COLUMN IF NOT EXISTS "resultEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MisEmailSettings" ADD COLUMN IF NOT EXISTS "lastWarnDate" TEXT;
ALTER TABLE "MisEmailSettings" ADD COLUMN IF NOT EXISTS "lastResultDate" TEXT;
ALTER TABLE "MisEmailLog" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'RESULT';
