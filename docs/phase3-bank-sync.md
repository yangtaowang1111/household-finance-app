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

- **44-day window cap.** SimpleFIN warns that anything past 45 days "may be
  capped" in future; the service refuses to request more.
- **No historical backfill yet.** Loading years of history means paging in
  ≤44-day windows, one request each. That belongs with the deferred historical
  import + category walkthrough session.
- **Transfers are not detected.** A credit card autopay appears twice — once
  negative on the checking account, once positive on the card. Both are real
  transactions, but categorizing them as spending double counts. The seeded
  `Transfers` category exists; nothing routes to it automatically yet.
