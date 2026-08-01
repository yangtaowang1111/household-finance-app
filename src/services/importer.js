const { parse } = require('csv-parse/sync');
const db = require('../db');

const HEADER_PATTERNS = {
  date: /^(date|transaction date|posted date)$/i,
  merchant: /^(description|merchant|payee|name)$/i,
  amount: /^(amount)$/i,
  debit: /^(debit|withdrawal)$/i,
  credit: /^(credit|deposit)$/i,
};

function detectColumns(headerRow) {
  const columns = {};
  for (const header of headerRow) {
    for (const [field, pattern] of Object.entries(HEADER_PATTERNS)) {
      if (pattern.test(header.trim())) columns[field] = header;
    }
  }
  return columns;
}

function toAmount(row, columns) {
  if (columns.amount) return parseFloat(row[columns.amount].replace(/[$,]/g, ''));
  const debit = columns.debit ? parseFloat(row[columns.debit] || '0') : 0;
  const credit = columns.credit ? parseFloat(row[columns.credit] || '0') : 0;
  return credit - debit;
}

function toIsoDate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable date: ${raw}`);
  return d.toISOString().slice(0, 10);
}

/**
 * Parses a CSV statement and inserts transactions for the given account.
 * Dedup strategy: since CSV rows carry no stable external id, an incoming
 * row is skipped if a transaction with the same account/date/amount/merchant
 * already exists.
 */
function importCsv(csvContent, accountId) {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  if (records.length === 0) return { imported: 0, skipped: 0 };

  const columns = detectColumns(Object.keys(records[0]));
  if (!columns.date || !columns.merchant || (!columns.amount && !columns.debit && !columns.credit)) {
    throw new Error(
      `Could not detect required columns from CSV header: ${Object.keys(records[0]).join(', ')}`
    );
  }

  const findExisting = db.prepare(`
    SELECT id FROM transactions
    WHERE account_id = ? AND date = ? AND amount = ? AND merchant_raw = ? AND source = 'csv_import'
  `);
  const insert = db.prepare(`
    INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
    VALUES (?, ?, ?, ?, 'csv_import')
  `);

  let imported = 0;
  let skipped = 0;

  const run = db.transaction((rows) => {
    for (const row of rows) {
      const date = toIsoDate(row[columns.date]);
      const amount = toAmount(row, columns);
      const merchant = row[columns.merchant];

      if (findExisting.get(accountId, date, amount, merchant)) {
        skipped += 1;
        continue;
      }
      insert.run(accountId, date, amount, merchant);
      imported += 1;
    }
  });

  run(records);
  return { imported, skipped };
}

module.exports = { importCsv, detectColumns };
