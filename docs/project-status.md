# Project Status & Session Handoff

Last updated: 2026-08-15 (Phase 3 transaction sync built)

This file captures context that isn't obvious from the code or git history —
decisions we made, things we deliberately deferred, and environment quirks
that cost time to discover. Read this alongside [CLAUDE.md](../CLAUDE.md).

## Where things stand

| Phase | Status |
|---|---|
| Phase 1 — Core backend | Built and tested end-to-end, except live AI categorization (no API key yet) |
| Phase 2 — NAS deployment | Done and verified — running unattended on the DXP4800 |
| Phase 3 — Bank connection | Account + transaction sync built and verified against real data; not yet deployed to the NAS or scheduled |
| Phase 4 — Mobile UI | Not started |
| Phase 5 — Forecasting | Deferred by design |

## Environment

**Dev machine (Windows):**
- Project at `D:\Claude Projects\Household Finance App`
- Node v24.18.1, npm 11.16.0
- Node was installed partway through the first session — if a shell can't find
  `node`, it needs a PATH refresh, not a reinstall
- No Docker installed locally, so the image is only ever built on the NAS

**NAS (UGREEN DXP4800, UGOS / Debian 12 bookworm):**
- Project at `/volume1/docker/household-finance-app`
- LAN IP `192.168.50.107`, SSH on port 22 (user `ywang1111`)
- Tailscale IP `100.99.152.23` — this is the address the mobile app will use
- API reachable at port 3000; `/health` returns `{"ok":true}`
- SSH auto-disable was set to 2 hours during setup; consider lowering it now
  that deployment is done

**GitHub:** `https://github.com/yangtaowang1111/household-finance-app` (public)

## Decisions worth remembering

**Node/Express over FastAPI.** The brief offered either. Chose Node so the
whole stack is JS once the Expo app lands in Phase 4.

**Hybrid categorization, not pure AI.** `categorization_rules` is checked
first (free, instant); only unmatched merchants go to the Claude API. On top
of that, every non-low-confidence AI result writes a rule back, so recurring
merchants stop costing money after their first appearance. Low-confidence
results are still applied but flagged in `transactions.notes` for review.

**Repo made public.** The NAS has no `git`, so the code is fetched with
`curl` + `tar` from a GitHub tarball — which needs a public repo (or a
personal access token). No secrets are in the repo: `.env`, `data/`, and
`.claude/settings.local.json` are all gitignored, and the API key has never
been committed.

**Docker needs `sudo` on the NAS.** The login user isn't in the `docker`
group. Every Docker command in the deployment doc is prefixed accordingly.

**Added app-level API key auth ahead of schedule (before Phase 3 sync).**
The original plan deferred all auth to Phase 4 (PIN/biometric, once the
mobile app exists), relying on Tailscale network membership alone in the
meantime. That was an acceptable gap while the API held only test data, but
real SimpleFIN transaction/balance data starts flowing in Phase 3, so a
shared-secret `x-api-key` header check (`src/middleware/apiKeyAuth.js`) was
added first. It fails **closed**: every `/api/*` request is rejected if
`API_KEY` isn't set in `.env` — `/health` stays open for uptime checks. This
is a stopgap, not a replacement for Phase 4's real per-user auth.

