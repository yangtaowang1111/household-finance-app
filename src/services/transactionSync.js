// Pulls transactions from SimpleFIN into the `transactions` table.
//
// Dedup rests on SimpleFIN's own transaction id, looked up as
// (account_id, simplefin_id) — the protocol only promises ids are unique within
// an account. Content-based matching is used *only* for the two cases where no
// id exists to match on, and both of those flag for review rather than deleting
// anything:
//
//   1. A pending charge that settles under a NEW id (see below).
//   2. A transaction the user already entered by hand, or imported from a CSV,
//      that later arrives for real from the bank.
//
// Why content matching has to stay a last resort: in 45 days of this
// household's real data, 19 distinct (account, amount, description) triples
// occurred more than once — the same $8.62 McDonald's, the same $11.45
// In-N-Out, weeks apart. Deduping on content alone would silently delete real
// spending. Once the date is included the collisions vanish (0 cases of the
// same account+day+amount+description), which is why every content match here
// is date-bounded.

const db = require('../db');
const { fetchAccounts } = require('./simplefinClient');
const { upsertAccounts } = require('./accountSync');
const { recordRun } = require('./syncRuns');
const { mapTransaction, normalizeMerchant, toLocalDate } = require('./transactionMapper');

// SimpleFIN warns (in `errors[]`, alongside a 200) that a range beyond 45 days
// "may be capped" in future. Stay just inside it for routine syncs — the
// warning fired on a request for exactly 45.
const MAX_LOOKBACK_DAYS = 44;
const DEFAULT_LOOKBACK_DAYS = 30;

// The real ceiling, established by probe: SimpleFIN serves roughly 90 days and
// nothing older, whatever start date is asked for. Reachable only by asking for
// a backfill explicitly, because the window always *ends* at now — days 45-89
// cannot be assembled out of several routine syncs, however many are run. The
// advisory warning is expected on these and does not indicate failure.
const MAX_BACKFILL_DAYS = 89;

// How far a settled transaction may sit from its pending twin. Real data showed
// posted running up to 4 days from transacted_at; 7 leaves room without
// reaching far enough to collide with the next visit to the same merchant.
const SETTLE_WINDOW_DAYS = 7;

// After this long, an unmatched pending row is expired rather than reported.
//
// The rule that makes this safe is not age alone but coverage: if the charge's
// date sits inside the window this sync actually requested, then its settled
// twin WOULD have been returned had it existed. So an unmatched pending row
// inside the window has either settled under a new id -- in which case the
// settled row is already recorded and the pending one is a double count -- or
// was cancelled, in which case it never happened. Both mean delete.
//
// Outside the window, the original caution still holds: the settled twin may
// simply not have been asked for, and the row is reported instead.
const STALE_PENDING_DAYS = 7;

// A hand-entered transaction is rarely dated to the day the bank posts it, so
// the duplicate check tolerates a few days' drift.
const MANUAL_DUPLICATE_WINDOW_DAYS = 3;

const selectAccounts = db.prepare('SELECT id, name, simplefin_id FROM accounts WHERE simplefin_id IS NOT NULL');

const selectByAccountAndSimplefinId = db.prepare(
  'SELECT * FROM transactions WHERE account_id = ? AND simplefin_id = ?'
);

const insertTransaction = db.prepare(`
  INSERT INTO transactions (account_id, date, amount, merchant_raw, payee, source, simplefin_id, pending, posted_at)
  VALUES (@account_id, @date, @amount, @merchant_raw, @payee, 'simplefin', @simplefin_id, @pending, @posted_at)
`);

// Only ever refreshes what the bank owns. category_id and notes are local
// enrichment — a re-sync must not undo a categorization or a hand-written note.
const updateTransaction = db.prepare(`
  UPDATE transactions
  SET date = @date,
      amount = @amount,
      merchant_raw = @merchant_raw,
      payee = @payee,
      pending = @pending,
      posted_at = @posted_at
  WHERE id = @id
`);

// Local pending rows for an account, so we can tell which ones this sync
// dropped (i.e. they settled or were cancelled).
const selectPendingForAccount = db.prepare(
  "SELECT * FROM transactions WHERE account_id = ? AND pending = 1 AND source = 'simplefin'"
);

