-- MIS auto-check: who checks / approves each MIS file, and the file version
-- last read (so unchanged files are skipped). Additive, nullable.
ALTER TABLE "MisSource" ADD COLUMN "checkedBy" TEXT;
ALTER TABLE "MisSource" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "MisSource" ADD COLUMN "lastETag" TEXT;
