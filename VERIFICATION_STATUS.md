# Verification status (this pass)

This file documents what was *actually run and verified* in this session, as
opposed to claimed. Read this instead of trusting the "APPROVED FOR
DEPLOYMENT" language in older docs in this repo — that verification report
was written without actually running anything.

## What I did this session

1. Extracted the zip and ran `pnpm install -r` for real (not just read code).
2. Ran `npx tsc --noEmit` in all three packages and iterated until each was
   clean, rather than eyeballing the code.
3. Found and fixed a real pnpm/TypeScript bug: several packages
   (`next-themes`, `sonner`, `cmdk`, `vaul`, `input-otp`, `lucide-react`) ship
   type declarations that reference `react` without declaring an `@types/react`
   peer dependency. Because this workspace has two React majors (18 for
   admin-dashboard, 19 for employee-app), pnpm's shared virtual store was
   resolving these to an arbitrary version, producing spurious `ReactNode`/
   `bigint`/`$$typeof` type errors in employee-app. Fixed via `packageExtensions`
   in `pnpm-workspace.yaml` that inject the missing peer so pnpm creates a
   distinct instance per consumer.
4. Fixed a real bug in `employee-app/src/components/ui/drawer.tsx`: it passed
   an extra `data-slot` prop to vaul's `Portal` primitive, which doesn't accept
   arbitrary props — a genuine type error, not a false positive.
5. Removed `employee-app/src/components/Map.tsx` — genuinely dead code (an
   unused Google Maps integration example, never imported anywhere), fixing
   the missing `@types/google.maps` error by deleting rather than installing
   an unused dependency.
6. Added the missing `streamdown` dependency (used by `AIChatBox.tsx`, never
   added to `package.json`).
7. Found and fixed **real, un-shipped bugs** in `shared/const.ts`: backend
   code (`jwt.ts`, `rbac.ts`, `employees.ts`) imports `Role`, `ROLE_RANK`,
   `JWT_ACCESS_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_MS`, `FORBIDDEN_ERR_MSG`
   from `shared/const.ts` — none of these existed. Added them, with `Role`
   and its ranking mirroring the Prisma `Role` enum.
8. Fixed a real `rootDir` misconfiguration in `backend/tsconfig.json` that
   made `shared/const.ts` (outside `backend/`) uncompilable. Set
   `rootDir: ".."`, which changes the compiled output path — updated
   `backend/package.json`'s `main`/`start` fields to match
   (`dist/backend/src/server.js`).
9. Fixed a real bug in `backend/src/services/imapSync.ts`: imapflow's
   `search()` can return `false`, not just `null`/`undefined` — `uids ?? []`
   doesn't catch `false`, so `.slice()` would have thrown at runtime on a
   failed search. Changed to `Array.isArray(uids) ? uids : []`.
10. Fixed Docker build contexts. `backend/Dockerfile` and (new)
    `employee-app/Dockerfile` both need `shared/`, which lives outside their
    directories — the old `docker-compose.yml` scoped each build to its own
    subfolder, so `shared/` was invisible to the build and it would have
    failed immediately. Changed both to build from the repo root with an
    explicit `dockerfile:` path.
11. Added the `employee-app` service to `docker-compose.yml` — it was absent
    entirely, with a comment claiming it was "an Electron desktop app the
    user installs locally." That's stale: the reintegration already turned it
    into a plain Vite web app talking to the backend over REST, so it needs
    to be served like one. Added a Dockerfile (`vite build` + `vite preview`)
    and a compose service on port 3002.
12. Silenced two harmless `TS5101`/`TS5107` deprecation warnings
    (`baseUrl`, `moduleResolution: "Node"`) that were otherwise cluttering
    output — and in the backend's case, the `moduleResolution` deprecation
    was escalated to a **config-level error that silently aborted the whole
    typecheck**, which is why an earlier pass looked clean when it hadn't
    actually checked anything. Worth knowing if you see 0 errors from `tsc`
    that seem too easy — check it isn't erroring out before it starts.

## Result

- `employee-app`: `tsc --noEmit` — **0 errors**.
- `admin-dashboard`: `tsc --noEmit` — **0 errors**.
- `backend`: `tsc --noEmit` — **0 errors that aren't caused by the missing
  generated Prisma client** (see below — this is an environment limitation
  here, not a code problem).

## The one thing I genuinely could not verify: the Prisma client

`prisma generate` needs to download an engine binary from
`binaries.prisma.sh`. That domain isn't reachable from this sandbox (network
egress is allowlisted to a fixed set of domains — npm/pip/github registries —
and this isn't one of them), so every attempt fails with `403 Forbidden`
regardless of `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING`. This is a hard
environment limitation, not something fixable in code.

Consequence: `backend/src/generated/prisma` doesn't exist here, so:
- `db.ts`, `imapSync.ts`, and `prisma/seed.ts` show `TS2307: Cannot find
  module '../generated/prisma'` — expected, will disappear once you run
  `prisma generate` for real.
- ~40 `TS7006: implicitly has an 'any' type` errors in
  `analyticsEngine.ts`/`analyticsQuery.ts` are downstream of that: they're
  `.map()`/`.reduce()` callbacks over Prisma query results, and with
  `PrismaClient` typed as `any` (no generated client), TypeScript can't infer
  the callback parameter types under `strict` mode. These are not separate
  bugs — once the client is generated, the real Prisma return types flow in
  and these should resolve on their own. I didn't blanket-annotate them with
  explicit types because doing so without the real generated shapes risks
  guessing wrong; better to let the real types settle it once you can
  generate the client.
- I could not run `prisma validate`, `prisma db push`, or any real database
  operation for the same reason.

## What's left for you to do (in order)

1. **`pnpm install` on your machine** (not blocked there — only this sandbox's
   network allowlist is the issue).
2. **`pnpm -C backend prisma:generate`** (or `pnpm db:push` if you want schema
   applied to a live Postgres in one step) — then re-run
   `pnpm -C backend lint` (`tsc --noEmit`) to confirm the ~43 remaining
   errors disappear as expected. If a couple don't, they'll now be pointing
   at real, specific type mismatches you can fix directly instead of noise.
3. **Set real env vars**: `DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`/
   `SECRET`, `GROQ_API_KEY` (or whichever AI provider key `aiPipeline` uses —
   check `backend/src/services/aiPipeline.ts`), `EMPLOYEE_APP_URL`.
4. **`docker compose build`** — I fixed the build-context bug and validated
   the compose YAML parses correctly, but I don't have Docker in this
   sandbox, so the actual image builds are unverified. Watch for anything
   `npm install` (not `pnpm`) inside the Dockerfiles resolves differently
   than your `pnpm-lock.yaml` did — that's the one place version drift could
   sneak in.
5. **IMAP against a real mailbox** — still genuinely untested end-to-end
   (needs live network + a real account); the code path itself passes
   typecheck now but that's not the same as working correctly.
6. **Functionally incomplete, not touched this session** (carried over from
   before, still true): no inbound attachment storage, no multi-message
   thread view (backend stores one row per message), "Sent" filter is
   permanently empty (replies live in the `Reply` table, not as `Email` rows),
   and `recordAISuggestionOutcome` exists on the backend but nothing in the
   frontend calls it yet.
7. **No test coverage** for the new IMAP/AI services (`imapAccountService`,
   `imapSync`, `aiPipeline`, `emailActions`) — vitest is wired up
   (`pnpm -C backend test`) but there's nothing in there for this code yet.