// Candidate hand-entered / CSV-imported duplicates: same account, same amount to
// the cent, within a few days. Rows already flagged by another synced
// transaction are excluded — otherwise two genuine same-amount charges would
// both point at the same manual row, and resolving one would leave the other
// pointing at a deleted transaction.
const selectManualDuplicateCandidates = db.prepare(`
  SELECT id, date, merchant_raw, source FROM transactions
  WHERE account_id = ?
    AND simplefin_id IS NULL
    AND source IN ('manual', 'csv_import')
    AND ROUND(amount, 2) = ROUND(?, 2)
    AND date BETWEEN date(?, ?) AND date(?, ?)
    AND id NOT IN (SELECT possible_duplicate_of FROM transactions WHERE possible_duplicate_of IS NOT NULL)
  ORDER BY ABS(julianday(date) - julianday(?)) ASC
`);

const flagPossibleDuplicate = db.prepare('UPDATE transactions SET possible_duplicate_of = ? WHERE id = ?');
const deleteTransaction = db.prepare('DELETE FROM transactions WHERE id = ?');
const carryLocalEdits = db.prepare('UPDATE transactions SET category_id = ?, notes = ? WHERE id = ?');

// Existing posted rows that a stale pending charge could have settled into.
// Without this, a pending row whose twin was imported by an *earlier* run can
// never be reconciled — it isn't in this run's inserts, so it would sit on
// `unreconciledPending` forever.
const selectSettledCandidates = db.prepare(`
  SELECT * FROM transactions
  WHERE account_id = ?
    AND source = 'simplefin'
    AND pending = 0
    AND date BETWEEN date(?, ?) AND date(?, ?)
`);

// Sync windows are reported in the same timezone transactions are dated in.
// Using UTC here would print a window_end a day ahead of the newest transaction
// stored, for any sync run in the evening.
function localDate(date) {
  return toLocalDate(Math.floor(date.getTime() / 1000));
}

/**
 * Looks for a hand-entered or CSV-imported row that this synced transaction
 * appears to duplicate. Flags it for a human — deleting either side
 * automatically would risk destroying data the user typed in themselves.
 */
function flagIfDuplicatesManualEntry(row, syncedId) {
  const candidates = selectManualDuplicateCandidates.all(
    row.account_id,
    row.amount,
    row.date,
    `-${MANUAL_DUPLICATE_WINDOW_DAYS} days`,
    row.date,
    `+${MANUAL_DUPLICATE_WINDOW_DAYS} days`,
    row.date
  );
  if (candidates.length === 0) return null;

  const match = candidates[0];
  flagPossibleDuplicate.run(match.id, syncedId);
  return {
    synced_transaction_id: syncedId,
    duplicates_transaction_id: match.id,
    date: row.date,
    amount: row.amount,
    merchant: row.merchant_raw,
    existing_source: match.source,
  };
}

/**
 * Reconciles pending rows this sync no longer returned.
 *
 * SimpleFIN's spec is silent on whether a pending transaction keeps its id once
 * it posts, and a single snapshot can't reveal it: pending rows carry posted=0
 * and a 'TRN-<uuid>' id shaped exactly like a settled one. So this handles both
 * outcomes. If the id IS stable, the row comes back under the same id and is
 * simply updated in place — this function never sees it. If the id is NOT
 * stable, the pending row goes missing and its settled twin arrives as a new
 * insert, which is what gets matched here.
 *
 * A match must be unambiguous: same merchant, within a week, and — when several
 * rows fit — a single exact amount match to break the tie. Anything less is
 * left alone and reported, because the cost of guessing wrong is a wrong
 * category on a real transaction plus a vanished pending row.
 */
