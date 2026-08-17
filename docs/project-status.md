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
| Phase 3 — Bank connection | **Done** — deployed to the NAS, syncing and categorizing on a 4am cron |
| Historical import | **Done** — 2025 loaded on the NAS (1,614 rows); 1,733 transactions total, net worth $981,793 |
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

**Tracking golf as its own line (raised 2026-08-15, during the first
categorization run).** Greens fees at the Denver-area courses (Raccoon Creek,
Red Hawk Ridge, Meadowhills) categorize consistently as `Entertainment`, and
the ask is to see golf spending on its own.

**Direction chosen: category groups with rollup**, not cross-cutting tags.
Top-level groups stay the default view so the headline numbers stay readable;
subcategories exist for the things worth watching individually and roll up
into their parent. Two levels is enough — it's what YNAB and Monarch both
settled on, and it avoids recursive-query complexity.

Cheap to do, and cheap to defer: `categories.parent_category_id` already
exists from Phase 1 (unused — all 21 seeded categories are flat), and setting
a parent moves no transactions, so **there is no data migration**. Three small
changes when the time comes:

- `budgetCalc.js` — `budgetVsActual` matches `category_id` exactly, so child
  spend must be rolled into the parent (~15 lines).
- `buildSystemPrompt` in `categorizer.js` — render the tree so the model picks
  leaf categories.
- `GET /api/transactions?category_id=` — optionally include children.

**The one real decision is where budgets live.** Budgeting on both a parent
and its child double-counts. The convention that works: budget at the leaf,
roll up for display — groups are a reporting concept, not a budgeting one.

Do it during the historical import, not before: changing the taxonomy first
would mean categorizing everything twice, and a year of real data is what
tells you which subcategories are actually worth having.

Open wrinkle for that session: under strict hierarchy, golf *gear* stays in
Shopping, so "Golf" under Entertainment captures greens fees only. If one
total for all golf spending is the goal, Golf wants to be a top-level group
rather than a child.

**SimpleFIN only holds ~90 days of history — confirmed 2026-08-15, and it
changes the historical-import plan.** A 2-year request returned
`"Requested date range exceeds limit of 90 days and was capped"` with an
earliest transaction of 2026-05-18; a 90-day window from one year ago returned
zero rows. The ceiling is on the history itself, not the request width, so
paging backward does not help.

Consequences:
- **Bank statements are mandatory, not optional**, for the 1–2 years of trend
  and forecasting data that's wanted. The API cannot supply it at any price.
- There is a clean seam at **2026-05-18**: SimpleFIN owns everything after it
  (with real `simplefin_id`s and proper dedup), statements own everything
  before. Cutting the statement import there avoids an overlap region full of
  `possible_duplicate_of` flags.
- A one-time 90-day sync would immediately triple the current data (389
  transactions available vs. 119 stored) at the cost of one API call, and
  those rows dedup properly. Worth doing before any statement work.
- The manually-categorized Google Sheet is therefore more valuable than first
  thought — it may be the only structured record of last year's spending.

**Decisions from reviewing the 2025 categorized CSV (2026-08-16):**

- **`Owner` (Tony / Sophia / Household) is an account attribute, not
  per-transaction attribution.** It reflects *whose card it is* — some of
  Sophia's cards predate the marriage and Tony has no access — not who made a
  given purchase. So it belongs on `accounts.owner`, not on `transactions`.
  **This closes the users-table question**: no per-user attribution is needed,
  and Phase 4 can ship a single shared PIN rather than per-person login.
- **Rental property gets separated from the primary home — a deliberate scope
  change.** CLAUDE.md lists "Business/rental P&L mode" under *Skip*, but the
  2025 sheet has five rental-specific categories (Rental Income, Rental
  Property Mortgage Payment, Rental Property HOA payment, Rental Property R&M,
  Rental Property Management Fee) and separates Primary vs Rental consistently
  across mortgages, HOA, and repairs. Driver is **tax reporting** — Schedule E
  needs income, mortgage interest, HOA, repairs, and management fees cleanly
  separable, so "close enough" isn't sufficient.
