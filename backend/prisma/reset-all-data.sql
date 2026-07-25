-- ============================================================================
-- MailPilot Enterprise — FULL DATA RESET
-- ============================================================================
-- Wipes ALL application data from the Neon database so you can start fresh
-- and free up storage. This does NOT drop tables and does NOT touch Prisma's
-- migration history (_prisma_migrations), so your schema stays intact — you do
-- not need to re-run `prisma migrate`.
--
-- WARNING: This is irreversible. After running it you will need to:
--   * recreate your company + departments
--   * recreate employees / logins
--   * reconnect each employee's email account
--
-- HOW TO RUN:
--   Neon Console -> your project -> "SQL Editor" -> paste this whole file ->
--   Run. It finishes in well under a second.
-- ============================================================================

DO $$
DECLARE
  stmt text;
BEGIN
  -- Build a single TRUNCATE across every table in the public schema
  -- EXCEPT _prisma_migrations (so Prisma still knows the schema is migrated).
  SELECT 'TRUNCATE TABLE '
       || string_agg(format('%I.%I', schemaname, tablename), ', ')
       || ' RESTART IDENTITY CASCADE'
    INTO stmt
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename <> '_prisma_migrations';

  IF stmt IS NOT NULL THEN
    RAISE NOTICE 'Running: %', stmt;
    EXECUTE stmt;
  END IF;
END $$;

-- Show the row counts (all should be 0) and the reclaimed database size.
SELECT relname AS table, n_live_tup AS rows
FROM pg_stat_user_tables
ORDER BY relname;

SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size_after;
