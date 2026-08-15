CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  institution TEXT,
  type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'mortgage', 'loan')),
  current_balance REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'manual')),
  -- SimpleFIN's stable account id (format: 'ACT-<uuid>'). Required to match a
  -- remote account to its local row on every subsequent sync — without it, each
  -- sync would insert duplicate accounts. NULL for manually-created accounts.
  simplefin_id TEXT UNIQUE,
  -- Set true once a human has confirmed `type` is correct. SimpleFIN provides no
  -- account type, so type is inferred from the account name; the inference is
  -- unreliable for cards whose names carry no type keyword (e.g. "Chase Freedom").
  -- Sync never overwrites a confirmed type.
  type_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bucket TEXT CHECK (bucket IN ('retirement', 'investment', 'college_fund', 'emergency_fund', 'other')),
  parent_category_id INTEGER REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  -- The date the money was spent (SimpleFIN `transacted_at`), not the date it
  -- settled — that is what a person expects to see in a monthly budget. Stored
  -- as a local-timezone date; see TIMEZONE in .env.example.
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  merchant_raw TEXT,
  -- SimpleFIN's cleaned-up merchant name ("The Little Diner") next to the raw
  -- bank descriptor in merchant_raw ("TST*THE LITTLE DINER"). Generalizes far
  -- better for categorization rules. NULL for CSV/manual transactions.
  payee TEXT,
  category_id INTEGER REFERENCES categories(id),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'csv_import', 'manual')),
  -- SimpleFIN's transaction id ('TRN-<uuid>'). The protocol only guarantees
  -- uniqueness *within* an account, so dedup looks it up as (account_id,
  -- simplefin_id); the UNIQUE here is a strictly stronger belt-and-braces
  -- constraint that real 'TRN-<uuid>' values never trip.
  simplefin_id TEXT UNIQUE,
  -- 1 while the charge is still an authorization. Pending rows are excluded
  -- from sync by default: their amount changes on settlement (tips, fuel
  -- pre-auths) and SimpleFIN does not guarantee the id survives posting.
  pending INTEGER NOT NULL DEFAULT 0,
  -- When the transaction settled, if it has. NULL while pending.
  posted_at TEXT,
  -- Set on a synced transaction that looks like it duplicates an earlier
  -- hand-entered or CSV-imported row (same account/amount, near-identical
  -- date). Flagged for a human, never auto-deleted — see transactionSync.js.
  -- ON DELETE SET NULL because resolving the flag *is* deleting the row it
  -- points at; without it the intended cleanup fails on a FK constraint.
  possible_duplicate_of INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(pending) WHERE pending = 1;

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  month TEXT NOT NULL,
  budgeted_amount REAL NOT NULL,
  UNIQUE(category_id, month)
);

CREATE TABLE IF NOT EXISTS categorization_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_pattern TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per balance observation. Populated whenever an account is created
-- or its balance is updated (manual accounts today; SimpleFIN sync will
-- write these on every pull once Phase 3 lands). This is what net-worth-
-- over-time and per-account trend charts read from — `accounts.current_balance`
-- alone has no history.
CREATE TABLE IF NOT EXISTS account_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  balance REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_date ON account_balance_snapshots(account_id, recorded_at);

-- One row per sync attempt. This is the audit trail for an unattended cron job:
-- without it, a sync that quietly stopped working (bank needs re-auth, access
-- URL revoked) looks exactly like a month with no new transactions. It also
-- supplies the "when did we last succeed?" timestamp the incremental window
-- is derived from.
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('accounts', 'transactions', 'all')),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Transaction window actually requested (ISO dates), NULL for balance-only runs.
  window_start TEXT,
  window_end TEXT,
  accounts_created INTEGER NOT NULL DEFAULT 0,
  accounts_updated INTEGER NOT NULL DEFAULT 0,
  transactions_created INTEGER NOT NULL DEFAULT 0,
  transactions_updated INTEGER NOT NULL DEFAULT 0,
  pending_settled INTEGER NOT NULL DEFAULT 0,
  possible_duplicates INTEGER NOT NULL DEFAULT 0,
  -- JSON array of SimpleFIN's per-institution errors/advisories, plus any local
  -- failure message. A partial sync must never look like a clean one.
  errors TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