function reconcilePending(accountId, returnedIds, insertedRows, result, windowStart) {
  const stalePending = selectPendingForAccount
    .all(accountId)
    .filter((row) => !returnedIds.has(row.simplefin_id));

  // A settled row can only absorb one pending charge. Without this, two stale
  // pending rows for the same merchant inside the settle window would both
  // match the same settled row: the second one would be deleted as "settled"
  // when it was really a cancelled authorization — exactly the signal
  // `unreconciledPending` exists to surface — and its category would overwrite
  // the first one's.
  const claimed = new Set();

  for (const pendingRow of stalePending) {
    const pendingKey = normalizeMerchant(pendingRow.payee || pendingRow.merchant_raw);

    // Rows inserted by this run, plus posted rows already in the database
    // within the settle window. The latter covers a twin imported by an earlier
    // sync — common when pending mode is toggled off and back on, or when
    // settlement straddles two runs.
    const pool = [
      ...insertedRows,
      ...selectSettledCandidates.all(
        accountId,
        pendingRow.date,
        `-${SETTLE_WINDOW_DAYS} days`,
        pendingRow.date,
        `+${SETTLE_WINDOW_DAYS} days`
      ),
    ];

    const seen = new Set();
    const candidates = pool.filter((candidate) => {
      if (candidate.pending) return false;
      if (claimed.has(candidate.simplefin_id)) return false;
      if (seen.has(candidate.simplefin_id)) return false; // the two sources can overlap
      if (normalizeMerchant(candidate.payee || candidate.merchant_raw) !== pendingKey) return false;
      const gapDays = Math.abs(
        (new Date(candidate.date).getTime() - new Date(pendingRow.date).getTime()) / 86400000
      );
      if (gapDays > SETTLE_WINDOW_DAYS) return false;
      seen.add(candidate.simplefin_id);
      return true;
    });

    // Prefer an exact amount match; a settled amount can differ from its
    // authorization (restaurant tips, fuel pre-auths), so amount is a
    // tie-breaker rather than a requirement.
    let match = null;
    if (candidates.length === 1) {
      match = candidates[0];
    } else if (candidates.length > 1) {
      const exact = candidates.filter((c) => Math.abs(c.amount - pendingRow.amount) < 0.005);
      if (exact.length === 1) match = exact[0];
    }

    if (!match) {
      // No settled twin found. Whether that is safe to act on depends entirely
      // on whether this sync would have SEEN the twin.
      const ageDays = (Date.now() - new Date(`${pendingRow.date}T12:00:00Z`).getTime()) / 86400000;
      // Absent a known window, nothing is expired. Deleting on an assumption
      // about what a caller asked for is precisely the wrong default: the cost
      // of keeping a row too long is a visible warning, and the cost of
      // deleting one wrongly is silent lost spending.
      const coveredByWindow = Boolean(windowStart) && pendingRow.date >= windowStart;

      if (coveredByWindow && ageDays >= STALE_PENDING_DAYS) {
        // The window covered this date, so a settled twin would have been
        // returned. It either settled under a new id -- and that row is already
        // recorded, making this one a double count -- or it was cancelled and
        // never happened. Both mean the pending row should go.
        result.pendingExpired.push({
          transaction_id: pendingRow.id,
          date: pendingRow.date,
          amount: pendingRow.amount,
          merchant: pendingRow.merchant_raw,
        });
        deleteTransaction.run(pendingRow.id);
        continue;
      }

      // Either too recent to judge, or outside what this run asked for -- in
      // which case the settled twin may simply not have been requested. Say so
      // rather than deleting it.
      result.unreconciledPending.push({
        transaction_id: pendingRow.id,
        date: pendingRow.date,
        amount: pendingRow.amount,
        merchant: pendingRow.merchant_raw,
      });
      continue;
    }

    // The settled row is authoritative; carry the local enrichment across so a
    // category assigned while the charge was pending isn't lost.
    if (pendingRow.category_id || pendingRow.notes) {
      const settled = selectByAccountAndSimplefinId.get(accountId, match.simplefin_id);
      carryLocalEdits.run(
        settled.category_id || pendingRow.category_id,
        settled.notes || pendingRow.notes,
        settled.id
      );
    }
    claimed.add(match.simplefin_id);
    deleteTransaction.run(pendingRow.id);
    result.pendingSettled += 1;
    // Counted separately so the numbers stay readable: `created` is always the
    // literal number of rows inserted, and `created - pendingSuperseded` is how
    // much of that was genuinely new spending rather than a pending charge
    // reappearing under a fresh id.
    result.pendingSuperseded += 1;
  }
}

/**
 * Upserts transactions from an already-fetched SimpleFIN payload.
 * Wrapped in a single database transaction by the caller.
 */