- **House values stay manual, with a quarterly reminder in the UI.** Zillow
  retired its public Zestimate API and Redfin never had one; the remaining AVM
  options (RentCast, ATTOM, HouseCanary) add a dependency and a key to manage
  for a number that is itself a ±5–10% estimate and moves a few percent a year.
  Manual entry via `PATCH /api/accounts/:id/balance` already writes a balance
  snapshot, so history is preserved. Wants a `value_updated_at` on the account
  and a nudge past 90 days — a Phase 4 item.
- **Data gap to close:** the sheet covers calendar 2025; SimpleFIN reaches back
  only to ~2026-05-18. That leaves **2026-01-01 → 2026-05-17 uncovered by
  either source** — roughly four and a half months that need bank statements.

**Taxonomy designed and agreed (2026-08-16).** The 72 hand-written categories
in the 2025 sheet collapse to **14 groups** with children underneath — see
[src/db/taxonomy.js](../src/db/taxonomy.js), where every one of the 72 maps
explicitly and the reasoning per group is commented. Verified against the real
file: 1,614 rows, zero unmapped. Decisions made along the way:

- **Golf is top-level**, by request and by weight ($13,476 / 112 rows in 2025 —
  more than groceries). Splitting it immediately earned its keep: **gear
  ($8,007) is double the green fees ($4,039)**, which a flat category hid.
- **Rental Property is its own group**, isolated from Home & Utilities for
  Schedule E.
- **Savings & Investments counts as spending.** Contributions are budgeted like
  a bill; treating them as neutral would make a month look affordable when the
  529 payment had already claimed the money.
- **The one-off $10,000 "Transfer" is reclassified as a College Fund (529)
  contribution**, per the same rule. ⚠️ Caveat worth remembering: that money
  came out of the Chase *Savings* account, not from 2025 income, so counting it
  as 2025 spending is what flips the year's net from **+$10,484 to −$2,516**.
  The recurring $500/month contributions come from checking and are
  unambiguous; this single row is the one that distorts income-vs-spending.
- **Shopping stays one bucket** (274 rows, $12,580 — mostly Amazon/Target).
  The notes don't support splitting it without guessing. *Future idea: break
  out baby-related spending (diapers etc.) once it's worth tracking.*
- **`countsAsSpending` is a field, not a naming convention** — credit card
  payments, internal transfers and the fee/waiver pairs stay as real
  transactions but never reach budget math.

**Data-quality finding the importer must handle: three of Sophia's cards use
the opposite sign convention.** Chase exports record purchases negative and
payments positive; **Hilton Amex, Nordstrom, and United record purchases
POSITIVE and payments NEGATIVE**. That inflates income and understates
spending (e.g. a $550 Amex annual fee currently reads as +$550). It also
explains the −$3,370 residual in card payments exactly: 2 × $1,684.97 of
mis-signed payments, to the cent. **The importer must flip signs per source
account**, not globally.

**The historical importer is built and rehearsed locally (2026-08-16).**
`src/services/historyImporter.js` + `npm run import:history` (`-- --dry-run` to
report without writing). All 1,614 rows of 2025 imported; re-running imports 0.
48 tests pass.

- **162 rules learned** from a year of the household's own categorisations,
  versus the 87 Claude had guessed. Patterns are normalised so store numbers
  don't stick: `CHICK-FIL-A #1111` → `CHICK-FIL-A`, so every branch matches.
  A rule is only learned from a merchant seen ≥2 times and categorised
  consistently ≥80% of the time — 7 conflicting merchants (e.g. `WWW COSTCO
  COM`, both groceries and a rental-property appliance) deliberately taught
  nothing, since a wrong rule mis-files every future transaction.
- **The sign correction validated itself.** After flipping the three inverted
  cards, `Transfers & Non-Spending` nets **+$8** — down from −$3,370. Card
  payments now cancel almost exactly, which is the independent confirmation
  that the inverted-sign diagnosis was right.
- **A dedup bug caught in rehearsal, worth $1,120.** The first pass imported
  1,607 of 1,614: an existence-check dedup was swallowing *genuine* same-day
  repeats (two `WESTERN UNION -1000.99` on 2025-11-05, two `SOUTH SUBURBAN
  GOLF COUR -4` on 11-10). Dedup now compares **counts**, so N real copies
  import once and a re-run still adds nothing. This is the same hazard the
  SimpleFIN sync avoided — but there the probe showed zero same-day identical
  pairs, and here they exist.
