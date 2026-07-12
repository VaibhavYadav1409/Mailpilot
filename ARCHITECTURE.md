# MailPilot Enterprise — Unified Architecture (Phase 1)

## Target folder structure

```
mailpilot/
├── backend/            # Express + Prisma + Postgres. Single source of truth.
│   ├── prisma/
│   │   └── schema.prisma
│   └── src/
│       ├── routes/           # auth, companies, departments, employees, gmail, analytics, reports, notifications
│       ├── services/         # gmailSync.ts, analyticsEngine.ts, notificationEngine.ts
│       ├── sockets/           # WebSocket gateway for live dashboard updates
│       ├── middleware/       # auth (JWT), rbac (role + department scoping)
│       └── lib/              # crypto.ts (token encryption), db.ts
├── employee-app/       # Electron app (from mailpilot-client-updated.zip), now a thin client
│   └── src/            # UI mostly unchanged; replace local db.ts calls with API client calls
├── admin-dashboard/     # Next.js app (from mailpilot-admin-updated.zip), rewired to new backend
├── shared/              # Types + constants shared by backend, employee-app, admin-dashboard
├── database/            # migrations, seed scripts
└── docs/
```

## What moved where

- **backend/prisma/schema.prisma** — built from `mailpilot-admin-updated`'s Prisma schema (kept: Company, Department, RBAC roles), extended with `GmailAccount` (one-per-employee, per spec), `Email`/`Reply`/`AIAction` (new — these didn't exist before, needed so analytics can be computed from real data instead of trusted client self-reports), and `DailyAnalytics` as a precomputed rollup table for dashboard speed.
- **Gmail OAuth + IMAP logic** — lifted from `mailpilot-client-updated/server/_core/gmail.ts` and `imap.ts`. This code is solid and moves into `backend/src/services/gmailSync.ts` mostly unchanged; the difference is it now runs centrally (one process managing all employees' tokens) instead of once per desktop install.
- **Admin dashboard UI** — `EmployeeTable.tsx`, `DepartmentTable.tsx`, `Sidebar.tsx`, `StatCard.tsx`, and the dashboard/leaderboard/analytics pages carry over from `mailpilot-admin-updated/frontend` largely as-is. They get rewired from `axios` calls hitting the old Express/Prisma backend to the new unified backend's routes — same shapes, so this should be a low-risk swap.
- **Employee desktop app** — the whole UI, AI insights panel, and compose flow from `mailpilot-client-updated` carry over. The only structural change: `server/db.ts` (local SQLite) gets replaced by an API client hitting the central backend, since email data now lives centrally, not per-device.
- **Discarded**: `mailpilot-integrated-fixed`'s Drizzle/MySQL schema and its unrelated Manus-platform boilerplate (voice transcription, image generation, maps, owner notifications) — none of this serves the spec. Its `.project-config.json` had live credentials committed to it; rotate those regardless of what happens to this file.
- **Discarded**: the old client-side `adminSync.ts` self-reported analytics. Replaced by `backend/src/services/analyticsEngine.ts`, which computes `DailyAnalytics` rows from real `Email`/`Reply`/`AIAction` records on a schedule (or via triggers on sync).

## Multi-tenancy approach

Every table that needs isolation carries `companyId` (either directly, like `Employee`, `GmailAccount`, `AuditLog`, `Notification`, `Report`, or transitively through a required relation, like `Email` → `GmailAccount` → `companyId`). All backend queries go through an RBAC middleware layer that injects the caller's `companyId` (and `departmentId` for Managers) into the `WHERE` clause — no route should ever accept a raw `companyId` from the request body for a non-CEO/COO/Admin caller.

## Phased build order

1. **Database & backend core** (this phase) — schema, migrations, seed script with one demo company.
2. **Auth & RBAC** — login, JWT + refresh sessions, role/department-scoped middleware.
3. **Gmail connection service** — OAuth flow, token storage/encryption/refresh, disconnect detection + admin notification.
4. **Email sync + AI pipeline** — pull mail per `GmailAccount`, run categorization/summary/priority scoring, log to `AIAction`.
5. **Analytics engine** — nightly + on-demand rollups into `DailyAnalytics`; this is what both dashboards read from.
6. **Employee desktop app rewire** — swap local SQLite calls for API client calls; UI stays close to identical.
7. **Admin dashboard rewire** — point existing components at new routes; add WebSocket live-update layer.
8. **Reports & notifications** — scheduled report generation, notification rules engine.

Each phase should ship independently testable: phase 2 needs phase 1's schema migrated and seeded; phase 6 and 7 can happen in parallel once phase 5 is done.
