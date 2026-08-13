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

## Next steps (Phase 3)

1. **You:** sign up for SimpleFIN Bridge at
   [bridge.simplefin.org](https://bridge.simplefin.org) (~$1.50/mo), connect
   your accounts, and redeem the one-time setup token for a permanent access
   URL. This involves bank credentials and payment, so it has to be done by
   you directly.
2. Store that access URL in `.env` (e.g. `SIMPLEFIN_ACCESS_URL=`) — never
   commit it.
3. Build the sync service: pull accounts + transactions from SimpleFIN, map
   them into the existing schema, dedup on `transactions.simplefin_id` (the
   column and its UNIQUE constraint already exist).
4. Schedule a daily sync, then route new transactions through the existing
   categorization pipeline.

The brief flags sync/dedup as the point to use a stronger model — it's the
first piece where getting it wrong creates messy data that's annoying to
unwind.
