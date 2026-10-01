-- MIS Circle Report: keep the reason behind each automatic mark (the MIS
-- checks themselves are only kept 7 days). Additive.
-- IF NOT EXISTS: the backend also applies this at boot (src/lib/ensureSchema.ts).
ALTER TABLE "MisCircleMark" ADD COLUMN IF NOT EXISTS "reason" TEXT;
