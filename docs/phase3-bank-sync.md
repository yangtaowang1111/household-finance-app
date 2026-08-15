# Phase 3 — Bank sync: running it, scheduling it, reviewing it

How the SimpleFIN sync works day to day. Design rationale and the real-data
findings behind it live in [project-status.md](project-status.md); this file is
the operational half.

## What one sync does

A single SimpleFIN request returns accounts *and* their transactions, so one
run refreshes both:

1. Upserts accounts — balances, and a balance snapshot per account per run
2. Upserts transactions for the requested window, deduped on SimpleFIN's
   transaction id
3. Flags anything that looks like it duplicates a hand-entered or
   CSV-imported row
4. Routes newly imported transactions through the Phase 1 categorizer
5. Writes a row to `sync_runs` either way

The budget is **24 SimpleFIN requests a day**, and a run costs exactly one.
That is the reason accounts and transactions are not separate jobs.

## Running it

```bash
npm run sync                         # 30-day window, posted transactions only
npm run sync -- --days 44            # widest window SimpleFIN will accept
npm run sync -- --include-pending    # also pull not-yet-settled charges
npm run sync -- --no-categorize      # import only, skip the Claude API call
```

Exits non-zero on a failed *or* partial sync, so cron surfaces it.

Over HTTP (every `/api/*` route needs the `x-api-key` header):

| Endpoint | Purpose |
|---|---|
| `POST /api/sync` | Balances + transactions, one request |
| `POST /api/sync/transactions` | Transactions only |
| `POST /api/sync/accounts` | Balances only |
| `GET /api/sync/runs?limit=20` | Sync history |

Body options for the `POST`s: `{"days": 30, "include_pending": false,
"confirm_inferred_types": false}`.

## Deploying this to the NAS

The first Phase 3 deploy is the one that carries schema migrations, so it needs
a little more care than the usual re-run of the `curl`/`tar` steps.

SSH auto-disables on this UGOS box, so it likely needs re-enabling in Control
Panel first (`ssh: connect to ... port 22: Connection refused` is the symptom).

```bash
ssh ywang1111@192.168.50.107
cd /volume1/docker/household-finance-app

# 1. Back up first — this deploy rebuilds two tables.
sudo docker exec household-finance-app node scripts/backup-db.js /data/backups

# 2. Add the Phase 3 settings. Type the access URL here rather than pasting it
#    through a chat session; it is a credential.
nano .env
#      SIMPLEFIN_ACCESS_URL=<permanent access URL>
#      TIMEZONE=America/Denver
#      ANTHROPIC_API_KEY=<key>        # optional, enables categorization

# 3. Pull the new code. `.env` and `data/` are gitignored, so the tarball
#    cannot overwrite either.
curl -L https://github.com/yangtaowang1111/household-finance-app/archive/refs/heads/master.tar.gz -o app.tar.gz
tar -xzf app.tar.gz --strip-components=1
rm app.tar.gz

# 4. Rebuild.
sudo docker compose up -d --build
```

**Then check the migrations actually ran** — this is the step that confirms the
deploy worked, because the schema changes are what the old database is missing:

```bash
sudo docker logs household-finance-app --tail 30
```

Expect three lines on this first Phase 3 boot:

```
Applied migration 1: transaction-sync-fields (payee, pending, posted_at, possible_duplicate_of)
Applied migration 2: possible-duplicate-on-delete-set-null (rebuilt transactions with ON DELETE SET NULL)
Applied migration 3: accounts-simplefin-fields (simplefin_id, currency, type_confirmed, rebuilt accounts ...)
```

If instead the container is restart-looping with `SqliteError: no such column`,
the migrations did not run — restore the backup from step 1 rather than letting
it keep cycling.

Then confirm it's serving and do the first real sync by hand, before trusting
it to cron:

```bash
curl -s http://localhost:3000/health
sudo docker exec household-finance-app node scripts/daily-sync.js
```

The first sync on the NAS creates every account and backfills 30 days of
transactions, so expect non-zero `created` counts. Run it a second time — the
counts should go to `0 created, 0 updated`.

## Scheduling it on the NAS

Same pattern as the 3am backup ([phase2-nas-deployment.md](phase2-nas-deployment.md#6-backups)) —
root's crontab, since `docker exec` needs Docker socket access:

```bash
sudo EDITOR=nano crontab -e
```

Add a line for 4am, an hour after the backup so a bad sync is never the newest
thing in the backup directory:

```
0 4 * * * docker exec household-finance-app node scripts/daily-sync.js >> /volume1/docker/household-finance-app/sync.log 2>&1
```

Verify with `sudo crontab -l`, and check it actually ran the next morning:

```bash
curl -s -H "x-api-key: $API_KEY" http://localhost:3000/api/sync/runs?limit=5
```

Before the first NAS run, add to the NAS `.env` (directly on the box — don't
paste the access URL through a chat session):

```
SIMPLEFIN_ACCESS_URL=<the permanent access URL>
TIMEZONE=America/Denver
```

`TIMEZONE` matters more than it looks: SimpleFIN timestamps are moments, not
dates, and the container's system zone is UTC. Without it, an evening purchase
is recorded on the following day — and on the last day of a month, in the
following *budget month*.

## Reviewing what the sync flags

Nothing is ever auto-deleted, so two queues want an occasional look.

**Possible duplicates** — a synced transaction that matches a manual or
CSV-imported row of the same amount within three days:

```bash
curl -s -H "x-api-key: $API_KEY" "http://localhost:3000/api/transactions?possible_duplicates=1"
```

Each carries `possible_duplicate_of` pointing at the older row. The synced row
is the authoritative one; the usual resolution is deleting the hand-entered
twin:

```bash
curl -X DELETE -H "x-api-key: $API_KEY" "http://localhost:3000/api/transactions/<id>"
```

Deleting the row a flag points at is safe — `possible_duplicate_of` is
`ON DELETE SET NULL`, so the surviving row keeps its data and just loses the
now-meaningless pointer.

**Pending transactions** (only if you sync with `--include-pending`):

```bash
curl -s -H "x-api-key: $API_KEY" "http://localhost:3000/api/transactions?pending=1"
```

Pending charges are **excluded by default**. Their amounts change when they
settle — restaurant tips, fuel pre-authorizations — so including them makes
budget totals move under you, and SimpleFIN doesn't promise the transaction id
survives posting. If you do turn them on, keep them on: reconciliation only
runs on a sync that asked for pending, so switching back to posted-only leaves
any unsettled rows stranded until the next `--include-pending` run.

## Limits worth knowing

- **SimpleFIN holds ~90 days of history, and that is a hard ceiling.** Two
  probes on 2026-08-15 settled it: a 2-year request came back
  `"Requested date range exceeds limit of 90 days and was capped"` with an
  earliest transaction of 2026-05-18 (89 days), and a 90-day window from *one
  year ago* returned **zero** transactions. So the 90 days is a limit on the
  history itself, not on the width of a single request — paging backward does
  not work. **Anything older than ~90 days must come from bank statements or
  another source; the API cannot supply it.**
- **45 days is a soft advisory, 90 is the enforced cap.** Requests over 45 days
  return a "recommended range" warning in `errors[]` but still serve data.
  `MAX_LOOKBACK_DAYS` is set conservatively at 44 to keep runs clean; raise it
  toward 90 for a one-time deep pull, accepting the advisory (which will mark
  the run `partial`).
- **Transfers are not detected.** A credit card autopay appears twice — once
  negative on the checking account, once positive on the card. Both are real
  transactions, but categorizing them as spending double counts. The seeded
  `Transfers` category exists; nothing routes to it automatically yet.
