# Session 8 — CC section + AI reply-worthiness ("only show mail worth replying to")

Read `SESSION_CHANGES_7.md` first. Feature pass, two related asks:

1. A **CC section** — mail where the employee was copied in rather than
   addressed directly.
2. **The AI should decide whether an email needs a reply at all.** Mail that
   is purely informing (acknowledgments, FYIs, automated notifications) must
   not appear in Unreplied — only mail genuinely "worthy of a reply" should —
   and the same distinction must show on the admin dashboard.

## Design decisions (confirmed with the user before building)

- **CC'd mail stays in All/Inbox** and additionally gets its own CC pill. It
  is an extra lens on the same inbox, not a separate mailbox — unlike
  Promotions, which is exclusive.
- **Reply-worthiness is LLM-decided**, not heuristic.

## The one safety property everything else follows from

`Email.requiresReply` is **nullable**, and `NULL` ("not yet assessed") is
treated as **needs a reply** in every query, in both apps. Unrecognized LLM
output also resolves to `NEEDS_REPLY`, never to a no-reply class.

This asymmetry is deliberate. A false positive costs one extra row in a list.
A false negative means a real customer email silently disappears from an
employee's Unreplied view *and* an admin's pending count — invisible, with no
error anywhere. Every fallback in this feature leans the recoverable way.

## Schema (additive — nothing rewritten)

New on `Email`: `ccAddresses` (JSON string[]), `isCc`, `requiresReply`,
`replyClassification`, `replyClassifiedAt`. Two new indexes covering the
pending and CC lookups. Migration at
`prisma/migrations/20260729120000_cc_and_reply_worthiness/`.

The migration also settles existing promotional mail to
`requiresReply = false` in SQL, so that backlog drops out of Pending on deploy
without waiting for a re-sync or a backfill run.

`replyClassification` is one of `NEEDS_REPLY`, `ACKNOWLEDGMENT`,
`INFORMATIONAL`, `AUTOMATED`. Kept a String, not an enum, matching the
existing `EmailCategory.label`/`.source` convention.

## CC detection — headers, not AI

`isCc` is computed at sync time from the To/Cc headers (`computeIsCc`), so it
stays correct while the Groq breaker is open. It is true only when the owner
is in Cc **and not** in To. Owner in neither list (bcc, alias, mailing list)
is `false` — "not visibly addressed" is a different claim from "was CC'd" and
doesn't belong in the CC view.

New `parseAddressList` replaces the old naive comma-split. That split was
survivable for To but breaks badly on Cc, where `"Yadav, Vaibhav" <v@x.com>`
display names are common — it produced a junk entry *and dropped the real
address*. The new parser ignores commas inside quotes and angle brackets.

## Reply-worthiness — folded into the existing LLM call

`categorizeEmail` now returns a `replyClass` alongside the category, from the
**same** request. Sync already fans out one LLM call per email per feature;
adding a second round trip per message is exactly the pattern that has
repeatedly tripped the Groq rate limiter and the memory ceiling on large syncs
(see sessions 4–6). Both judgements need identical context, so they share a
call — this feature adds **zero** additional LLM requests per email.

Promotional mail never reaches the model for this: it's settled by headers via
`markNoReplyNeeded`. If the LLM does return `NEEDS_REPLY` for something
already labeled promotional, the label wins.

## Where "pending" is now defined

Four call sites, all agreeing by construction — `isReplied: false` AND
(`requiresReply` true OR NULL):

- `routes/emails.ts` — `replyStatusFilter()`, backing the employee app
- `routes/employees.ts` — admin per-employee inbox counts
- `analyticsQuery.getEmployeeOverview` — the overview stat
- `analyticsQuery.getEmployeeEmailList` — the drill-down list

**Bug found and fixed while auditing these:** the overview counts didn't
exclude trashed mail but the list behind them always has, so the admin
dashboard could render a tab labelled "Pending (12)" above a list of 9 rows.
Both now exclude trashed. This is a pre-existing mismatch, not one introduced
here, but it's the exact bug class this change is otherwise about.

**Also fixed:** the employee app's `replied`/`unreplied` filters were applied
*client-side to the fetched page*. On any mailbox with more than one page that
silently meant "unreplied among the 100 most recent". Both are now
server-side via a `replyStatus` query param. In `routes/emails.ts` the
reply-status and search `OR` groups are combined under `AND` — as sibling
`OR` keys they'd have silently overwritten each other whenever both filters
were active.

## UI

**Employee app** — two new filter pills, "No reply needed" and "CC", with
explanatory tooltips. List rows carry `CC` / `Acknowledgment` / `FYI` /
`Automated` badges. Showing *why* something is absent from Unreplied matters:
otherwise a missing email looks like a bug rather than a visible, judgeable
classification.

