# Importing the hand-categorised history

How to load the 2025 spreadsheet onto the NAS. Design rationale and the
findings behind it are in [project-status.md](project-status.md); this is the
operational half.

The import is **idempotent** — running it twice imports nothing the second
time — so the safe order is always dry run, read the report, then commit.

## What this deploy carries

| | |
|---|---|
| Migration 4 | `accounts.nickname`, `accounts.owner`, and the `property` account type (for house values) |
| Migration 5 | `categories.counts_as_spending`, `UNIQUE(name)` |
| New taxonomy | 14 groups + children, replacing the Phase 1 flat 21 |
| History importer | `scripts/import-history.js` |

Both migrations **rebuild a table** (`accounts`, `categories`). They are tested
and preserve data, but this is the deploy where the step-1 backup earns its
keep.

## 1. Back up

SSH auto-disables on this box, so re-enable it in UGOS Control Panel first.

```bash
ssh ywang1111@192.168.50.107
cd /volume1/docker/household-finance-app
sudo docker exec household-finance-app node scripts/backup-db.js /data/backups
```

## 2. Get the CSV onto the NAS

**The spreadsheet must never go through the repo** — it is public. Copy it
directly instead, from a **Windows** terminal (not the NAS session):

```powershell
scp "D:\Claude Projects\Household Finance App\data\import\FP_Master_Transactions*.csv" `
    ywang1111@192.168.50.107:/volume1/docker/household-finance-app/data/import/
```

If the destination doesn't exist yet, create it on the NAS first:

```bash
mkdir -p /volume1/docker/household-finance-app/data/import
```

`data/` is the mounted volume, so the container sees this as `/data/import`.
The import script derives that path from `DB_PATH`, which is why it works in
both places without configuration.

## 3. Deploy

```bash
curl -L https://github.com/yangtaowang1111/household-finance-app/archive/refs/heads/master.tar.gz -o app.tar.gz
tar -xzf app.tar.gz --strip-components=1
rm app.tar.gz
sudo docker compose up -d --build
sudo docker logs household-finance-app --tail 30
```

Expect **migrations 4 and 5**, then the taxonomy line:

```
Applied migration 4: accounts-property-nickname-owner (...)
Applied migration 5: categories-counts-as-spending (...)
Taxonomy: 15 groups, 59 children (+11 groups, +52 children, 11 updated)
  retired 10 legacy flat categories; N transactions reset for re-categorization
```

That "N transactions reset" line is expected: the Phase 1 flat categories the
new tree doesn't reuse (Housing, Utilities, Kids, Entertainment, Transfers,
Healthcare, Personal Care, and the two contribution categories) are retired,
and anything filed under them is cleared so the categoriser can redo it
properly. Roughly 49 of the 119 synced transactions.

## 4. Dry run

```bash
sudo docker exec household-finance-app node scripts/import-history.js --dry-run
```

Read the report before going further:

- `rows read` should be **1614**, `imported` **1614**
- `sign corrections` should be **23** — Hilton Amex, Nordstrom and United
  export purchases positive; uncorrected, a $550 annual fee reads as income
- `every source category resolved ✓` — if anything is listed as unresolved it
  landed in Uncategorized rather than being dropped, but worth fixing first
- **7 accounts matched**, 4 created (all Sophia's cards, which genuinely can't
  sync). If anything else appears under "created", stop — it means an account
  is about to be duplicated

## 5. Import

```bash
sudo docker exec household-finance-app node scripts/import-history.js
```

## 6. Add the property values

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Primary Home","type":"property","current_balance":781800,"owner":"Household"}' \
  http://localhost:3000/api/accounts

curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Rental Property","type":"property","current_balance":592500,"owner":"Household"}' \
  http://localhost:3000/api/accounts
```

Add the street address as `nickname` if wanted — it stays on the NAS, which is
private, unlike the repo.

## 7. Re-categorise the synced transactions

The 119 SimpleFIN transactions were categorised against the old flat taxonomy.
Clearing all of them and redoing the pass is cleaner than a partial reset: some
survived only by landing on a name the new tree reuses as a *group*
(`Transportation`, `Shopping`, `Income`), which is coarser than the leaf they
belong in.

```bash
sudo docker exec household-finance-app node -e "
const db = require('./src/db');
const r = db.prepare(\"UPDATE transactions SET category_id = NULL WHERE source = 'simplefin'\").run();
console.log('cleared', r.changes, 'synced transactions for re-categorization');
"

curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"limit": 200}' http://localhost:3000/api/categorize
```

Expect `ruleMatched` to carry most of it — the 162 rules learned from the
spreadsheet cover the household's regular merchants, so only genuinely new ones
reach the API.

## 8. Check the result

```bash
sudo docker exec household-finance-app node -e "
const db = require('./src/db');
const money = (n) => (n < 0 ? '-' : '') + '\$' + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log('transactions:', JSON.stringify(db.prepare('SELECT source, COUNT(*) n FROM transactions GROUP BY source').all()));
console.log('net worth:', money(db.prepare('SELECT SUM(current_balance) s FROM accounts').get().s));
console.table(db.prepare(\`
  SELECT COALESCE(p.name, c.name) AS grp, COUNT(*) AS txns, ROUND(SUM(t.amount), 2) AS total
  FROM transactions t JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories p ON p.id = c.parent_category_id
  WHERE t.date >= '2025-01-01' AND t.date < '2026-01-01'
  GROUP BY grp ORDER BY ABS(SUM(t.amount)) DESC\`).all());
"
```

Net worth should be roughly **+$982,000** once the properties are in.

## 9. Turn SSH back off

In UGOS Control Panel.

## If something goes wrong

Restore the backup from step 1 — it is a plain SQLite file:

```bash
sudo docker compose down
sudo cp data/backups/finance-<timestamp>.db data/finance.db
sudo docker compose up -d
```

The import writes nothing until step 5, so anything failing before then leaves
the database untouched.
