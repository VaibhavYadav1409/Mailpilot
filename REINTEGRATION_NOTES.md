# MailPilot Enterprise — REST Re-integration Notes (July 2026)

This replaces the earlier `MIGRATION_NOTES.md` / `Merge Verification Report`,
which described a merge that hadn't actually happened at the code level —
`employee-app/` was a verbatim copy of the standalone Project 2 app, still
wired to its own local tRPC server, with no working connection to this
repo's actual Express/Prisma backend. See the chat history for the specific
discrepancies that were found.

This document describes what was actually done to make it work end-to-end.

## What changed

**Employee app data layer** (`employee-app/src/lib/api.ts`, new)
- Replaced `lib/trpc.ts` and every `trpc.*` call with a plain REST client
  against this backend's real routes (`/api/auth`, `/api/gmail`,
  `/api/emails`), using Bearer JWT + httpOnly refresh-cookie auth exactly as
  `backend/src/middleware/auth.ts` expects, including transparent
  401-retry-after-refresh.
- Rewired: `main.tsx`, `useAuth.ts`, `Login.tsx`, `Home.tsx`,
  `AIInsightsPanel.tsx`, `AttachmentList.tsx`, `SettingsDialog.tsx`,
  `ImapConnectDialog.tsx`.
- `SettingsDialog` was repurposed from "paste your own Google/Groq API keys"
  (a single-user desktop-app pattern) to a read-only connection-status view,
  since OAuth credentials are configured once per company via backend env
  vars in this architecture, not per employee.

**Backend — additive only, nothing removed or renamed**
- `prisma/schema.prisma`: `Email` gained `bodyText`, `snippet`,
  `toAddresses`, `isStarred`, `isTrashed`, `aiSummary`, `aiPriorityScore`,
  `aiPriorityRationale`, `aiSuggestedReply`. `GmailAccount` gained
  `provider` (GMAIL/IMAP/MANUAL) and IMAP/SMTP host/port/user fields. Run
  `pnpm db:push` to apply.
- `routes/emails.ts`: added `PATCH /:id` (read/star/trash),
  `GET /:id/insights`, `POST /:id/priority`, `POST /` (manual entry).
- `routes/imap.ts` (new): `POST /api/auth/imap` — verifies IMAP+SMTP
  credentials by actually connecting, then stores them encrypted.
- `services/imapAccountService.ts`, `services/imapSync.ts` (new): real IMAP
  connect/sync using `imapflow` + `mailparser`.
- `services/emailSync.ts`: now branches on `account.provider` (Gmail API vs
  IMAP) and persists `bodyText`/`snippet` instead of discarding them after
  AI scoring.
- `services/aiPipeline.ts`: summary/priority/suggested-reply are now
  persisted onto the `Email` row (previously generated and returned but
  never saved anywhere re-readable).
- `services/emailActions.ts`: `sendReply` branches Gmail API vs SMTP
  (`nodemailer`), and now supports attachments on both paths.
- `routes/gmail.ts`: OAuth callback redirects fixed to `/?synced=1` /
  `/?error=...` on the employee-app's actual root route (previously
  redirected to `/settings/gmail`, a page that doesn't exist in this SPA).
- `server.ts`: JSON body limit raised to 25mb (attachments are sent as
  base64 in the request body).

**Workspace/build config**
- `pnpm-workspace.yaml` was missing its `packages:` list entirely — added.
- `employee-app/vite.config.ts`, `vitest.config.ts`, `components.json`:
  fixed to point at this package's actual `src/` layout (they still
  referenced a `client/src` folder that only existed in standalone
  Project 2).
- `employee-app/tsconfig.json` (new — didn't exist; the app was silently
  inheriting the root tsconfig's stale paths).
- Root `tsconfig.json`: no longer claims to own `client/src`/`server` paths
  that don't exist in this repo; scoped to `shared/` only.
- `employee-app/package.json`: removed Electron build config and the
  `@trpc/*` packages, and every backend-only dependency that had leaked
  into the frontend bundle (`express`, `drizzle-orm`, `imapflow`,
  `mailparser`, `nodemailer`, `sql.js`, `jose`, `cookie`, `superjson`) —
  those now live only in `backend/package.json`, which is where the real
  IMAP/SMTP code actually runs.
- `backend/package.json`: added `imapflow`, `mailparser`, and their
  `@types` packages; added the `db:push` script the root `package.json`
  was already calling but that never existed.

**Removed**
- `employee-app.backup/`, `server/` (Project 2's own tRPC server),
  `drizzle/`, `drizzle.config.ts`, `references/` — all dead weight now that
  the employee app talks to `backend/` directly.

## Known gaps / deliberate scope decisions

- **No multi-message thread view.** This backend syncs one `Email` row per
  message (metadata + body), not a cached Gmail thread. The employee-app's
  original "N messages in thread" rendering has been removed in favor of
  always showing the single synced message — that's what the data actually
  supports. Extending this would mean syncing every message in a thread
  individually, which the current sync loop doesn't do.
- **No attachment sync from Gmail/IMAP.** Incoming attachments aren't
  downloaded or stored — `AttachmentList` renders nothing because
  `attachmentsJson` is always empty. Outgoing attachments on replies *do*
  work (implemented in `emailActions.ts`).
- **"Sent" filter returns empty.** Sent replies are recorded in the
  separate `Reply` table (for analytics), not as `Email` rows, so there's
  nothing for that filter to show yet.
- **IMAP is real but unaudited.** `imapAccountService`/`imapSync` connect,
  verify, and sync via `imapflow`/`mailparser`/`nodemailer` — this is new
  code that hasn't been run against a live mailbox in this session (no
  network/DB access in this environment). Test it against a real IMAP
  account before relying on it.
- **This wasn't run.** `pnpm install`, `pnpm db:push`, and a full
  `tsc`/build pass were not executed here (no database or package registry
  access in this environment). Do that first — see SETUP_GUIDE.md — and
  expect to fix a handful of small type errors on the first build.
