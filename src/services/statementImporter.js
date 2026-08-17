// Imports raw bank statement exports into `transactions`.
//
// Distinct from historyImporter.js, which loads the hand-categorised 2025
// spreadsheet. That file arrived with a category, an owner and notes on every
// row, so its job was mapping a human's vocabulary onto the app's. These files
// carry none of that — just date, description and amount — so this importer
// only has to land them accurately and leave `category_id` NULL for the
// existing categoriser to fill in against the learned rules.
//
// It also learns no rules, for the same reason: there are no human decisions
// in the source to learn from.
//
// Four formats, all seen in the real 2026-08-16 exports:
//
//   chase-bank   Details, Posting Date, Description, Amount, Type, Balance
//   chase-card   Transaction Date, Post Date, Description, Category, Type, ...
//   usbank       "Date", "Transaction", "Name", "Memo", "Amount"   (quoted)
//   ally         Date, Time, Amount, Type, Description   (leading spaces!)
//
// Two things about the real files drove the design:
//
//   1. A "2026" export is not confined to 2026. Chase Sapphire's file opens on
//      2025-12-29, and those 23 December rows are already in the database from
//      the spreadsheet import. So the window is bounded at BOTH ends, and the
//      lower bound is not optional.
//   2. Every one of these files is already correctly signed — unlike three of
//      the 2025 cards. So nothing is flipped here; instead the direction column
//      each bank provides (DEBIT/CREDIT, Sale/Payment, Deposit) is checked
//      against the sign and any disagreement is REPORTED. Silently flipping a
//      sign on a guess is how a $550 fee becomes $550 of income.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('../db');

/** Column sets that identify each bank's export, and how to read a row. */
const FORMATS = [
  {
    name: 'chase-bank',
    signature: ['Details', 'Posting Date', 'Description', 'Amount'],
    date: (r) => usDate(r['Posting Date']),
    amount: (r) => money(r.Amount),
    description: (r) => r.Description,
    // `Type` here is ACH_DEBIT/QUICKPAY_CREDIT/etc; `Details` is the plain
    // DEBIT/CREDIT that the sign should agree with.
    direction: (r) => r.Details,
  },
  {
    name: 'chase-card',
    signature: ['Transaction Date', 'Post Date', 'Description', 'Type', 'Amount'],
    // Transaction Date, not Post Date: it is the day the money was actually
    // spent, and it matches what the SimpleFIN rows use (transacted_at).
    date: (r) => usDate(r['Transaction Date']),
    amount: (r) => money(r.Amount),
    description: (r) => r.Description,
    direction: (r) => r.Type,
  },
  {
    name: 'usbank',
    signature: ['Date', 'Transaction', 'Name', 'Amount'],
    date: (r) => isoDate(r.Date),
    amount: (r) => money(r.Amount),
    // `Memo` holds card auth strings and "Download from usbank.com." — noise,
    // not a descriptor, so it is deliberately left out of merchant_raw.
    description: (r) => r.Name,
    direction: (r) => r.Transaction,
  },
  {
    name: 'ally',
    signature: ['Date', 'Time', 'Amount', 'Type', 'Description'],
    date: (r) => isoDate(r.Date),
    amount: (r) => money(r.Amount),
    description: (r) => r.Description,
    direction: (r) => r.Type,
  },
];

// Direction words that should carry a negative amount, and a positive one.
// "Adjustment" is deliberately absent — it legitimately goes either way.
const OUTFLOW = /^(DEBIT|Sale|Fee|Cash Advance|Withdrawal)$/i;
const INFLOW = /^(CREDIT|Payment|Return|Deposit|Refund)$/i;

// Filename segments that are structure rather than a name, so they never
// become an account nickname.
const NOT_A_NAME = /^(activity|transactions?|export|statement|download|csv)$/i;