- **2025 totals** (sign-corrected): income **$214,489**, spending
  **$220,394**, net **−$5,905**. Excluding the $13,000 of savings/529
  contributions that now count as spending, cash flow is **+$7,095**.
- **Account mapping resolved: 7 of 11 map onto synced accounts**, and the 4
  created are all Sophia's cards, which genuinely cannot sync (they predate the
  marriage and Tony has no access). No duplicates.
- ⚠️ **`PREMIER PLUS CKG` and `PREMIER SAVINGS` are CHASE accounts, not U.S.
  Bank** — "Premier Plus Checking" is a Chase product, and SimpleFIN's
  institution field says Chase. A first pass had them mapped to the U.S. Bank
  checking and got it backwards. The transaction volumes settle it
  independently: Chase checking is the busy one (322 rows/year in the sheet,
  34 in 30 days synced), U.S. Bank's `Checking - 3475` is quiet (51/year, 6 in
  30 days). Worth remembering — the account *names* are misleading.
- **Credit card payments confirmed neutral**: 94 rows, net **exactly $0.00**,
  `counts_as_spending = 0`, driven by 7 learned rules (`CHASE CREDIT CRD
  AUTOPAY`, `AUTOMATIC PAYMENT - THANK`, `WEB AUTHORIZED PMT CARDMEMBER SERV`,
  …). The rules discriminate correctly — `VERIZON WIRELESS PAYMENTS` stays
  real spending under Mobile Phone rather than being swept up as a payment.
- `seedTaxonomy.js` retires the 10 Phase 1 flat categories the new tree
  doesn't reuse and resets any transaction pointing at them, so the
  categoriser redoes those against the new taxonomy. Names the new tree kept
  (Groceries, Dining Out, Travel, Insurance, Subscriptions, Income, Shopping,
  Transportation, Uncategorized, the two contribution categories) keep their
  ids, so those transactions are untouched.

**The 2025 import ran on the NAS on 2026-08-16 and is complete.** Migrations 4
and 5 applied, taxonomy seeded (49 legacy-categorised transactions reset as
predicted), 1,614 rows imported, both property accounts created.

- **Net worth now reads $981,793** — it was −$392,507 before the properties
  existed.
- **The rules paid off immediately.** Re-categorising the 119 synced
  transactions against the new taxonomy: **89 matched by rule for free**, only
  30 reached the API, 4 flagged low-confidence. The first-ever categorisation
  run had `ruleMatched: 0`; a year of the household's own decisions took that
  to 75% on the first try. Now 188 rules.
- Totals reconcile with the local rehearsal to the cent. The only apparent
  difference — Food 462 rows vs 464, Entertainment 225 vs 226 — is the three
  `2024-12-31` rows in the sheet falling outside a 2025-only query window, not
  missing data.
- `scp` to the NAS needs **`-O`**: modern scp uses SFTP, and this box appears
  to restrict the SFTP subsystem so `/volume1/...` is invisible to it even
  though the SSH shell reaches it fine. `scp -O` uses the legacy protocol and
  works. (Alternative: copy to `~` and `mv` it into place.)

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
- **Categorization was finally exercised for real on 2026-08-15**, on the NAS,
  against all 119 synced transactions. Results: 87 rules learned, 3 flagged
  low-confidence, 0 left uncategorized, and the whole run cost about five
  cents on `claude-sonnet-5`. The `payee` fix landed correctly — learned
  patterns are clean merchant names (`McDonald's`, `The Little Diner`,
  `Trader Joe's`), not store-numbered descriptors.
- The three low-confidence flags were the genuinely ambiguous rows: a $0.01
  micro-deposit with a mangled ACH descriptor, and a −$14.95 bank fee paired
  with its +$14.95 reimbursement (which is why `Uncategorized` totals exactly
  $0.00). Worth a `Bank Fees` category eventually.
- **Rule hit rate starts low and climbs.** The first run matched only 2 of 69
  by rule, because a 30-day window has little merchant repetition (126
  distinct payees across 222 transactions in the original probe). With 87
  rules now stored, nightly runs should be mostly free.
