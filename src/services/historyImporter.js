// Imports the hand-categorised historical spreadsheet (one row per transaction,
// exported from the household's Google Sheet) into `transactions`.
//
// This is a different job from importer.js, which parses a raw bank CSV. Here
// the rows are already categorised by a human, with notes — so the work is
// mapping their vocabulary onto the app's, correcting the source data's quirks,
// and harvesting a year of category decisions into `categorization_rules`.
//
// Three source-data facts drive the design, all found by profiling the real
// file rather than assumed:
//
//   1. Three of the cards export with INVERTED SIGNS. Chase writes purchases
//      negative and payments positive; Hilton Amex, Nordstrom and United do the
//      opposite. Left uncorrected, a $550 annual fee reads as +$550 income.
//   2. The category column has case variants and typos ("Dining out"/"Dining
//      Out", "Phamacy", "SHopping"). taxonomy.js absorbs these on lookup.
//   3. The notes column carries detail the category doesn't — golf gear vs.
//      green fees, coffee vs. restaurants — so it refines the mapping.

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { resolveCategory } = require('../db/taxonomy');

// Spreadsheet account name (substring match) -> existing account name in the DB.
// Only confident matches belong here; anything else creates its own account so
// a guess never silently attributes a year of spending to the wrong card.
// Note "PREMIER PLUS CKG" is a CHASE product (Chase Premier Plus Checking),
// not U.S. Bank — SimpleFIN's institution field confirms it, and the
// transaction volumes agree (Chase checking is the busy one at 322 rows/year;
// U.S. Bank checking has 51). An earlier version of this list had the two
// swapped.
const ACCOUNT_MATCHES = [
  ["Tony's 2025 Chase Sapphire Reserve", 'Chase Sapphire Reserve (7530)'],
  ['2025 Chase Checking Account', 'PREMIER PLUS CKG (0221)'],
  ['2025 Chase Savings Account', 'PREMIER SAVINGS (1260)'], // the only Chase savings
  ['2025 US Bank Checking Account', 'Checking - 3475 (3475)'],
  ["Tony's 2025 US Bank FlexPerks", 'Credit Card - 6288 (6288)'],
  ["Tony's 2025 Chase Southwest", 'Rapid Rewards Plus (4696)'],
  // Name match; the sheet's 6 rows and this card's near-zero recent activity
  // agree. "Chase Freedom Unlimited (5053)" is a different card and is heavily
  // used in 2026 but absent from 2025 — likely opened since.
  ["Tony's 2025 Chase Freedom Credit Card", 'Chase Freedom (2469)'],
];

// Cards whose export writes purchases positive and payments negative.
const INVERTED_SIGN = ["Hilton American Express", 'Nordstrom', 'United Chase'];

// A rule is only learned when the same normalised merchant was categorised the
// same way repeatedly — one-off Zelle payments and unique order ids never
// qualify, which is exactly right.
const MIN_OCCURRENCES = 2;
const MIN_AGREEMENT = 0.8;

/**
 * Reduces a bank descriptor to something that will match future transactions:
 * strips ACH identifiers, store numbers and per-order references.
 *   "CHICK-FIL-A #1111"                      -> "CHICK-FIL-A"
 *   "AMAZON MKTPL*NW7WD4B52"                 -> "AMAZON MKTPL"
 *   "PRIMROSE SCHOOL 7204887400 PPD ID: ..." -> "PRIMROSE SCHOOL"
 */