const money = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "08/13/2026" -> "2026-08-13" */
function usDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** "2026-08-13" (or a longer timestamp) -> "2026-08-13" */
function isoDate(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Picks the format whose signature columns are all present, preferring the most
 * specific when several match — `ally` and `usbank` both have Date and Amount,
 * so a plain "first match wins" would misread one as the other.
 */
function detectFormat(columns) {
  const present = new Set(columns);
  const matches = FORMATS.filter((f) => f.signature.every((c) => present.has(c)));
  if (!matches.length) return null;
  return matches.sort((a, b) => b.signature.length - a.signature.length)[0];
}

/**
 * Works out which account a file belongs to from the last four digits in its
 * name, matched against the accounts that actually exist.
 *
 * Intersecting with real accounts is what makes this safe: a filename is full
 * of other four-digit runs (20260816, 01-01-2026), and only the ones naming a
 * known account survive. Ambiguity returns null rather than a guess — a file
 * attributed to the wrong card is a year of someone else's spending.
 */
function resolveAccount(filename, accountsByLast4) {
  const runs = new Set(String(filename).match(/\d{4}/g) || []);
  const hits = [...runs].filter((r) => accountsByLast4.has(r));
  if (hits.length !== 1) return { account: null, candidates: hits };
  return { account: accountsByLast4.get(hits[0]), candidates: hits };
}

/**
 * Pulls a human name out of a filename, for accounts SimpleFIN names badly.
 * "Ally Bank8794_Friction Buffer.csv" -> "Friction Buffer", which is a great
 * deal more use than "Savings Account (8794)". Segments containing digits are
 * skipped, so dates and account numbers never become a nickname.
 */
function nicknameFrom(filename) {
  const stem = path.basename(filename).replace(/\.csv$/i, '');
  for (const segment of stem.split('_').slice(1)) {
    const s = segment.trim();
    if (!s || /\d/.test(s) || NOT_A_NAME.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * Imports one statement file.
 *
 * @param {string} filePath
 * @param {object} options
 * @param {Map}    options.accountsByLast4  last four digits -> account row
 * @param {string} [options.from]    skip rows dated before this (inclusive bound)
 * @param {string} [options.before]  skip rows dated on or after this
 * @param {boolean} [options.dryRun]
 */
function importStatement(filePath, options) {
  const { accountsByLast4, from, before } = options;
  const filename = path.basename(filePath);
  const report = {
    file: filename,
    format: null,
    account: null,
    read: 0,
    imported: 0,
    skippedDuplicate: 0,
    skippedOutsideWindow: 0,
    skippedUnparsable: 0,
    signAnomalies: [],
    nickname: null,
    error: null,
  };

  const { account, candidates } = resolveAccount(filename, accountsByLast4);
  if (!account) {
    report.error = candidates.length
      ? `filename matches ${candidates.length} accounts (${candidates.join(', ')}) — rename it to name just one`
      : 'no known account number in the filename — add the last four digits';
    return report;
  }
  report.account = account.name;

  let rows;
  try {
    rows = parse(fs.readFileSync(filePath, 'utf8'), {
      // Ally writes "Date, Time, Amount" — the leading spaces are part of the
      // header text, so untrimmed keys would all miss.
      columns: (header) => header.map((c) => String(c).trim()),
      skip_empty_lines: true,
      // Chase's checking export ends rows with a stray extra comma.
      relax_column_count: true,
      trim: true,
    });
  } catch (err) {
    report.error = `could not parse: ${err.message}`;
    return report;
  }

  report.read = rows.length;
  if (!rows.length) return report;

  const format = detectFormat(Object.keys(rows[0]));
  if (!format) {
    report.error = `unrecognised columns: ${Object.keys(rows[0]).join(', ')}`;
    return report;
  }
  report.format = format.name;

  const countDuplicates = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
    WHERE account_id = ? AND date = ? AND ROUND(amount, 2) = ROUND(?, 2) AND merchant_raw = ?
  `);
  const insert = db.prepare(`
    INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
    VALUES (@account_id, @date, @amount, @merchant_raw, NULL, 'csv_import')
  `);

  // Same count-based approach as the spreadsheet import: these rows have no
  // external id, so the only key is account + date + amount + descriptor, and
  // real statements contain genuine same-day repeats. Comparing counts rather
  // than testing existence imports N copies once and none on a re-run.
  const seen = new Map();

  for (const row of rows) {
    const date = format.date(row);
    const amount = format.amount(row);
    const description = String(format.description(row) || '').replace(/\s+/g, ' ').trim();

    if (!date || amount === null || !description) {
      report.skippedUnparsable += 1;
      continue;
    }
    if ((from && date < from) || (before && date >= before)) {
      report.skippedOutsideWindow += 1;
      continue;
    }

    // Reported, never corrected. If a bank's export really is inverted it needs
    // a decision, not a silent guess applied to a whole file.
    const direction = String(format.direction(row) || '').trim();
    if ((OUTFLOW.test(direction) && amount > 0) || (INFLOW.test(direction) && amount < 0)) {
      report.signAnomalies.push(`${date} ${direction} ${amount} ${description.slice(0, 40)}`);
    }

    const key = `${date}|${amount.toFixed(2)}|${description}`;
    const alreadyHandled = seen.get(key) || 0;
    seen.set(key, alreadyHandled + 1);
    if (alreadyHandled < countDuplicates.get(account.id, date, amount, description).n) {
      report.skippedDuplicate += 1;
      continue;
    }

    if (!options.dryRun) {
      insert.run({ account_id: account.id, date, amount, merchant_raw: description });
    }
    report.imported += 1;
  }

  // Only fills a gap, never overwrites a name already chosen.
  const nickname = nicknameFrom(filename);
  if (nickname && !account.nickname) {
    report.nickname = nickname;
    if (!options.dryRun) {
      db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(nickname, account.id);
    }
  }

  return report;
}

/**
 * Imports every .csv in a directory, as one database transaction so a failure
 * part-way leaves nothing behind.
 */
function importStatements(dir, options = {}) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();

  const accounts = db.prepare('SELECT id, name, nickname FROM accounts').all();
  const accountsByLast4 = new Map();
  for (const account of accounts) {
    // The last four digits appearing anywhere in the account name — SimpleFIN
    // names them "Chase Freedom (2469)", "Checking - 3475 (3475)".
    const runs = String(account.name).match(/\d{4}/g);
    if (runs) accountsByLast4.set(runs[runs.length - 1], account);
  }

  const reports = [];
  const run = db.transaction(() => {
    for (const file of files) {
      reports.push(importStatement(path.join(dir, file), { ...options, accountsByLast4 }));
    }
    if (options.dryRun) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }

  return reports;
}

/** Thrown to roll back a dry run — never escapes importStatements. */
class DryRun extends Error {}

module.exports = {
  importStatements,
  importStatement,
  detectFormat,
  resolveAccount,
  nicknameFrom,
  usDate,
  isoDate,
  FORMATS,
};
