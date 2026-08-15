# Project Status & Session Handoff

Last updated: 2026-08-12 (end of Phase 2)

This file captures context that isn't obvious from the code or git history —
decisions we made, things we deliberately deferred, and environment quirks
that cost time to discover. Read this alongside [CLAUDE.md](../CLAUDE.md).

## Where things stand

| Phase | Status |
|---|---|
| Phase 1 — Core backend | Built and tested end-to-end, except live AI categorization (no API key yet) |
| Phase 2 — NAS deployment | Done and verified — running unattended on the DXP4800 |
| Phase 3 — Bank connection | Not started; blocked on SimpleFIN signup |
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

## Next steps (Phase 3, part 2)

SimpleFIN signup, token redemption, and **account** sync are all DONE (see
the Phase 3 part 1 entry above). What remains:

1. **Transaction sync + dedup** — the main piece. Pull transactions per
   account, map into `transactions`, dedup on `transactions.simplefin_id`
   (column + UNIQUE constraint already exist). Design questions that still
   need answering, since the account-level probe didn't cover them:
   - How does a `pending` transaction differ from a posted one, and does its
     `id` or `amount` change when it settles? Probe real transaction data
     before writing the dedup logic, the same way the account probe was done.
   - What happens when a manually-entered transaction (no `simplefin_id`)
     later arrives for real from SimpleFIN? Same date/amount/account is a
     likely-duplicate signal, but there is no id to match on.
2. **Schedule a daily sync.** The NAS already uses root's crontab for the 3am
   backup; following that pattern is likely simpler than an in-process
   scheduler. Budget is 24 SimpleFIN requests/day, so retries need bounding.
3. **Route newly-synced transactions through the categorizer.** Needs
   `ANTHROPIC_API_KEY` set (still blank — see Deliberately deferred).
4. **Decide the categorizer's `effort` level** — `src/services/categorizer.js`
   currently sets none, so it runs at the API default.

The brief flags sync/dedup as the point to use a stronger model — it's the
first piece where getting it wrong creates messy data that's annoying to
unwind. Agreed approach: Opus 5 at `xhigh` effort, then a `/code-review` pass
over the dedup logic specifically.

## Blockers to clear before end-to-end testing

- **`API_KEY` is not set in the local `.env`** (only documented in
  `.env.example`). The auth middleware fails closed, so **every `/api/*`
  route currently returns 503** until a value is set. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  Sync work so far has run through Node directly, which is why this hasn't
  bitten yet.
- **`SIMPLEFIN_ACCESS_URL` is only in the local `.env`, not the NAS one.**
  Needed before Phase 3 deploys. Add it directly on the NAS rather than
  pasting it through a chat session.
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