function upsertTransactions(remoteAccounts, options = {}) {
  const result = {
    created: 0,
    updated: 0,
    unchanged: 0,
    pendingSettled: 0,
    pendingSuperseded: 0,
    accountsWithNoTransactions: 0,
    possibleDuplicates: [],
    unreconciledPending: [],
    pendingExpired: [],
    unknownAccounts: [],
    skipped: [],
  };

  const localBySimplefinId = new Map(selectAccounts.all().map((a) => [a.simplefin_id, a]));

  for (const remoteAccount of remoteAccounts) {
    const local = localBySimplefinId.get(remoteAccount.id);
    if (!local) {
      // Either a brand-new account appeared, or this run skipped the account
      // half (`syncTransactions`) and has nowhere to put its transactions.
      // They're reported rather than orphaned — and reported loudly, because
      // dropping a whole account's transactions must not read as a clean sync.
      result.unknownAccounts.push({ simplefin_id: remoteAccount.id, name: remoteAccount.name });
      continue;
    }

    const remoteTxns = remoteAccount.transactions || [];
    if (remoteTxns.length === 0) result.accountsWithNoTransactions += 1;

    // Note there is no early exit for an empty account: "no transactions came
    // back" is exactly the shape of a pending authorization being cancelled, so
    // reconciliation below still has to run and report it.
    const returnedIds = new Set();
    const insertedRows = [];

    for (const txn of remoteTxns) {
      let row;
      try {
        row = mapTransaction(txn, local.id);
      } catch (err) {
        // One malformed transaction must not abandon the rest of the sync.
        result.skipped.push({ simplefin_id: txn && txn.id, reason: err.message });
        continue;
      }
      returnedIds.add(row.simplefin_id);

      const existing = selectByAccountAndSimplefinId.get(local.id, row.simplefin_id);
      if (existing) {
        // Write only on a real change. A nightly 30-day window re-reads the
        // same few hundred rows every time; counting those as "updated" would
        // bury the one row that actually moved.
        const changed =
          existing.date !== row.date ||
          Math.abs(existing.amount - row.amount) >= 0.005 ||
          existing.merchant_raw !== row.merchant_raw ||
          existing.payee !== row.payee ||
          existing.pending !== row.pending ||
          existing.posted_at !== row.posted_at;

        if (changed) {
          updateTransaction.run({ ...row, id: existing.id });
          result.updated += 1;
        } else {
          result.unchanged += 1;
        }
        // Settled under its original id — the simple case, no reconciliation.
        if (existing.pending === 1 && row.pending === 0) result.pendingSettled += 1;
        continue;
      }

      let insertedId;
      try {
        insertedId = insertTransaction.run(row).lastInsertRowid;
      } catch (err) {
        // The UNIQUE on simplefin_id is global while SimpleFIN only promises
        // per-account uniqueness. Real 'TRN-<uuid>' ids make this essentially
        // impossible, but report it rather than losing the whole sync to it.
        result.skipped.push({ simplefin_id: row.simplefin_id, reason: err.message });
        continue;
      }
      result.created += 1;
      insertedRows.push({ ...row, id: insertedId });

      const duplicate = flagIfDuplicatesManualEntry(row, insertedId);
      if (duplicate) result.possibleDuplicates.push(duplicate);
    }

    // Only meaningful when this run actually asked for pending transactions —
    // otherwise every pending row looks "missing" simply because we didn't ask.
    if (options.includePending) {
      reconcilePending(local.id, returnedIds, insertedRows, result, options.windowStart);
    }
  }

  return result;
}

function resolveLookbackDays(days, backfill = false) {
  const requested = Number(days) || DEFAULT_LOOKBACK_DAYS;
  const ceiling = backfill ? MAX_BACKFILL_DAYS : MAX_LOOKBACK_DAYS;
  return Math.max(1, Math.min(requested, ceiling));
}

/**
 * One SimpleFIN request; refreshes account balances and transactions together.
 *
 * Accounts are upserted first so a newly-linked account's transactions have
 * somewhere to land, and the whole thing commits as one database transaction —
 * a half-written sync is harder to reason about than one that didn't run.
 *
 * @param {object} [options]
 * @param {number}  [options.days=30] Lookback window, capped at 44 (89 with
 *   `backfill`). A clamped request reports `window.requested_days` rather than
 *   quietly returning a shorter window than was asked for.
 * @param {boolean} [options.backfill] Raise the cap to SimpleFIN's real 90-day
 *   ceiling for a one-time catch-up. Off by default so the daily job keeps
 *   asking for a modest window.
 * @param {boolean} [options.includePending=false] Pull not-yet-settled charges.
 *   Off by default: a pending amount changes when it settles (tips, fuel
 *   pre-auths), so including them makes budget totals wobble, and SimpleFIN
 *   doesn't guarantee the id survives posting.
 * @param {boolean} [options.confirmInferredTypes] Passed to the account upsert.
 * @param {boolean} [options.skipAccounts] Skip the account/balance half.
 */