**Admin dashboard** — new "No Reply" column, a "No reply needed" overview
stat, and a fourth drill-down tab listing that mail with its classification
badge, so an admin can audit what the classifier is filtering out rather than
having it vanish silently.

## Existing mail

`scripts/backfillReplyWorthiness.ts` (safe to re-run; resumes where it left
off). Skips already-replied mail by default — reply-worthiness only affects
what shows as *pending*, so classifying answered mail buys nothing;
`--include-replied` does it anyway. Resolves promotional mail locally without
an LLM call. Sync also self-heals: rows with a category but no verdict get
re-assessed on the next sync.

## Verification

- **30 assertions passing** against the real source for `parseAddressList`,
  `computeIsCc`, and `resolveReplyClass` — including the quoted-comma
  regression and every fallback path. Committed as
  `tests/ccDetection.test.ts` and `tests/replyWorthiness.test.ts`.
- Audited every `requiresReply` usage across the backend for agreement
  between counts and the lists they link to (this is what surfaced the
  trashed-mail mismatch above).

**Note on how those tests were run here:** the workspace mount in this sandbox
is pathologically slow (`node -e` takes >45s inside it vs. 0.03s outside), so
`vitest` and `tsc` could not complete. The assertions were executed against
the actual source files via Node's type stripping from a fast local copy —
real code, real results, but **please run `pnpm -C backend vitest run` on a
normal machine** to confirm the full 44+ suite still passes alongside the two
new files.

## Post-deploy findings (first real backfill run)

The first backfill against a live mailbox failed **77 of 109** emails. Two
separate bugs, both now fixed — and the first one was **not** specific to the
backfill.

**1. Email bodies were sent to the LLM untruncated (affects live sync too).**
One email requested 21,306 tokens and got **HTTP 413 Payload Too Large** —
bigger than the entire 12,000 TPM allowance on Groq's free tier, so it could
never succeed regardless of retries or waiting. 413 isn't a rate-limit status,
so neither the retry loop nor the circuit breaker in `lib/llm.ts` caught it:
it was a permanent, silent per-email failure. Ordinary emails at ~7,800 tokens
each also meant barely one call fit in a minute's budget.

Fixed centrally with `clampThreadContent` (8,000 chars ≈ 2,000 tokens) applied
to **all four** LLM functions — categorize, priority, summary, suggested
reply — so sync benefits too, not just the backfill. Truncation is free for
these tasks: reply-worthiness, topic and urgency are all established in an
email's opening, not in its fifteenth quoted signature block. This was a
pre-existing latent bug that this feature's extra prompt tokens surfaced.

**2. The backfill's concurrency was self-defeating.** It ran 5 calls at once
(copied from `backfillCategories.ts`). Against a shared per-minute token
quota there is no throughput to win — five simultaneous calls exhaust the
budget instantly, trip the breaker, and every remaining row then fails
against the open breaker. Now: concurrency 1, ~10s pacing
(`BACKFILL_DELAY_MS` to override), and it **waits out** a cooldown instead of
burning rows against it.

Waiting is correct here and deliberately *not* what `lib/llm.ts` does during a
sync — a sleeping sync call holds its email body in memory, and hundreds of
those piling up is what OOM-killed Render previously. A standalone script
processing one email at a time holds nothing.

Failure logging also collapsed to one line per email; 77 identical stack
traces were pure noise.

## Verified after these fixes

- Full `tsc --noEmit` passes on **all three** packages (backend, employee-app,
  admin-dashboard) — the first time backend has typechecked cleanly since the
  session-7 `bodyHtml` change, now that the Prisma client is regenerated.
- `pnpm -C backend test` green, with new coverage for the reply-worthiness
  persistence, the promotional override, both LLM-failure fallbacks, and the
  413-sized truncation regression.

## Still blocked (same as every prior session)

`prisma generate` / `db push` still can't run here — `binaries.prisma.sh` is
unreachable through the egress proxy. The generated client in
`src/generated/prisma` is therefore stale and does not know about `bodyHtml`
(session 7) or any of this session's columns, so a full `tsc` pass is not
achievable in this environment and its errors on the new fields are expected.

**Before deploying, run:**

```bash
pnpm -C backend prisma:generate
pnpm -C backend db:push          # or: prisma migrate deploy
pnpm -C backend vitest run
npx tsx backend/scripts/backfillReplyWorthiness.ts   # optional, for existing mail
```

Until `prisma generate` runs, sync will throw a Prisma validation error on the
new columns.
