CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  institution TEXT,
  type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment')),
  current_balance REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'manual')),
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
