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

- **accounts** — id, name, institution, type (checking/credit/investment), current_balance, source (simplefin/manual)
- **transactions** — id, account_id, date, amount, merchant_raw, category_id, notes, source, simplefin_id (for dedup)
- **categories** — id, name, bucket (retirement / investment / college fund / emergency fund / other), parent_category_id
- **budgets** — id, category_id, month, budgeted_amount
- **categorization_rules** — id, merchant_pattern, category_id (learned overrides so you don't re-correct the same merchant repeatedly)

Implemented in [src/db/schema.sql](src/db/schema.sql). This is intentionally minimal — the forecasting/scenario layer gets its own model once the core is working (see Phase 5).

## Phased build order

### Phase 1 — Core (no bank connection yet) — IN PROGRESS

- [x] Repo, Node/Express backend, SQLite schema
- [x] CSV/statement importer (`src/services/importer.js`, `POST /api/import`)
- [x] Claude API categorization pipeline (`src/services/categorizer.js`, `POST /api/categorize`)
- [x] Budget-vs-actual calculation logic (`src/services/budgetCalc.js`, `GET /api/budgets/vs-actual`)
- [ ] Test end-to-end via API calls / Postman with a real statement CSV

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

### Phase 3 — Bank connection — NEXT UP

- [ ] **Blocked on you:** sign up for SimpleFIN Bridge ([bridge.simplefin.org](https://bridge.simplefin.org), ~$1.50/mo), connect your accounts, and redeem the one-time setup token for a permanent access URL
- [ ] Store the access URL as `SIMPLEFIN_ACCESS_URL` in `.env` (never commit it)
- [ ] Build the sync service — pull accounts + transactions, map into the existing schema
- [ ] Dedup on `transactions.simplefin_id` (column + UNIQUE constraint already exist)
- [ ] Schedule a daily sync, routing new transactions through the Phase 1 categorization pipeline

**Done when:** transactions show up automatically each day, categorized, with no manual CSV uploads.

Session context, environment quirks, and decisions so far: [docs/project-status.md](docs/project-status.md).

### Phase 4 — Design / mobile UI
- Use Claude Design to mock up: dashboard (net worth + monthly summary), transaction list, category management, budget view with trend charts
- `/design-sync` the result into Claude Code, or hand off screenshots/specs directly
- Build the Expo screens against your existing API
- Add simple auth (PIN or biometric — single-household app, doesn't need much)

**Done when:** you're checking the app on your phone instead of the API directly.

### Phase 5 — Forecasting (later, separate scoping pass)
- This is the most involved piece — worth its own planning session once Phases 1–4 are solid
- Start simple: linear multi-year projections based on current savings rate and a manually entered "big expense" scenario
- Decide then whether to build real Monte Carlo-style modeling yourself or keep using ProjectionLab/Boldin's free tier for this specific piece and just link the output into your dashboard
