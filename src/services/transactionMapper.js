// Maps a SimpleFIN transaction object onto this app's `transactions` schema.
// Pure — no database access — so it can be unit-tested and dry-run.
//
// Field shapes here were confirmed against 222 real transactions across 13
// accounts (2026-08-14 probe), not just the published protocol:
//
//   id            'TRN-<uuid>', unique within an account
//   posted        Unix timestamp; 0 while the transaction is pending
//   transacted_at Unix timestamp; present on every row, and 4 days ahead of
//                 `posted` at most (occasionally *behind* it)
//   amount        a STRING, negative for money out — same sign convention the
//                 account balances use
//   description   the raw bank descriptor ("TST*THE LITTLE DINER")
//   payee         a cleaned merchant name ("The Little Diner")
//   pending       present only when true
//   memo, mcc     present but empty/null on every row seen so far

// SimpleFIN timestamps are real moments, not date-only values (zero of 222 sat
// on a UTC midnight), so the calendar date depends on the timezone we read them
// in. About 4% of transactions — evening ones — land on a different day under
// UTC than under the household's own timezone, which is enough to push a
// purchase into the wrong budget month. Read TIMEZONE lazily so tests and the
// NAS container (whose system zone is UTC) can set it.
let cachedFormatter = null;
let cachedZone;

function dateFormatter() {
  const zone = process.env.TIMEZONE || undefined; // undefined => system timezone
  if (!cachedFormatter || zone !== cachedZone) {
    cachedZone = zone;
    cachedFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return cachedFormatter;
}

/** Unix seconds -> 'YYYY-MM-DD' in the household's timezone. */
function toLocalDate(timestamp) {
  return dateFormatter().format(new Date(timestamp * 1000));
}

/** Normalized merchant key used to match a settled charge to its pending twin. */
function normalizeMerchant(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Converts a SimpleFIN transaction into the shape the `transactions` table
 * expects. Throws on data that can't be trusted rather than storing a guess —
 * a bad amount or date is worse than a skipped row.
 *
 * @param {object} txn SimpleFIN transaction
 * @param {number} accountId Local accounts.id
 */
function mapTransaction(txn, accountId) {
  if (!txn || !txn.id) throw new Error('SimpleFIN transaction has no id');

  const amount = Number(txn.amount);
  if (!Number.isFinite(amount)) {
    throw new Error(`Transaction ${txn.id} has an unparseable amount: ${txn.amount}`);
  }

  const pending = txn.pending === true;
  const postedTs = Number(txn.posted) || null; // 0 while pending
  const transactedTs = Number(txn.transacted_at) || null;

  // Prefer when the money was actually spent; fall back to when it settled.
  const dateTs = transactedTs || postedTs;
  if (!dateTs) {
    throw new Error(`Transaction ${txn.id} has neither a transacted_at nor a posted timestamp`);
  }

  return {
    account_id: accountId,
    simplefin_id: txn.id,
    date: toLocalDate(dateTs),
    posted_at: postedTs ? new Date(postedTs * 1000).toISOString() : null,
    amount,
    merchant_raw: txn.description || txn.payee || null,
    payee: txn.payee || null,
    pending: pending ? 1 : 0,
  };
}

module.exports = { mapTransaction, toLocalDate, normalizeMerchant };