**Closed three API-completeness gaps found in a scope review (2026-08-12),
ahead of Phase 3:**
- `POST /api/transactions` — manual transaction entry (cash spending,
  anything SimpleFIN can't reach) was listed in the brief but had no
  endpoint; only `GET` and category-patch existed.
- `account_balance_snapshots` table, `PATCH /api/accounts/:id/balance`, and
  `GET /api/accounts/:id/balance-history` — `accounts.current_balance` was a
  single live number with no history, but net-worth-over-time and per-account
  trend charts (both Build features) need a time series. Snapshots are now
  written on account creation and every balance update; the SimpleFIN sync
  service (Phase 3) should write one on every pull too, once it exists.
- `categorizeUncategorized()` now hard-caps `limit` at 500 regardless of
  caller input (`MAX_LIMIT` in `src/services/categorizer.js`) — previously
  unbounded, which was a real Claude-API-cost exposure once real data (and a
  real API key) is in play.

All three were smoke-tested against a scratch DB (account create → balance
patch → history read → manual transaction create, plus the auth and
validation error paths) before being logged here.

**Phase 3, part 1 — account sync is built and working (2026-08-14).**
SimpleFIN setup token was redeemed; `SIMPLEFIN_ACCESS_URL` is in the local
`.env` (NOT yet on the NAS — that still needs doing before deployment).
13 accounts across Chase / U.S. Bank / Ally now sync into the DB.

What the real API data settled, that we'd been guessing at:
- **Liabilities come back negative** (`Mortgage - 1176: -227877.82`,
  credit cards negative, deposits positive). So net worth is a plain
  `SUM(current_balance)` with no sign-flipping. Question closed.
- **SimpleFIN sends no account type at all.** Type is inferred from the
  account name (`src/services/accountMapper.js`) with a confidence level.
  Names with a keyword ("Mortgage - 1176", "PREMIER PLUS CKG") infer at high
  confidence; card brand names ("Chase Freedom", "Rapid Rewards Plus") only
  at medium. All 13 inferred correctly and were human-confirmed on the first
  run, so every row has `type_confirmed = 1`.
- `balance` arrives as a **string**, `balance-date` as a Unix timestamp.
- An `errors[]` array reports per-institution problems (e.g. a bank needing
  re-auth) alongside a 200 — a partial sync must not look like a clean one,
  so `syncAccounts()` returns it rather than swallowing it.

Schema changes this forced (dev DB was empty, so it was recreated rather
than migrated — **a real migration path will be needed once the NAS holds
live data**):
- `accounts.simplefin_id` (UNIQUE) — without it the second sync would have
  duplicated every account instead of updating it.
- `accounts.type_confirmed` — sync never overwrites a human-corrected type.
- `accounts.currency`, and `mortgage` / `loan` added to the type CHECK
  constraint (the two U.S. Bank mortgages had nowhere to go before).

Verified: first sync created 13; second sync created 0 / updated 13 (no
duplicates); a manually corrected type survived a subsequent sync.

**Net worth currently reads −$392,507 — and that is expected, not a bug.**
The mortgages are counted but the properties themselves aren't; SimpleFIN
knows about accounts, not real estate. A meaningful net worth needs manual
asset entries for the two properties' values. Worth doing before the net
worth dashboard is built, or the headline number will be alarming and wrong.

**Phase 3, part 2 — transaction sync + dedup is built and verified
(2026-08-15).** 120 real transactions across 9 accounts imported; the
immediate re-sync created 0 and updated 0. Operational guide:
[phase3-bank-sync.md](phase3-bank-sync.md).

What the real transaction data settled (probed the same way the accounts were,
222 transactions over 45 days):

- **Pending charges carry `posted: 0`** and an id shaped exactly like a
  settled one (`TRN-<uuid>`), so a single snapshot *cannot* reveal whether an
  id survives settlement — and the protocol spec doesn't say either.
  `transactionSync.js` therefore handles both outcomes: a stable id updates in
  place, a changed id is matched to its pending twin by merchant + date window
  and supersedes it, carrying over any category assigned while it was pending.
- **Pending is off by default anyway**, which is the bigger decision. A
  pending amount *changes* when it settles (tips, fuel pre-auths), so
  including them makes budget-vs-actual wobble day to day. `--include-pending`
  turns them on; reconciliation only runs on a sync that asked for pending.
- **Content-based dedup would have destroyed real data.** In 45 days, 19
  distinct (account, amount, description) triples recurred — the same $8.62
  McDonald's, the same $11.45 In-N-Out, weeks apart. Add the date and the
  collisions go to zero. So id is the only dedup key, and every content match
  in the code is date-bounded and flags rather than deletes.
- **`amount` is a string, negative for money out** — matches the account
  balance convention, and `budgetCalc` already negates sums, so nothing needed
  changing there.
- **`transacted_at` is on every row; `posted` lags it by up to 4 days** (and
  occasionally *precedes* it). `date` is set from `transacted_at` — when the
  money was spent is what belongs in a monthly budget — with `posted_at` kept
  separately. 3 of 222 rows would have landed in a different month otherwise.
- **Timestamps are moments, not dates.** Zero of 222 sat on a UTC midnight,
  and ~4% land on a different calendar day under UTC than under Denver time.
  Hence the new `TIMEZONE` env var; the NAS container's system zone is UTC, so
  it must be set there explicitly.
- **`payee` is a cleaned merchant name** next to the raw descriptor
  ("TST\*THE LITTLE DINER" → "The Little Diner"), and generalizes better: 126
  distinct payees vs 147 descriptions. Stored in a new `transactions.payee`.
- **`errors[]` carries advisories, not just failures** — a 45-day request came
  back 200 with "Requested date range exceeds recommended range of 45 days".
  The window is capped at 44 for that reason.
- `memo` and `mcc` are present but empty/null on all 222 rows, so neither is
  stored yet. `mcc` would be a genuinely good categorization signal if it ever
  starts arriving.

**A real migration path now exists** (`src/db/migrate.js`, `PRAGMA
user_version`), which was the open flag from part 1. Migrations run *before*
`schema.sql` and are written to be idempotent — they check what's actually in
the database — so a fresh DB and the NAS's existing one converge on the same
shape. Verified in both directions, including that the 13 existing accounts
survived. **The NAS database has not been migrated yet** — that happens on the
next deploy, and its 3am backup runs first.

**A `/code-review` pass ran over this diff and found 9 issues; all are fixed**
(2026-08-15), each with a regression test where testable. The ones worth
remembering:

- An account with **no transactions in the window** returned early, before
  pending reconciliation — so a cancelled authorization would have stayed
  `pending = 1` forever, and silently. Empty accounts are exactly the shape a
  cancelled auth produces, so that early exit is gone.
- `possible_duplicate_of` was declared `REFERENCES transactions(id)` with no
  `ON DELETE` clause, which defaults to `NO ACTION`. Deleting the hand-entered
  twin — *the* documented way to resolve the flag — failed on a foreign key
  constraint. Fixed to `ON DELETE SET NULL`, which needed migration 2 to
  rebuild the table (SQLite can't alter a constraint in place). That migration
  is the first real exercise of the migration path, and it preserved all 120
  rows and three indexes.
- `syncTransactions` (`skipAccounts`) could drop **every** transaction of a
  newly linked account into `unknownAccounts` and still record `success`.
  Unknown accounts now force `partial` and land in `errors`.
- Categorization was gated on `created > 0` while the categorizer caps at 200
  rows per run, so a 222-row import would strand 22 rows that no quiet night
  would ever pick up. Gated on what's actually uncategorized instead.
- Smaller: a failed database write left no `sync_runs` row at all; two
  same-amount charges could both flag the same manual row; `?limit=-1` on
  `/api/sync/runs` returned the whole table (SQLite reads a negative LIMIT as
  unbounded); and `sync_runs` window dates were UTC while transaction dates
  are local.

**A second, deeper `/code-review ultra` pass then found 10 more; all fixed**
(2026-08-15). One was a genuine deploy blocker:

- **The NAS deploy would have crash-looped.** Phase 3 part 1 added
  `simplefin_id`, `currency` and `type_confirmed` to `accounts` and widened the
  `type` CHECK — but only in `schema.sql`, which can't alter an existing table.
  The dev DB was recreated at the time so it never showed; the NAS DB still has
  the Phase 2 shape. `accountSync.js` prepares `SELECT ... WHERE simplefin_id = ?`
  at *module load*, so the container would throw `no such column: simplefin_id`
  before binding a port, and `restart: unless-stopped` would loop it. Migration 1
  and 2 covered `transactions` only — the accounts half was missed. **Migration 3**
  fixes it, and the whole thing was reproduced against a database built from the
  actual Phase 2 schema (`git show 5428945:src/db/schema.sql`) and re-verified:
  server boots, `/health` responds, rows and foreign keys intact.
- `confirm_inferred_types` was silently discarded on existing accounts — the
  UPDATE statement never included `type_confirmed`, so the documented option was
  a no-op on exactly the re-sync where it's meant to be used, and the same
  response still reported the account as needing review.
- `reconcilePending` had two gaps: one settled row could be claimed by two
  different pending charges (silently deleting a cancelled authorization rather
  than reporting it), and a pending row whose twin arrived on an *earlier* run
  could never reconcile, contradicting what phase3-bank-sync.md promises about
  toggling pending off and on.
- One malformed account aborted the entire night — `remote.map(mapAccount)` was
  eager, so a single unparseable balance rolled back all 13 accounts *and* every
  transaction. The transaction path already had per-row tolerance; accounts now
  match it.
- No `DELETE /api/transactions/:id` existed, even though migration 2's whole
  purpose was making that deletion work and the docs instruct users to do it.
- `syncAccounts` wrote no `sync_runs` row despite the schema reserving
  `kind='accounts'`; SimpleFIN fetches had no timeout, so a hang would leave no
  audit row at all while the next night's cron started a second run;
  `categorizeUncategorized(-1)` bypassed the `MAX_LIMIT` cost cap the same way
  `?limit=-1` did; and `started_at`/`finished_at` were written in two different
  timestamp formats that compare wrong against each other.

`recordRun` moved to `src/services/syncRuns.js` so both sync paths can use it
without a require cycle.

**Tests exist now** (`npm test`, `tests/transactionSync.test.js`, 23 cases, no
dependencies beyond `node --test`). They cover every branch that inserts,
updates, deletes, or flags: re-sync idempotency, category/notes surviving a
re-sync, both pending-settlement paths, ambiguous matches being left alone,
manual/CSV duplicate flagging, and a malformed row not killing the run. This
is the first test coverage in the repo.

**Deferred from the same review, to revisit once SimpleFIN access is set up
and Phase 3 work begins:**
- No `users` table or per-user attribution — "joint access for you and your
  wife" is in Build scope, but the API-key auth just added is one shared
  secret with no concept of *which* of you did something. Worth deciding
  before Phase 4 whether that's ever needed, since retrofitting a users
  table after transactions/categories exist unscoped to one is more painful
  than designing it in from the start.
- Recurring transaction / subscription detection (a listed Build feature)
  has no schema or service home yet. Probably a computed view over
  `transactions` rather than its own table, but wants a design pass before
  Phase 3's sync cadence is locked in, since that cadence affects how
  reliably recurrence can be detected.

**Cron instead of a Task Scheduler GUI.** UGOS's Control Panel had no task
scheduler we could find, so the daily 3am backup lives in root's crontab.
`sudo crontab -l` to inspect it.

## Deliberately deferred

**`ANTHROPIC_API_KEY` is blank** in both the local and NAS `.env`. Everything
except `POST /api/categorize` works without it. Set it when ready to test
categorization for real.

**Historical import + category walkthrough.** The plan is to bulk-upload last
year's statements plus ~6 months of this year, run categorization, then go
through the results together to refine the vendor→category mappings. That's
what will actually populate `categorization_rules` with real patterns. It was
pushed to its own session because downloading statements takes time and the
review pass deserves proper attention. Nothing else is blocked on it.

## How Phase 1 was verified

Worth knowing what's actually been exercised vs. merely written:

- Account creation, CSV import, re-import dedup (8 imported → 8 skipped),
  manual category assignment, budget creation, and budget-vs-actual math were
  all tested against a running server with a sample CSV
- Budget-vs-actual returned `176.46` actual vs `150` budgeted → `-26.46`
  variance, after a rounding fix for floating-point noise
- The Docker build and the backup script were verified on the NAS
- **Not yet exercised:** the Claude API categorization path, and therefore the
  auto rule-learning logic that hangs off it

## Next steps (Phase 3, part 3 — deployment)

Sync and dedup are built, tested, and verified against real data. Both design
questions that were open here are answered in the part 2 entry above. What
remains is getting it running unattended:

1. **Deploy to the NAS.** Add `SIMPLEFIN_ACCESS_URL` and `TIMEZONE` to the NAS
   `.env` directly on the box, rebuild, and let the migrations run (the 3am
   backup goes first). The NAS DB is still at `user_version = 0` and will apply
   migrations 1–3 in sequence on first boot. Watch the container logs on that
   first start — the three `Applied migration N` lines are the confirmation that
   it worked, and their absence means the DB was already migrated or the boot
   failed. Both code reviews are done (9 + 10 findings, all fixed).
3. **Schedule the daily sync** — 4am in root's crontab, an hour after the
   backup. Exact line in [phase3-bank-sync.md](phase3-bank-sync.md).
4. **Set `ANTHROPIC_API_KEY`** so the sync's categorization step actually
   runs; it currently warns and leaves rows uncategorized. This is also what
   unblocks the AI half of categorization, still never exercised against the
   live API. The 120 already-synced transactions will be categorized on the
   first run that has a key (the daily job now categorizes whatever is
   uncategorized, not only what it just imported).
5. **Decide the categorizer's `effort` level** — `src/services/categorizer.js`
   still sets none, so it runs at the API default.

Two things the real data surfaced that aren't bugs but will matter soon:

- **Transfers double count.** A credit card autopay lands twice — negative on
  checking, positive on the card. Both are real; categorizing both as spending
  inflates totals. The seeded `Transfers` category exists but nothing routes to
  it. Worth solving before budget numbers are trusted.
- ~~**Rule learning generalizes poorly on raw descriptors.**~~ **Fixed
  2026-08-15**, before the first real categorization run, while
  `categorization_rules` was still empty (so no rules needed rewriting).
  `categorizer.js` learned patterns from `merchant_raw`, which embeds store
  numbers ("CHICK-FIL-A #02479"), so every branch of a chain cost another API
  call. Rules are now learned from `payee` when present, matched against
  *both* payee and descriptor (a rule learned from one field must still match
  a transaction carrying the other), and both are sent to the model. Covered by
  `tests/categorizer.test.js` — the rule path needs no API key, so it is
  testable for real; the AI path still isn't.

## Blockers to clear before end-to-end testing

- **`API_KEY` is not set in the local `.env`** (only documented in
  `.env.example`). The auth middleware fails closed, so **every `/api/*`
  route currently returns 503** until a value is set. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  Sync work so far has run through Node directly, which is why this hasn't
  bitten yet.
- **`SIMPLEFIN_ACCESS_URL` is only in the local `.env`, not the NAS one.**
  Needed before Phase 3 deploys. Add it directly on the NAS rather than
  pasting it through a chat session. Add `TIMEZONE=America/Denver` at the same
  time — the container's own zone is UTC, which misdates evening purchases.
- **Property values are not recorded anywhere**, so net worth reads
  −$392,507. Manual asset entries for the two homes are needed before the net
  worth dashboard means anything.

## Known gap: no local nickname for an account

`syncAccounts()` refreshes `accounts.name` from SimpleFIN on every run, so a
locally-renamed account gets clobbered on the next sync. This matters because
the three Ally accounts are all literally named "Savings Account", separated
only by `(8794)` / `(8802)` / `(8810)` — nothing in the synced data says which
one is the emergency fund, and the four-bucket framework in the brief has an
`emergency_fund` bucket that wants exactly that mapping.

Fix when convenient: add an `accounts.nickname` column that sync never
touches, and have the UI prefer it over `name`. Same treatment `type_confirmed`
already gets — human input outranks synced values. Small, but do it before
building any UI, or three identical "Savings Account" rows will be unusable.

## Why SimpleFIN (and what the fallback is)

Evaluated against Plaid, MX, Akoya, and Teller in Aug 2026. SimpleFIN won on
being the only aggregator actually priced and licensed for personal use
($15/yr, no business agreement); the others are built for companies and need
sales contracts or production-approval processes. Its read-only design is the
main safety property — no API path exists to move money — and bank
credentials live with MX, never on SimpleFIN's own servers.

Known risk, accepted: MX had a bug on 2026-05-28 that let up to 39 users see
each other's transaction/balance data for ~4 hours. No credentials exposed,
disclosed promptly. MX is part of the trust boundary, not just SimpleFIN.

**Fallback if SimpleFIN ever drops one of these banks:** Teller.io — indie
friendly, 100 free connections. Caveat: some of its connectivity is
reverse-engineered rather than agreement-based, which is a durability risk
SimpleFIN doesn't carry. If this app ever becomes a real product, none of
these personal-use terms apply and it'd need Plaid/MX/Akoya properly.