- **Transfers double-counting is now visible in real data:** the `Transfers`
  category totals **+$1,946.14** because credit card payments land positive on
  the card and negative on checking. Any net-spend calculation must exclude
  it. Isolating them in one category makes that easy — but nothing does it
  automatically yet.

## Next steps (as of 2026-08-16, after the 2025 import)

**1. ✅ DONE 2026-08-16 — SimpleFIN's remaining history is captured.** The
backfill ran at 89 days and recovered **288 transactions** that were days from
ageing out. SimpleFIN's coverage is now **2026-05-20 → 2026-08-13 (407
transactions)**, up from 119; dedup recognised all 119 pre-existing rows and
flagged nothing. Categorisation finished across two batches — 204 by rule, 84
by AI, 8 low-confidence — and left **0 uncategorized**, with rules up from 188
to **296**. The second batch matched 84 of 88 by rule alone, using rules learned
minutes earlier in the first.

Database total: **2,021 transactions** (1,614 csv_import + 407 simplefin).

The command, for the record (`backfill` is required — see below):

```bash
curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"days": 89, "backfill": true}' http://localhost:3000/api/sync
```

`backfill` is required: without it the window is capped at 44 days to respect
SimpleFIN's "beyond 45 days" advisory, and the request comes back quietly
shortened. The response now reports `window.requested_days` whenever an ask was
cut down, so a clamp can't pass for a successful deep sync.

Doing this first also shrinks step 2 — statements then only need to cover
January to mid-May instead of the full year.

**2. Fill the 2026 gap from bank statements — now 2026-01-01 → 2026-05-19.**
The backfill shortened this from a full year to four and a half months. Agreed
approach:

- **Cutoff is `2026-05-20`**, the observed earliest synced transaction, already
  set as `DEFAULT_CUTOFF` in `scripts/import-history.js`. Note it is the date
  transactions actually *start*, not the date the 89-day window opened
  (2026-05-19) — using the window start would skip a day SimpleFIN never
  supplied.

- **One export per account, NOT consolidated.** Last year's file was merged
  because the categories were hand-written; raw statements have no categories,
  so merging would just mean normalising five bank formats by hand — which is
  the importer's job.
- Save to **`data/import/2026/`** (gitignored — the repo is public).
- **Put each account's last four digits in the filename** (e.g.
  `2026-chase-sapphire-7530.csv`). A bank CSV rarely says which account it came
  from; the last four map onto the existing account names.
- **Download checking, savings and every credit card. SKIP both mortgages** —
  their statements are the loan's internal ledger, and the payment already
  appears as a debit on Chase checking (`US BANK HOME MTG MTG PYMT`, −$2,969.05
  and −$2,239.66 monthly). Importing both sides double-counts ~$5,200/month.
- Set `--before` to whatever `MIN(date) WHERE source='simplefin'` reports after
  step 1, so the two sources meet without overlapping.
- **A second importer is needed.** `historyImporter.js` expects the 2025
  sheet's shape (category, owner, notes columns). Raw statements need per-bank
  format handling and account assignment by filename — closer to
  `importer.js`. The transactions arrive uncategorised, which is now cheap:
  the 188 learned rules cover most merchants.

**3. Phase 4 — build the WEB app first, native later.** A change from the
brief's Expo-first plan, decided 2026-08-16. The reasoning: a web app is served
by the container that already runs (no app store, no Expo build, no second
deployment), it's reachable on a phone through Tailscale anyway, and as a PWA
it gets a home-screen icon. Most importantly the split is *checking is mobile,
managing is desktop* — reviewing 1,733 transactions, correcting categories and
setting budgets across 14 groups is keyboard work. Expo remains open afterwards
against the same API; nothing gets rebuilt. Trade-off accepted: no native push
notifications or biometric unlock.

**4. Claude Design pass — deferred by agreement**, to be judged once there is a
working UI to look at. Nothing about it is a migration: it produces designs,
Claude Code implements against the existing API, and the backend is untouched.
Doing it now rather than earlier is an advantage — it can be designed against
real data (14 real groups, a real net worth, a year of real trends) instead of
placeholder content that falls apart on contact with fifty-nine categories.

## Earlier next steps (Phase 3, part 3 — deployment, now complete)

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
