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
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  merchant_raw TEXT,
  category_id INTEGER REFERENCES categories(id),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'csv_import', 'manual')),
  simplefin_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

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
