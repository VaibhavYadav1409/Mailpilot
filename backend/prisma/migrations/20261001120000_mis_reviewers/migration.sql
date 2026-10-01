-- MIS auto-check: who checks / approves each MIS file, and the file version
-- last read (so unchanged files are skipped). Additive, nullable.
-- IF NOT EXISTS: the backend also applies these at boot (src/lib/ensureSchema.ts).
ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "checkedBy" TEXT;
ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "approvedBy" TEXT;
ALTER TABLE "MisSource" ADD COLUMN IF NOT EXISTS "lastETag" TEXT;