function merchantPattern(description) {
  return String(description || '')
    .replace(/\b(PPD|WEB|TEL|CCD)\s+ID:.*$/i, '')
    .replace(/[*#]\s*[A-Z0-9]{4,}\s*$/i, '')
    .replace(/\s+#\s*\d+\s*$/, '')
    .replace(/\s{2,}[\d\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const isInverted = (accountName) => INVERTED_SIGN.some((frag) => accountName.includes(frag));

function matchExistingAccount(sheetName) {
  for (const [fragment, dbName] of ACCOUNT_MATCHES) {
    if (sheetName.includes(fragment)) return dbName;
  }
  return null;
}

/** Spreadsheet Account_Type -> the schema's account type. */
function accountType(sheetType) {
  const t = String(sheetType || '').toLowerCase();
  if (t.includes('credit')) return 'credit';
  if (t.includes('saving')) return 'savings';
  return 'checking';
}

/**
 * Imports the spreadsheet.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {boolean} [options.dryRun]  Report what would happen, write nothing.
 * @param {string}  [options.before]  Only import rows dated before this
 *   ISO date. Defaults to leaving SimpleFIN's window alone.
 */
function importHistory(filePath, options = {}) {
  const rows = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const result = {
    read: rows.length,
    imported: 0,
    skippedDuplicate: 0,
    skippedAfterCutoff: 0,
    signsFlipped: 0,
    unresolvedCategories: {},
    accountsCreated: [],
    accountsMatched: [],
    rulesLearned: 0,
    rulesSkippedConflict: 0,
  };

  const categoryByName = new Map(
    db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name, c.id])
  );
  const uncategorizedId = categoryByName.get('Uncategorized');

  const selectAccountByName = db.prepare('SELECT id FROM accounts WHERE name = ?');
  const insertAccount = db.prepare(`
    INSERT INTO accounts (name, type, current_balance, source, owner, nickname)
    VALUES (@name, @type, 0, 'manual', @owner, @nickname)
  `);
  // Counted, not merely existence-checked. These rows carry no external id, so
  // the only available key is account + date + amount + descriptor — and the
  // real data contains genuine same-day repeats (two Western Union transfers on
  // one day, two $4 range buckets). An existence check silently swallows the
  // second of each. Comparing counts imports N copies the first time and zero
  // on a re-run.
  const countDuplicates = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
    WHERE account_id = ? AND date = ? AND ROUND(amount, 2) = ROUND(?, 2) AND merchant_raw = ?
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, notes, source)
    VALUES (@account_id, @date, @amount, @merchant_raw, @category_id, @notes, 'csv_import')
  `);
  const upsertRule = db.prepare(`
    INSERT INTO categorization_rules (merchant_pattern, category_id)
    VALUES (?, ?)
    ON CONFLICT(merchant_pattern) DO UPDATE SET category_id = excluded.category_id
  `);

  const accountIds = new Map();
  // merchant pattern -> { categoryName: count }
  const merchantVotes = new Map();
  // account|date|amount|descriptor -> how many copies this run has handled
  const seenKeys = new Map();

  const run = db.transaction(() => {
    for (const row of rows) {
      const date = String(row.Date || '').slice(0, 10);
      if (!date) continue;
      if (options.before && date >= options.before) {
        result.skippedAfterCutoff += 1;
        continue;
      }

      const sheetAccount = String(row.Account_Name || '').trim();

      // --- resolve (and if necessary create) the account ---
      if (!accountIds.has(sheetAccount)) {
        const matchName = matchExistingAccount(sheetAccount);
        // Prefer the mapped synced account; fall back to one previously created
        // under the sheet's own name. Without that fallback a mapping whose
        // target doesn't exist yet creates an account under the sheet name and
        // then fails to find it next run — duplicating the account and every
        // transaction on it.
        const existing =
          (matchName && selectAccountByName.get(matchName)) || selectAccountByName.get(sheetAccount);
        if (existing) {
          accountIds.set(sheetAccount, existing.id);
          if (matchName && existing.id === (selectAccountByName.get(matchName) || {}).id) {
            result.accountsMatched.push(`${sheetAccount} -> ${matchName}`);
          }
        } else {
          const id = insertAccount.run({
            name: sheetAccount,
            type: accountType(row.Account_Type),
            owner: row.Owner || null,
            nickname: null,
          }).lastInsertRowid;
          accountIds.set(sheetAccount, id);
          result.accountsCreated.push(sheetAccount);
        }
      }
      const accountId = accountIds.get(sheetAccount);

      // --- amount, with the per-account sign correction ---
      let amount = parseFloat(row.Amount);
      if (!Number.isFinite(amount)) continue;
      if (isInverted(sheetAccount)) {
        amount = -amount;
        result.signsFlipped += 1;
      }

      // --- category ---
      const leaf = resolveCategory(row.Spending_Category, row.User_Notes);
      let categoryId = leaf ? categoryByName.get(leaf) : undefined;
      if (categoryId === undefined) {
        const key = String(row.Spending_Category || '(blank)').trim();
        result.unresolvedCategories[key] = (result.unresolvedCategories[key] || 0) + 1;
        categoryId = uncategorizedId;
      }

      const description = String(row.Description || '').trim();
      const notes = String(row.User_Notes || '').trim() || null;

      // Skip only as many copies as the database already holds; anything beyond
      // that is a genuine repeat and gets imported.
      const key = `${accountId}|${date}|${amount.toFixed(2)}|${description}`;
      const seenSoFar = seenKeys.get(key) || 0;
      seenKeys.set(key, seenSoFar + 1);
      if (seenSoFar < countDuplicates.get(accountId, date, amount, description).n) {
        result.skippedDuplicate += 1;
        continue;
      }

      if (!options.dryRun) {
        insertTransaction.run({
          account_id: accountId,
          date,
          amount,
          merchant_raw: description,
          category_id: categoryId ?? null,
          notes,
        });
      }
      result.imported += 1;

      // --- bank a vote toward a learned rule ---
      if (leaf) {
        const pattern = merchantPattern(description);
        if (pattern.length >= 4) {
          if (!merchantVotes.has(pattern)) merchantVotes.set(pattern, {});
          const votes = merchantVotes.get(pattern);
          votes[leaf] = (votes[leaf] || 0) + 1;
        }
      }
    }

    // --- turn the votes into rules ---
    for (const [pattern, votes] of merchantVotes) {
      const entries = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((sum, [, n]) => sum + n, 0);
      const [topName, topCount] = entries[0];

      if (total < MIN_OCCURRENCES) continue;
      if (topCount / total < MIN_AGREEMENT) {
        // The same merchant was filed under several categories often enough
        // that no single answer is safe — better no rule than a wrong one.
        result.rulesSkippedConflict += 1;
        continue;
      }

      const categoryId = categoryByName.get(topName);
      if (!categoryId) continue;
      if (!options.dryRun) upsertRule.run(pattern, categoryId);
      result.rulesLearned += 1;
    }

    if (options.dryRun) throw new DryRun(result);
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }

  return result;
}

/** Thrown to roll back a dry run — never escapes importHistory. */
class DryRun extends Error {
  constructor(result) {
    super('dry run');
    this.result = result;
  }
}

module.exports = { importHistory, merchantPattern };
