# Household Finance App — Project Brief

## Goal

A self-hosted, cross-platform (iPhone + Android) personal finance app that:
- Connects to bank/credit card accounts and pulls transactions automatically
- Categorizes expenses with AI against a defined budget structure
- Tracks budget-vs-actual and spending trends over time
- Tracks investments and net worth alongside cash accounts
- Eventually supports 3–5 year "what-if" scenario forecasting (big purchases, retirement, career changes) and their cash flow impact
- Stores all data on your own NAS — no third-party cloud platform holds your financial data
- Built to potentially evolve into a shareable/sellable product later, without having to rebuild the foundation

## Feature scope

Mapped from Monarch Core's feature set, tuned to what actually matters for this project — not a full clone.

**Build:**
- Multi-account connection (bank, credit card, investment) via SimpleFIN
- Net worth dashboard combining cash + investment balances
- AI categorization against your own category taxonomy (four-bucket framework + everyday spending categories)
- Budget vs. actual, by category and by month
- Spending trend charts over time
- Recurring transaction / subscription detection
- Household view (joint access for you and your wife)
- Manual account/adjustment entry (for anything SimpleFIN can't reach)

**Skip (Monarch features that don't apply here):**
- Business/rental P&L mode
- RSU/equity compensation tracking
- Morningstar-grade investment analysis
- Credit score monitoring
- Receipt scanning

**Deferred to Phase 5:**
- 3–5 year what-if scenario forecasting

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Mobile app | Expo (React Native) | One codebase → iPhone + Android; run via dev build/TestFlight without app store approval for personal use |
| Backend API | Node.js + Express | Simple REST layer between the app and your data; easy to containerize |
| Database | SQLite | File-based, zero-admin, plenty for single-household scale; trivial to back up |
| Bank connection | SimpleFIN Bridge (~$1.50/mo) | Personal-use bank aggregator; read-only; the only piece that talks to the outside world |
| Categorization | Claude API | System prompt encodes your budget categories/four-bucket framework; called per transaction batch |
| Hosting | Docker container on your UGREEN NAS | Most NAS OS's (UGOS included) support Docker; keeps the app portable if you ever move hosts |
| Remote access | Tailscale (or similar) | Lets your phone reach the NAS-hosted backend securely from outside your home network, without exposing a public port |

## Data model

- **accounts** — id, name, institution, type (checking/savings/credit/investment/mortgage/loan), current_balance, currency, source (simplefin/manual), simplefin_id, type_confirmed
- **transactions** — id, account_id, date, amount, merchant_raw, payee, category_id, notes, source, simplefin_id (for dedup), pending, posted_at, possible_duplicate_of
- **categories** — id, name, bucket (retirement / investment / college fund / emergency fund / other), parent_category_id
- **budgets** — id, category_id, month, budgeted_amount
- **categorization_rules** — id, merchant_pattern, category_id (learned overrides so you don't re-correct the same merchant repeatedly)
- **account_balance_snapshots** — id, account_id, balance, recorded_at (net worth over time; `accounts.current_balance` alone has no history)
- **sync_runs** — id, kind, status, window, per-run counts, errors (audit trail for an unattended job)

Implemented in [src/db/schema.sql](src/db/schema.sql), with [src/db/migrate.js](src/db/migrate.js) handling databases that already exist. This is intentionally minimal — the forecasting/scenario layer gets its own model once the core is working (see Phase 5).

## Phased build order

### Phase 1 — Core (no bank connection yet) — DONE

- [x] Repo, Node/Express backend, SQLite schema
- [x] CSV/statement importer (`src/services/importer.js`, `POST /api/import`)
- [x] Claude API categorization pipeline (`src/services/categorizer.js`, `POST /api/categorize`)
- [x] Budget-vs-actual calculation logic (`src/services/budgetCalc.js`, `GET /api/budgets/vs-actual`)
- [x] Test end-to-end via API calls with real data — 2,565 transactions across
      20 accounts, categorized, with budget-vs-actual and cash flow both running

**Done when:** you can drop a statement CSV in, get back categorized transactions, and see budget-vs-actual numbers for a month.

**To try it (once Node.js is installed):**
```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm start
```
Then: create an account (`POST /api/accounts`), import a CSV (`POST /api/import`), run categorization (`POST /api/categorize`), set a budget (`POST /api/budgets`), and check `GET /api/budgets/vs-actual?month=YYYY-MM`.

### Phase 2 — Storing on the NAS — DONE

- [x] Containerize the backend (`Dockerfile`, `.dockerignore`, `docker-compose.yml`)
- [x] Persistent volume set up in `docker-compose.yml` (`./data` → `/data`)
- [x] Backup script (`scripts/backup-db.js`, `npm run backup`) — WAL-safe SQLite backup
- [x] Deployed on the UGREEN DXP4800 at `/volume1/docker/household-finance-app` via `docker compose up -d --build`
- [x] Tailscale running as its own container (`tailscale/tailscale`, host networking) — NAS reachable at `100.99.152.23:3000`
- [x] Daily backup scheduled via root's crontab (3am, `docker exec household-finance-app node scripts/backup-db.js /data/backups`)

Full walkthrough: [docs/phase2-nas-deployment.md](docs/phase2-nas-deployment.md) (note: actual deploy used a `curl`+`tar` download from the public GitHub repo instead of `git clone`, since the NAS has no `git`; UGOS has no Task Scheduler GUI we could find, so cron is used directly instead).

**Done:** the backend runs unattended on the NAS (`restart: unless-stopped`), and `/health` was confirmed reachable from a phone over cellular data via Tailscale (no public port opened).

### Phase 3 — Bank connection — DONE

- [x] Sign up for SimpleFIN Bridge ([bridge.simplefin.org](https://bridge.simplefin.org), ~$1.50/mo), connect accounts, redeem the setup token
- [x] Store the access URL as `SIMPLEFIN_ACCESS_URL` in `.env` (never commit it) — local only so far
- [x] Account sync (`src/services/accountSync.js`, `src/services/accountMapper.js`) — 13 accounts
- [x] Transaction sync (`src/services/transactionSync.js`, `src/services/transactionMapper.js`, `POST /api/sync`) — 120 transactions, one API request refreshes balances and transactions together
- [x] Dedup on `(account_id, simplefin_id)`, with date-bounded content matching only where no id exists to match on — pending settlement and manual/CSV duplicates, both of which flag rather than delete
- [x] Schema migrations (`src/db/migrate.js`) so schema changes can reach the NAS's live database
- [x] Tests (`npm test`) covering the dedup branches
- [x] `/code-review` pass over the dedup logic — 9 findings, all fixed
- [x] `/code-review ultra` pass — 10 more findings, all fixed (including a migration gap that would have crash-looped the NAS container)
- [x] Deployed to the NAS (migrations 1–3 applied to the live database; 13 accounts, 119 transactions)
- [x] Daily sync scheduled — 4am in root's crontab, cron path verified end-to-end
- [x] `ANTHROPIC_API_KEY` set; all 119 transactions categorized, 87 rules learned, ~$0.05

**Done:** transactions arrive automatically each day, categorized, with no manual CSV uploads.

Running and reviewing the sync: [docs/phase3-bank-sync.md](docs/phase3-bank-sync.md).

Session context, environment quirks, and decisions so far: [docs/project-status.md](docs/project-status.md).

### Phase 4 — Design / UI — ITERATION 1 DONE

**Web first, native app second** (decided 2026-08-16, a change from the original
Expo-first plan). The web app is served by the container that already runs — no
app store, no Expo build, no second deployment — and it is reachable from a
phone over Tailscale regardless. The deciding argument is that *checking* is a
phone job but *managing* is a desktop one: reviewing 2,565 transactions,
correcting categories and setting budgets across 14 groups is keyboard work.
Expo stays open afterwards against the same API, and nothing gets rebuilt when
it arrives. Trade-off accepted: no native push notifications or biometric unlock
until then.

- Design pass in Claude Design, then `/design-sync` or hand off screenshots
- Screens: dashboard (net worth + monthly summary), transaction list, category
  management, budget view with trend charts
- Build against the existing API — no backend changes expected
- Simple auth (single-household app, doesn't need much)

**Done:** seven screens live on the NAS — Overview, Transactions, Budget
(Set/Track), Accounts, Investments, Property, Rules & imports. Every navigation
entry resolves to a real page. Reporting is next, then Retirement.

Section-by-section scope, the order it gets built in, and the decisions behind
it: **[docs/roadmap.md](docs/roadmap.md)**. Iteration 1 is deliberately narrow —
spending, budget, net worth, investments — with reporting next and retirement
after it.

### Phase 4b — Native app (optional, later)
- Expo screens against the same API and database
- PIN or biometric unlock, push notifications

### Phase 5 — Forecasting (later, separate scoping pass)
- This is the most involved piece — worth its own planning session once Phases 1–4 are solid
- Start simple: linear multi-year projections based on current savings rate and a manually entered "big expense" scenario
- Decide then whether to build real Monte Carlo-style modeling yourself or keep using ProjectionLab/Boldin's free tier for this specific piece and just link the output into your dashboard
