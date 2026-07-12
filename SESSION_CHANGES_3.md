# This session's changes (on top of SESSION_CHANGES_2.md)

Read `SESSION_CHANGES_2.md` first for the prior session's baseline. This
file covers what changed *since* that pass.

## What changed: dropped Docker, switched to Neon for Postgres

The user is hosting Postgres on [Neon](https://neon.tech) and running
`backend`/`admin-dashboard`/`employee-app` directly with `pnpm`, so
Docker is no longer part of this project at all.

**Removed:**
- `docker-compose.yml` (root)
- `backend/Dockerfile`
- `admin-dashboard/Dockerfile`
- `employee-app/Dockerfile`

**Updated:**
- `backend/.env.example` — `DATABASE_URL` now shows a Neon-style
  connection string (`?sslmode=require`) instead of the old local
  `postgres:5432` one. No code changes were needed for this — Prisma's
  `datasource` block already just reads `DATABASE_URL` from the
  environment and Neon is wire-compatible Postgres.
- `README.md` — removed the "Docker Deployment" section and the stale
  `drizzle/`/`docker-compose.yml` tree entries (drizzle was already
  removed from the repo in an earlier session per
  `REINTEGRATION_NOTES.md`, the README tree just hadn't caught up).
  Replaced with a "Database (Neon)" section covering project creation,
  connection string, and `prisma:generate` / `db:push`.
- `SETUP_GUIDE.md` — removed the local-Postgres-install and
  Docker-Postgres options in Step 3, replaced with the Neon flow;
  removed the standalone "Docker Setup" section (`docker-compose up -d`
  etc.) and its TOC entry.

**Left alone, on purpose:**
- The Google Cloud Run example under SETUP_GUIDE.md's Deployment section
  still shows building a Docker image — that's a valid path *if* the
  user later wants to deploy to Cloud Run specifically (which requires a
  container), not something used for local dev. It's inert unless they
  choose that deployment target; no Dockerfile exists anymore for it to
  reference, so it'd need one rebuilt only if that path is actually taken.
- Historical session docs (`VERIFICATION_STATUS.md`, `MIGRATION_NOTES.md`)
  still mention Docker/docker-compose — left as-is since they're a record
  of what was true in that session, not living instructions.

## Not run this session (same environment limitation as before)

No network access in this sandbox — couldn't run `pnpm install`,
`prisma generate` against a real Neon database, or verify `tsc`/tests
after these doc/config-only changes. These changes don't touch any
TypeScript source, so the prior session's verified state (0 errors in
employee-app/admin-dashboard, 3 Prisma-client-generation errors in
backend, 18/18 backend tests passing) should be unaffected — but that's
an expectation, not something re-verified here. Run the checks yourself
after `pnpm install -r` + `prisma generate` against your real Neon URL.