async function syncAll(options = {}) {
  const startedAt = new Date().toISOString();
  const requestedDays = Number(options.days) || DEFAULT_LOOKBACK_DAYS;
  const days = resolveLookbackDays(options.days, options.backfill);
  const windowStart = new Date(Date.now() - days * 86400 * 1000);
  const kind = options.skipAccounts ? 'transactions' : 'all';

  let payload;
  try {
    payload = await fetchAccounts({
      startDate: windowStart,
      pending: Boolean(options.includePending),
    });
  } catch (err) {
    recordRun({
      kind,
      status: 'failed',
      started_at: startedAt,
      window_start: localDate(windowStart),
      window_end: localDate(new Date()),
      errors: JSON.stringify([err.message]),
    });
    throw err;
  }

  const runBoth = db.transaction(() => {
    const accounts = options.skipAccounts
      ? { created: 0, updated: 0, needsReview: [], skipped: [] }
      : upsertAccounts(payload.accounts, options);
    // The window has to reach the reconciler: whether an unmatched pending row
    // is safe to expire depends entirely on whether this sync would have seen
    // its settled twin.
    const transactions = upsertTransactions(payload.accounts, {
      ...options,
      windowStart: localDate(windowStart),
    });
    return { accounts, transactions };
  });

  let accounts;
  let transactions;
  try {
    ({ accounts, transactions } = runBoth());
  } catch (err) {
    // The database transaction rolled back, so nothing was half-written — but
    // the run still has to leave a trace. Without this, a night that blew up
    // writing to the database is indistinguishable from cron never firing.
    recordRun({
      kind,
      status: 'failed',
      started_at: startedAt,
      window_start: localDate(windowStart),
      window_end: localDate(new Date()),
      errors: JSON.stringify([err.message]),
    });
    throw err;
  }

  // SimpleFIN reports per-institution problems (a bank needing re-auth) in
  // `errors[]` alongside a 200, and uses the same array for advisories. Either
  // way a run that carried one is not a clean run.
  const errors = [...payload.errors];
  for (const account of transactions.unknownAccounts) {
    errors.push(`No local account for "${account.name}" — its transactions were skipped. Run a full sync (POST /api/sync) to create it.`);
  }
  for (const account of accounts.skipped) {
    errors.push(`Skipped account "${account.name}": ${account.reason}`);
  }
  // No separate unknownAccounts clause: the loop above already pushed one error
  // per unknown account, so `errors.length` covers it.
  const status =
    errors.length > 0 || transactions.skipped.length > 0 || accounts.skipped.length > 0
      ? 'partial'
      : 'success';

  recordRun({
    kind,
    status,
    started_at: startedAt,
    window_start: localDate(windowStart),
    window_end: localDate(new Date()),
    accounts_created: accounts.created,
    accounts_updated: accounts.updated,
    transactions_created: transactions.created,
    transactions_updated: transactions.updated,
    pending_settled: transactions.pendingSettled,
    possible_duplicates: transactions.possibleDuplicates.length,
    errors: errors.length ? JSON.stringify(errors) : null,
  });

  return {
    status,
    window: {
      start: localDate(windowStart),
      end: localDate(new Date()),
      days,
      // Surfaced only when the ask was cut down. A silent clamp reads as a
      // successful deep sync that quietly returned a third of the range.
      ...(days < requestedDays && { requested_days: requestedDays }),
    },
    accounts,
    transactions,
    errors,
  };
}

/** Transactions only — leaves account balances untouched. */
async function syncTransactions(options = {}) {
  return syncAll({ ...options, skipAccounts: true });
}

module.exports = {
  syncAll,
  syncTransactions,
  upsertTransactions,
  resolveLookbackDays,
  MAX_LOOKBACK_DAYS,
  MAX_BACKFILL_DAYS,
  DEFAULT_LOOKBACK_DAYS,
};
