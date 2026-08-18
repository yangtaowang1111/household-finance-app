// Schema migrations for databases that already exist.
//
// `schema.sql` stays the authoritative description of the current schema, but
// every statement in it is `CREATE ... IF NOT EXISTS`, so it can only ever add
// new tables — it silently does nothing to a table that already exists. Adding
// a column to `transactions` on the NAS (which holds live data) therefore needs
// a real migration.
//
// Each migration is idempotent by construction: it checks what is actually in
// the database before changing it. That means a fresh database — where
// schema.sql already created everything in its final shape — runs the same
// migrations as an old one and ends up identical, and a half-applied migration
// can be re-run safely. `PRAGMA user_version` records how far we got.

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumnIfMissing(db, table, column, definition) {
  // Migrations run before schema.sql, so on a brand-new database the table
  // isn't there yet — and doesn't need patching, because schema.sql is about to
  // create it in its final shape.
  if (!tableExists(db, table)) return false;
  if (columnNames(db, table).includes(column)) return false;
  // SQLite only allows ADD COLUMN with a REFERENCES clause when the default is
  // NULL, which is true of every column added here.
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'transaction-sync-fields',
    up(db) {
      const added = [];
      // Mirrors the transactions table as declared in schema.sql. Keep the two
      // in step: a new column belongs in both, or fresh and existing databases
      // drift apart.
      if (addColumnIfMissing(db, 'transactions', 'payee', 'TEXT')) added.push('payee');
      if (addColumnIfMissing(db, 'transactions', 'pending', 'INTEGER NOT NULL DEFAULT 0')) added.push('pending');
      if (addColumnIfMissing(db, 'transactions', 'posted_at', 'TEXT')) added.push('posted_at');
      if (addColumnIfMissing(db, 'transactions', 'possible_duplicate_of', 'INTEGER REFERENCES transactions(id)')) {
        added.push('possible_duplicate_of');
      }
      if (tableExists(db, 'transactions')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(pending) WHERE pending = 1');
      }
      return added;
    },
  },
  {
    version: 2,
    name: 'possible-duplicate-on-delete-set-null',
    up(db) {
      if (!tableExists(db, 'transactions')) return [];

      // Migration 1 added the column with a plain REFERENCES clause, which
      // defaults to ON DELETE NO ACTION. That makes the one operation the flag
      // exists for — deleting the duplicate row it points at — fail outright.
      // SQLite can't alter a constraint in place, so the table gets rebuilt.
      const fk = db
        .prepare('PRAGMA foreign_key_list(transactions)')
        .all()
        .find((row) => row.from === 'possible_duplicate_of');
      if (!fk || fk.on_delete === 'SET NULL') return [];

      // Column list and constraints must match schema.sql exactly.
      db.exec(`
        CREATE TABLE transactions_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id),
          date TEXT NOT NULL,
          amount REAL NOT NULL,
          merchant_raw TEXT,
          payee TEXT,
          category_id INTEGER REFERENCES categories(id),
          notes TEXT,
          source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'csv_import', 'manual')),
          simplefin_id TEXT UNIQUE,
          pending INTEGER NOT NULL DEFAULT 0,
          posted_at TEXT,
          possible_duplicate_of INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO transactions_rebuilt
          (id, account_id, date, amount, merchant_raw, payee, category_id, notes,
           source, simplefin_id, pending, posted_at, possible_duplicate_of, created_at)
        SELECT
           id, account_id, date, amount, merchant_raw, payee, category_id, notes,
           source, simplefin_id, pending, posted_at, possible_duplicate_of, created_at
        FROM transactions;

        DROP TABLE transactions;
        ALTER TABLE transactions_rebuilt RENAME TO transactions;

        CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
        CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(pending) WHERE pending = 1;
      `);

      const violations = db.prepare('PRAGMA foreign_key_check(transactions)').all();
      if (violations.length > 0) {
        // Inside the migration's transaction, so this rolls the rebuild back.
        throw new Error(`transactions rebuild left ${violations.length} foreign key violations`);
      }

      return ['rebuilt transactions with ON DELETE SET NULL'];
    },
  },
  {
    version: 3,
    name: 'accounts-simplefin-fields',
    up(db) {
      if (!tableExists(db, 'accounts')) return [];

      // Phase 3's account sync added `simplefin_id`, `currency` and
      // `type_confirmed` to accounts, and widened the `type` CHECK to accept
      // mortgages and loans — but only in schema.sql, which cannot alter a
      // table that already exists. The dev database was recreated at the time
      // so it never showed; the NAS database was not, and still has the Phase 2
      // shape. Without this migration, `accountSync.js` prepares
      // `SELECT ... WHERE simplefin_id = ?` at module load, throws
      // `no such column`, and the container restart-loops without ever binding
      // a port.
      const added = [];
      if (addColumnIfMissing(db, 'accounts', 'simplefin_id', 'TEXT')) added.push('simplefin_id');
      if (addColumnIfMissing(db, 'accounts', 'currency', "TEXT NOT NULL DEFAULT 'USD'")) added.push('currency');
      if (addColumnIfMissing(db, 'accounts', 'type_confirmed', 'INTEGER NOT NULL DEFAULT 0')) {
        added.push('type_confirmed');
      }

      // ADD COLUMN can't carry UNIQUE, and a CHECK can't be altered at all, so
      // reaching schema.sql's exact shape needs a rebuild. Skipped entirely on
      // a database already created from the current schema.
      const currentSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
        .get().sql;
      const needsRebuild = !currentSql.includes("'mortgage'") || !/simplefin_id\s+TEXT\s+UNIQUE/i.test(currentSql);
      if (!needsRebuild) return added;

      // Column list and constraints must match schema.sql exactly.
      db.exec(`
        CREATE TABLE accounts_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          institution TEXT,
          type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'mortgage', 'loan')),
          current_balance REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'manual')),
          simplefin_id TEXT UNIQUE,
          type_confirmed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO accounts_rebuilt
          (id, name, institution, type, current_balance, currency, source, simplefin_id, type_confirmed, created_at)
        SELECT
           id, name, institution, type, current_balance, currency, source, simplefin_id, type_confirmed, created_at
        FROM accounts;

        DROP TABLE accounts;
        ALTER TABLE accounts_rebuilt RENAME TO accounts;
      `);

      // transactions and account_balance_snapshots both reference accounts(id);
      // confirm the rebuild didn't strand either of them.
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`accounts rebuild left ${violations.length} foreign key violations`);
      }

      added.push('rebuilt accounts for the widened type CHECK and UNIQUE simplefin_id');
      return added;
    },
  },
  {
    version: 4,
    name: 'accounts-property-nickname-owner',
    up(db) {
      if (!tableExists(db, 'accounts')) return [];

      const added = [];
      if (addColumnIfMissing(db, 'accounts', 'nickname', 'TEXT')) added.push('nickname');
      if (addColumnIfMissing(db, 'accounts', 'owner', 'TEXT')) added.push('owner');

      // 'property' lets a house be held as an asset account. Without it the
      // only way to record one is to mislabel it 'investment', which would
      // corrupt any investment view later. A CHECK can't be altered in place,
      // so this needs the same rebuild migration 3 used.
      const currentSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
        .get().sql;
      if (currentSql.includes("'property'")) return added;

      db.exec(`
        CREATE TABLE accounts_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          institution TEXT,
          type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'mortgage', 'loan', 'property')),
          current_balance REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          nickname TEXT,
          owner TEXT,
          source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('simplefin', 'manual')),
          simplefin_id TEXT UNIQUE,
          type_confirmed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO accounts_rebuilt
          (id, name, institution, type, current_balance, currency, nickname, owner, source, simplefin_id, type_confirmed, created_at)
        SELECT
           id, name, institution, type, current_balance, currency, nickname, owner, source, simplefin_id, type_confirmed, created_at
        FROM accounts;

        DROP TABLE accounts;
        ALTER TABLE accounts_rebuilt RENAME TO accounts;
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`accounts rebuild left ${violations.length} foreign key violations`);
      }

      added.push("rebuilt accounts to allow type 'property'");
      return added;
    },
  },
  {
    version: 5,
    name: 'categories-counts-as-spending',
    up(db) {
      if (!tableExists(db, 'categories')) return [];

      const added = [];
      if (addColumnIfMissing(db, 'categories', 'counts_as_spending', 'INTEGER NOT NULL DEFAULT 1')) {
        added.push('counts_as_spending');
      }

      // UNIQUE on name lets the taxonomy seed upsert instead of duplicating on
      // every boot. Adding a constraint needs a rebuild; ids are preserved, so
      // transactions.category_id references stay valid (foreign keys are off
      // for the duration — see migrate()).
      const currentSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'categories'")
        .get().sql;
      if (/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(currentSql)) return added;

      const dupes = db
        .prepare('SELECT name, COUNT(*) AS n FROM categories GROUP BY name HAVING n > 1')
        .all();
      if (dupes.length > 0) {
        throw new Error(
          `cannot add UNIQUE(name) to categories — duplicates exist: ${dupes.map((d) => d.name).join(', ')}`
        );
      }

      db.exec(`
        CREATE TABLE categories_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          bucket TEXT CHECK (bucket IN ('retirement', 'investment', 'college_fund', 'emergency_fund', 'other')),
          parent_category_id INTEGER REFERENCES categories(id),
          counts_as_spending INTEGER NOT NULL DEFAULT 1
        );

        INSERT INTO categories_rebuilt (id, name, bucket, parent_category_id, counts_as_spending)
        SELECT id, name, bucket, parent_category_id, counts_as_spending FROM categories;

        DROP TABLE categories;
        ALTER TABLE categories_rebuilt RENAME TO categories;
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`categories rebuild left ${violations.length} foreign key violations`);
      }

      added.push('rebuilt categories with UNIQUE(name)');
      return added;
    },
  },
  {
    version: 6,
    name: 'accounts-secured-by',
    up(db) {
      if (!tableExists(db, 'accounts')) return [];

      // Held on the LOAN row, pointing at the property that secures it — the
      // direction the sentence runs ("this mortgage is secured by that house").
      // It also degrades better than the reverse would: a property with no
      // mortgage is simply unreferenced, and a second loan against the same
      // property is another row pointing at it, which a single column on the
      // property could not express.
      //
      // Nullable, because most accounts secure nothing and the pairing cannot be
      // inferred — two mortgages and two properties have no shared field to join
      // on, and guessing puts the wrong equity against the rental, which is the
      // number that matters for Schedule E.
      const added = [];
      if (addColumnIfMissing(db, 'accounts', 'secured_by_account_id', 'INTEGER REFERENCES accounts(id)')) {
        added.push('secured_by_account_id');
      }
      return added;
    },
  },
  {
    version: 7,
    name: 'transactions-categorized-by',
    up(db) {
      if (!tableExists(db, 'transactions')) return [];

      // How a category got there: 'rule', 'ai', 'manual', or 'import'.
      //
      // Recorded rather than re-derived, because a rule that matched in
      // February may not exist in August — asking "which rule matches this
      // now?" would rewrite the past every time the rule set changed. It also
      // could not distinguish a rule that matched from a human who happened to
      // agree with it.
      //
      // The distinction is the whole point of the review screen: an AI guess
      // that went wrong is one bad row, while a rule that went wrong is every
      // future transaction from that merchant. Those need different fixes.
      //
      // NULL on the 2,565 rows that predate this, which is honest — nothing
      // recorded how they were filed.
      const added = [];
      if (addColumnIfMissing(db, 'transactions', 'categorized_by', 'TEXT')) {
        added.push('categorized_by');
      }
      return added;
    },
  },
  {
    version: 8,
    name: 'review-flag-and-always-review-rules',
    up(db) {
      const added = [];
      if (!tableExists(db, 'transactions')) return added;

      // A real flag instead of a string match on `notes`.
      //
      // The review queue was previously found with `notes LIKE 'AI confidence:
      // low%'`, which conflates two different things: a note is something a
      // human wrote about a transaction, and a review flag is a state the
      // system is in. Writing the flag into the note meant a user note could
      // never coexist with a flag, and any note starting with those words would
      // masquerade as one.
      if (addColumnIfMissing(db, 'transactions', 'needs_review', 'INTEGER NOT NULL DEFAULT 0')) {
        added.push('needs_review');

        // Move the existing queue across, then drop the synthetic notes — they
        // were never user content and now say nothing the flag doesn't.
        const moved = db
          .prepare("UPDATE transactions SET needs_review = 1 WHERE notes LIKE 'AI confidence: low%'")
          .run().changes;
        db.prepare("UPDATE transactions SET notes = NULL WHERE notes LIKE 'AI confidence: low%'").run();
        if (moved) added.push(`migrated ${moved} flagged transactions off notes`);
      }

      if (!tableExists(db, 'categorization_rules')) return added;

      // Rules that categorise but still ask for a human.
      //
      // Zelle is the case that needs it: the descriptor identifies the sender,
      // so a rule can file "Zelle payment from XINPEI FU" reliably, but whether
      // a given transfer is a gift, a repayment or rent is not in the data at
      // all — Chase does not pass the memo through. A rule can therefore get it
      // mostly right and still be wrong, which is exactly when a category
      // should arrive pre-filled rather than trusted.
      if (addColumnIfMissing(db, 'categorization_rules', 'always_review', 'INTEGER NOT NULL DEFAULT 0')) {
        added.push('always_review');
      }
      return added;
    },
  },
  {
    version: 9,
    name: 'categories-forecast-method',
    up(db) {
      if (!tableExists(db, 'categories')) return [];

      // How this category's remaining year should be projected. NULL means
      // "work it out from the shape", which is right for nearly all of them —
      // the column exists for the handful where a person knows something the
      // history does not show.
      //
      // Childcare is the example that motivates it: statistically it is a
      // rock-steady recurring cost, and it will fall off a cliff the month
      // school starts. No amount of variance analysis sees that coming.
      const added = [];
      if (addColumnIfMissing(db, 'categories', 'forecast_method', 'TEXT')) {
        added.push('forecast_method');
      }
      return added;
    },
  },
  {
    version: 10,
    name: 'settings',
    up(db) {
      // Household facts the transaction data cannot contain.
      //
      // The motivating case is 401(k) deferrals: they are deducted from gross
      // pay before anything reaches a bank account, so they appear in neither
      // income nor spending. The savings rate is therefore understated by
      // exactly the amount being saved hardest — invisible on both sides of the
      // calculation. Two numbers a year fix it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      return ['settings table'];
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Applies any migrations the database hasn't seen yet.
 * @returns {{from: number, to: number, applied: string[]}}
 */
function migrate(db, { log = false } = {}) {
  const from = db.pragma('user_version', { simple: true });
  const applied = [];
  const pending = MIGRATIONS.filter((migration) => migration.version > from);
  if (pending.length === 0) return { from, to: from, applied };

  // Foreign keys have to be off while a table is rebuilt: dropping the old
  // `transactions` would otherwise trip its own self-reference, and SQLite
  // would rewrite references in other tables to follow the renamed one. The
  // pragma is a no-op inside a transaction, so it has to be set out here.
  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysWereOn) db.pragma('foreign_keys = OFF');

  try {
    for (const migration of pending) {
      // Each migration commits with its own version stamp, so an interrupted run
      // never leaves the stamp ahead of the schema.
      const run = db.transaction(() => {
        const changes = migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
        return changes;
      });

      const changes = run();
      applied.push(migration.name);
      if (log) {
        const detail = Array.isArray(changes) && changes.length ? ` (${changes.join(', ')})` : ' (already current)';
        console.log(`Applied migration ${migration.version}: ${migration.name}${detail}`);
      }
    }
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }

  return { from, to: db.pragma('user_version', { simple: true }), applied };
}

module.exports = { migrate, MIGRATIONS, LATEST_VERSION };
