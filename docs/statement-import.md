# Importing raw bank statements

How to load per-account statement exports — the 2026 gap between the 2025
spreadsheet and the day SimpleFIN's history begins. Design notes are in
[project-status.md](project-status.md); this is the operational half.

The import is **idempotent**, so the safe order is always dry run, read the
report, then commit. It is also **safe to do in pieces**: importing five
accounts now and four later adds only what is new.

## What the importer expects

**One file per account, not consolidated.** Unlike the 2025 sheet, raw exports
carry no categories, so merging them would just mean normalising four bank
formats by hand — which is the importer's job.

**The account's last four digits in the filename.** A bank export rarely says
which account it came from, so the filename is the only link. Four-digit runs in
the name are matched against accounts that actually exist, which is what keeps
dates like `20260816` from being mistaken for an account number. A file naming
no known account, or two, is reported and skipped — never guessed at.

**A nickname, optionally.** A trailing `_Some Name` segment becomes the
account's nickname if it doesn't already have one. This is how
`Ally Bank8794_Friction Buffer.csv` turns `Savings Account (8794)` into
something readable.

Formats handled, all from the real 2026-08-16 exports:

| Format | Header |
|---|---|
| `chase-bank` | `Details, Posting Date, Description, Amount, Type, Balance` |
| `chase-card` | `Transaction Date, Post Date, Description, Category, Type, Amount, Memo` |
| `usbank` | `"Date", "Transaction", "Name", "Memo", "Amount"` |
| `ally` | `Date, Time, Amount, Type, Description` |

An unrecognised header is refused rather than half-read.

## 1. Get the files onto the NAS

**Statements must never go through the repo** — it is public. Copy them
directly, from a **Windows** terminal (not the NAS session). `-O` is required;
this box's SFTP subsystem is restricted:

```powershell
ssh ywang1111@192.168.50.107 "mkdir -p /volume1/docker/household-finance-app/data/import/2026"

scp -O "D:\Claude Projects\Household Finance App\data\import\2026\*.csv" `
    ywang1111@192.168.50.107:/volume1/docker/household-finance-app/data/import/2026/
```

## 2. Back up and deploy

```bash
ssh ywang1111@192.168.50.107
cd /volume1/docker/household-finance-app
sudo docker exec household-finance-app node scripts/backup-db.js /data/backups

curl -L https://github.com/yangtaowang1111/household-finance-app/archive/refs/heads/master.tar.gz -o app.tar.gz
tar -xzf app.tar.gz --strip-components=1
rm app.tar.gz
sudo docker compose up -d --build
```

No migrations — this deploy is code only.

## 3. Dry run

```bash
sudo docker exec household-finance-app node scripts/import-statements.js --dry-run
```

Check three things in the report:

- **Every file resolved to the right account.** The `->` line is the one to
  read. A file under `COULD NOT IMPORT` needs its filename fixed, not a retry.
- **`outside window` is large, and that is correct.** The default window is
  `2026-01-01 .. 2026-05-20`, so everything from May 20 on is excluded because
  SimpleFIN already has it, and Chase Sapphire's December 2025 rows are excluded
  because the spreadsheet import already has *them*.
- **`sign anomalies` should be zero.** Every 2026 export checked so far is
  correctly signed. Anything listed here is a row whose amount disagrees with
  the bank's own DEBIT/CREDIT label — nothing is flipped automatically, because
  three of the 2025 cards genuinely did export inverted and the fix has to be a
  decision rather than a guess.

## 4. Import

```bash
sudo docker exec household-finance-app node scripts/import-statements.js
```

## 5. Categorise

Statement rows arrive with no category. The learned rules do most of the work,
so only genuinely new merchants reach the API:

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"limit": 500}' http://localhost:3000/api/categorize
```

The batch is capped at 500. If any remain, run it again — the count is printed.

## 6. Check the result

```bash
sudo docker exec household-finance-app node -e "
const db = require('./src/db');
const money = (n) => (n < 0 ? '-' : '') + '\$' + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log('transactions:', JSON.stringify(db.prepare('SELECT source, COUNT(*) n FROM transactions GROUP BY source').all()));
console.log('uncategorized:', db.prepare('SELECT COUNT(*) n FROM transactions WHERE category_id IS NULL').get().n);
console.table(db.prepare(\`
  SELECT COALESCE(p.name, c.name) AS grp, COUNT(*) AS txns, ROUND(SUM(t.amount), 2) AS total
  FROM transactions t JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories p ON p.id = c.parent_category_id
  WHERE t.date >= '2026-01-01' AND t.date < '2026-06-01'
  GROUP BY grp ORDER BY ABS(SUM(t.amount)) DESC\`).all());
"
```

**Sanity-check the transfers.** Ally's big deposits (a $10,000 and a $50,000 in
February) have matching outbound legs on Chase checking, tagged
`CHASE_TO_PARTNERFI`. Both sides are real transactions, but neither is income or
spending — they should land in **Transfers & Non-Spending**. If they show up
under Income, the 2026 numbers will be badly overstated.

## Adding the rest later

The remaining accounts (Sophia's cards) can be dropped into the same folder
whenever they're available and imported with the same command. Dedup is
count-based on account + date + amount + description, so previously imported
files are recognised and skipped.

Until then, **Jan–May 2026 spending is understated** — fine for building
against, not a basis for reading those months' budget-vs-actual.

## If something goes wrong

Restore the backup from step 2 — it is a plain SQLite file:

```bash
sudo docker compose down
sudo cp data/backups/finance-<timestamp>.db data/finance.db
sudo docker compose up -d
```

Nothing is written until step 4, so anything failing before then leaves the
database untouched.
