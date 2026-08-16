// Dedup is the part of this app that's genuinely hard to unwind if it goes
// wrong: a duplicated month of spending, a category silently reset, or a
// hand-entered transaction deleted by a background job are all worse than a
// sync that refuses to run. These tests pin the behaviour of every branch that
// decides to insert, update, delete, or flag.
//
//   npm test
//
// Runs against a throwaway database and never touches the network — the
// SimpleFIN payloads here are shaped from a real 2026-08-14 probe response.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-test-')), 'test.db');
process.env.DB_PATH = DB_FILE;
// Pin the timezone so date mapping is deterministic wherever this runs.
process.env.TIMEZONE = 'America/Denver';

const db = require('../src/db');
const { seedCategories } = require('../src/db/seed');
const {
  upsertTransactions,
  resolveLookbackDays,
  MAX_LOOKBACK_DAYS,
  MAX_BACKFILL_DAYS,
  DEFAULT_LOOKBACK_DAYS,
} = require('../src/services/transactionSync');
const { mapTransaction } = require('../src/services/transactionMapper');

seedCategories();

const ACCOUNT_SFID = 'ACT-90ed13c3-d7a3-4d9c-b72c-dd5f32b9e61c';
const unix = (isoString) => Math.floor(new Date(isoString).getTime() / 1000);

/** A SimpleFIN transaction, with the field shapes real ones have. */
function txn(overrides = {}) {
  return {
    id: `TRN-${Math.random().toString(16).slice(2)}`,
    posted: unix('2026-08-10T14:00:00Z'),
    transacted_at: unix('2026-08-09T18:30:00Z'),
    amount: '-42.50', // a string, as SimpleFIN sends it
    description: 'TST*THE LITTLE DINER',
    payee: 'The Little Diner',
    memo: '',
    mcc: null,
    ...overrides,
  };
}

function payload(transactions) {
  return [{ id: ACCOUNT_SFID, name: 'Chase Freedom Unlimited (5053)', transactions }];
}

let accountId;

test.beforeEach(() => {
  // Snapshots reference accounts, so they have to go first or the account
  // delete trips the foreign key.
  db.exec('DELETE FROM transactions; DELETE FROM account_balance_snapshots; DELETE FROM sync_runs; DELETE FROM accounts;');
  accountId = db
    .prepare(
      `INSERT INTO accounts (name, institution, type, current_balance, source, simplefin_id, type_confirmed)
       VALUES ('Chase Freedom Unlimited (5053)', 'Chase', 'credit', -1200, 'simplefin', ?, 1)`
    )
    .run(ACCOUNT_SFID).lastInsertRowid;
});

test.after(() => {
  // Windows won't unlink a file SQLite still has open.
  db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

const allTxns = () => db.prepare('SELECT * FROM transactions ORDER BY id').all();

test('maps SimpleFIN field shapes onto the schema', () => {
  const row = mapTransaction(txn(), 7);
  assert.equal(row.amount, -42.5, 'string amount is parsed to a number');
  assert.equal(row.account_id, 7);
  assert.equal(row.merchant_raw, 'TST*THE LITTLE DINER', 'raw bank descriptor is preserved');
  assert.equal(row.payee, 'The Little Diner');
  assert.equal(row.pending, 0, 'absent `pending` means posted');
  // 2026-08-09T18:30Z is 12:30 on the 9th in Denver — same day either way.
  assert.equal(row.date, '2026-08-09', 'date comes from transacted_at, not posted');
});

test('dates a late-evening purchase to the local day, not the UTC one', () => {
  // 20:00 on 2026-07-31 in Denver is 02:00 on 2026-08-01 UTC. Reading it in UTC
  // would move the purchase into the next budget month.
  const row = mapTransaction(txn({ transacted_at: unix('2026-08-01T02:00:00Z') }), 7);
  assert.equal(row.date, '2026-07-31');
});

test('a repeated sync of the same window creates nothing new', () => {
  const transactions = [txn(), txn({ amount: '-8.62', description: 'McDonalds 21389', payee: "McDonald's" })];

  const first = upsertTransactions(payload(transactions));
  assert.equal(first.created, 2);

  const second = upsertTransactions(payload(transactions));
  assert.equal(second.created, 0, 'no duplicates on re-sync');
  assert.equal(second.updated, 0, 'nothing changed, so nothing is reported as updated');
  assert.equal(second.unchanged, 2);
  assert.equal(allTxns().length, 2);
});

test('identical charges on different days are both kept', () => {
  // Real data had 19 (account, amount, description) triples recurring across
  // 45 days — the same $8.62 McDonald's weeks apart. Deduping on content
  // without the date would delete real spending.
  const result = upsertTransactions(
    payload([
      txn({ amount: '-8.62', description: 'McDonalds 21389', transacted_at: unix('2026-07-02T17:00:00Z') }),
      txn({ amount: '-8.62', description: 'McDonalds 21389', transacted_at: unix('2026-07-29T17:00:00Z') }),
    ])
  );
  assert.equal(result.created, 2);
});

test('re-sync preserves a category and notes set locally', () => {
  const transactions = [txn()];
  upsertTransactions(payload(transactions));

  const categoryId = db.prepare("SELECT id FROM categories WHERE name = 'Dining Out'").get().id;
  db.prepare('UPDATE transactions SET category_id = ?, notes = ? WHERE id = ?').run(
    categoryId,
    'split with Sarah',
    allTxns()[0].id
  );

  // The bank revises the descriptor — the row updates, but local work survives.
  upsertTransactions(payload([{ ...transactions[0], description: 'THE LITTLE DINER VAIL' }]));

  const [row] = allTxns();
  assert.equal(row.merchant_raw, 'THE LITTLE DINER VAIL', 'bank-owned field is refreshed');
  assert.equal(row.category_id, categoryId, 'category survives the sync');
  assert.equal(row.notes, 'split with Sarah', 'notes survive the sync');
});

test('a pending charge that settles under the same id updates in place', () => {
  const pending = txn({ posted: 0, pending: true, amount: '-50.00' });
  const first = upsertTransactions(payload([pending]), { includePending: true });
  assert.equal(first.created, 1);
  assert.equal(allTxns()[0].pending, 1);

  // Same id, now settled, with a tip added.
  const settled = { ...pending, pending: false, posted: unix('2026-08-11T14:00:00Z'), amount: '-58.75' };
  const second = upsertTransactions(payload([settled]), { includePending: true });

  assert.equal(second.created, 0, 'no second row');
  assert.equal(second.updated, 1);
  assert.equal(second.pendingSettled, 1);
  assert.equal(second.pendingSuperseded, 0, 'the id was stable, so nothing had to be superseded');

  const rows = allTxns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pending, 0);
  assert.equal(rows[0].amount, -58.75, 'settled amount replaces the authorization amount');
  assert.ok(rows[0].posted_at, 'posted_at is filled in on settlement');
});

test('a pending charge that settles under a NEW id is superseded, not duplicated', () => {
  // SimpleFIN does not guarantee the id survives posting, and one snapshot
  // can't prove it either way — so this path has to work too.
  const pending = txn({ id: 'TRN-pending-1', posted: 0, pending: true, amount: '-50.00' });
  upsertTransactions(payload([pending]), { includePending: true });

  const categoryId = db.prepare("SELECT id FROM categories WHERE name = 'Dining Out'").get().id;
  db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(categoryId, allTxns()[0].id);

  const settled = txn({
    id: 'TRN-settled-1',
    posted: unix('2026-08-11T14:00:00Z'),
    transacted_at: unix('2026-08-09T18:30:00Z'),
    amount: '-58.75', // tip added on settlement
  });
  const result = upsertTransactions(payload([settled]), { includePending: true });

  const rows = allTxns();
  assert.equal(rows.length, 1, 'the pending row is replaced, not left alongside its settled twin');
  assert.equal(rows[0].simplefin_id, 'TRN-settled-1');
  assert.equal(rows[0].pending, 0);
  assert.equal(rows[0].category_id, categoryId, 'the category assigned while pending is carried over');
  assert.equal(result.pendingSettled, 1);
  assert.equal(result.pendingSuperseded, 1);
  assert.equal(result.created, 1, 'created stays the literal insert count');
});

test('an ambiguous pending match is left alone and reported', () => {
  const pending = txn({ id: 'TRN-pending-2', posted: 0, pending: true, amount: '-20.00' });
  upsertTransactions(payload([pending]), { includePending: true });

  // Two same-merchant charges within the settle window and neither matches the
  // pending amount exactly — guessing here would attach a category to the wrong
  // transaction and silently drop the pending row.
  const result = upsertTransactions(
    payload([
      txn({ id: 'TRN-a', amount: '-22.00', transacted_at: unix('2026-08-09T18:30:00Z') }),
      txn({ id: 'TRN-b', amount: '-24.00', transacted_at: unix('2026-08-10T18:30:00Z') }),
    ]),
    { includePending: true }
  );

  assert.equal(result.pendingSuperseded, 0);
  assert.equal(result.unreconciledPending.length, 1);
  assert.equal(allTxns().length, 3, 'nothing was deleted');
});

test('an exact amount match breaks a tie between several candidates', () => {
  const pending = txn({ id: 'TRN-pending-3', posted: 0, pending: true, amount: '-22.00' });
  upsertTransactions(payload([pending]), { includePending: true });

  const result = upsertTransactions(
    payload([
      txn({ id: 'TRN-c', amount: '-22.00', transacted_at: unix('2026-08-09T18:30:00Z') }),
      txn({ id: 'TRN-d', amount: '-24.00', transacted_at: unix('2026-08-10T18:30:00Z') }),
    ]),
    { includePending: true }
  );

  assert.equal(result.pendingSuperseded, 1);
  assert.equal(allTxns().length, 2);
  assert.ok(!allTxns().some((r) => r.simplefin_id === 'TRN-pending-3'));
});

test('pending rows are not touched by a sync that did not ask for pending', () => {
  // Without this guard every pending row looks "missing" on a posted-only sync
  // simply because we never asked for it.
  upsertTransactions(payload([txn({ id: 'TRN-pending-4', posted: 0, pending: true })]), {
    includePending: true,
  });

  const result = upsertTransactions(payload([txn({ id: 'TRN-other' })]), { includePending: false });

  assert.equal(result.unreconciledPending.length, 0);
  assert.equal(result.pendingSuperseded, 0);
  assert.equal(allTxns().length, 2, 'the pending row is still there');
});

test('a synced transaction matching a manual entry is flagged, never deleted', () => {
  const manualId = db
    .prepare(
      `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
       VALUES (?, '2026-08-08', -42.5, 'Little Diner (cash?)', 'manual')`
    )
    .run(accountId).lastInsertRowid;

  const result = upsertTransactions(payload([txn()])); // -42.50 on 2026-08-09

  assert.equal(result.possibleDuplicates.length, 1);
  assert.equal(result.possibleDuplicates[0].duplicates_transaction_id, manualId);
  assert.equal(result.possibleDuplicates[0].existing_source, 'manual');

  const rows = allTxns();
  assert.equal(rows.length, 2, 'both rows survive — a human decides which to drop');
  const synced = rows.find((r) => r.source === 'simplefin');
  assert.equal(synced.possible_duplicate_of, manualId);
});

test('CSV-imported rows get the same duplicate check as manual ones', () => {
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
     VALUES (?, '2026-08-10', -42.5, 'TST*THE LITTLE DINER', 'csv_import')`
  ).run(accountId);

  const result = upsertTransactions(payload([txn()]));
  assert.equal(result.possibleDuplicates.length, 1);
  assert.equal(result.possibleDuplicates[0].existing_source, 'csv_import');
});

test('a manual entry outside the date window is not flagged', () => {
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
     VALUES (?, '2026-07-20', -42.5, 'unrelated', 'manual')`
  ).run(accountId);

  const result = upsertTransactions(payload([txn()]));
  assert.equal(result.possibleDuplicates.length, 0);
});

test('one malformed transaction does not abandon the rest of the sync', () => {
  const result = upsertTransactions(
    payload([
      txn({ id: 'TRN-good-1' }),
      txn({ id: 'TRN-bad', amount: 'not-a-number' }),
      txn({ id: 'TRN-good-2', amount: '-3.00' }),
    ])
  );

  assert.equal(result.created, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].simplefin_id, 'TRN-bad');
});

test('transactions for an account that has not been synced yet are reported, not orphaned', () => {
  const result = upsertTransactions([
    { id: 'ACT-brand-new', name: 'New Card (9999)', transactions: [txn()] },
  ]);

  assert.equal(result.created, 0);
  assert.equal(result.unknownAccounts.length, 1);
  assert.equal(result.unknownAccounts[0].name, 'New Card (9999)');
  assert.equal(allTxns().length, 0);
});

test('a pending row is still reconciled when its account returns nothing', () => {
  // An account whose only activity was a cancelled authorization comes back
  // with an empty transaction list. Skipping reconciliation for empty accounts
  // would strand that row as pending forever, and silently.
  upsertTransactions(payload([txn({ id: 'TRN-pending-5', posted: 0, pending: true })]), {
    includePending: true,
  });

  const result = upsertTransactions(payload([]), { includePending: true });

  assert.equal(result.unreconciledPending.length, 1, 'the stranded pending row is reported');
  assert.equal(result.unreconciledPending[0].transaction_id, allTxns()[0].id);
  assert.equal(allTxns().length, 1, 'and is not deleted on a guess');
});

test('two same-amount charges do not both flag the same manual row', () => {
  const manualId = db
    .prepare(
      `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
       VALUES (?, '2026-08-09', -42.5, 'dinner', 'manual')`
    )
    .run(accountId).lastInsertRowid;

  const result = upsertTransactions(
    payload([
      txn({ id: 'TRN-dup-a', transacted_at: unix('2026-08-09T18:30:00Z') }),
      txn({ id: 'TRN-dup-b', transacted_at: unix('2026-08-10T18:30:00Z') }),
    ])
  );

  assert.equal(result.possibleDuplicates.length, 1, 'only the closest match is flagged');
  const flagged = allTxns().filter((r) => r.possible_duplicate_of === manualId);
  assert.equal(flagged.length, 1);
});

test('resolving a flagged duplicate by deleting the manual row is allowed', () => {
  // This is the documented cleanup, so the foreign key has to be ON DELETE SET
  // NULL — with the default NO ACTION the delete fails outright.
  const manualId = db
    .prepare(
      `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
       VALUES (?, '2026-08-08', -42.5, 'Little Diner (cash?)', 'manual')`
    )
    .run(accountId).lastInsertRowid;
  upsertTransactions(payload([txn()]));

  db.prepare('DELETE FROM transactions WHERE id = ?').run(manualId);

  const remaining = allTxns();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source, 'simplefin');
  assert.equal(remaining[0].possible_duplicate_of, null, 'the dangling flag is cleared, not left pointing at nothing');
});

test('one settled row cannot absorb two different pending charges', () => {
  // Pending A gets cancelled by the bank; pending B settles. Both are the same
  // merchant inside the settle window, so a naive matcher hands the single
  // settled row to each in turn — quietly deleting the cancelled authorization
  // instead of reporting it.
  upsertTransactions(
    payload([
      txn({ id: 'TRN-pA', posted: 0, pending: true, amount: '-5.00', transacted_at: unix('2026-08-01T17:00:00Z') }),
      txn({ id: 'TRN-pB', posted: 0, pending: true, amount: '-5.00', transacted_at: unix('2026-08-02T17:00:00Z') }),
    ]),
    { includePending: true }
  );

  const result = upsertTransactions(
    payload([
      txn({
        id: 'TRN-sB',
        amount: '-5.00',
        transacted_at: unix('2026-08-02T17:00:00Z'),
        posted: unix('2026-08-03T14:00:00Z'),
      }),
    ]),
    { includePending: true }
  );

  assert.equal(result.pendingSuperseded, 1, 'exactly one pending row is superseded');
  assert.equal(result.unreconciledPending.length, 1, 'the cancelled authorization is surfaced, not silently dropped');
  assert.equal(allTxns().filter((r) => r.pending === 1).length, 1, 'the cancelled row is still there for review');
});

test('a pending row reconciles against a twin imported by an earlier run', () => {
  // The settled twin arrives on a posted-only sync (which skips reconciliation),
  // so by the time pending mode runs again the twin is an existing row rather
  // than a fresh insert. Searching only this run's inserts strands it forever.
  upsertTransactions(payload([txn({ id: 'TRN-pC', posted: 0, pending: true, amount: '-30.00' })]), {
    includePending: true,
  });

  // Posted-only run: the twin lands, pending is left alone.
  upsertTransactions(payload([txn({ id: 'TRN-sC', amount: '-30.00' })]), { includePending: false });
  assert.equal(allTxns().length, 2);

  // Pending run: the stale pending row should now find the existing twin.
  const result = upsertTransactions(payload([]), { includePending: true });

  assert.equal(result.pendingSuperseded, 1);
  assert.equal(result.unreconciledPending.length, 0);
  const rows = allTxns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].simplefin_id, 'TRN-sC');
});

test('a malformed account does not abort the whole sync', () => {
  // Mirrors the transaction-level guarantee: one bad account must not roll back
  // every other account's balance and every transaction with it.
  const { upsertAccounts } = require('../src/services/accountSync');

  const result = upsertAccounts([
    { id: 'ACT-ok', name: 'Good Checking', balance: '100.00', currency: 'USD' },
    { id: 'ACT-bad', name: 'Broken Account', balance: 'unavailable' },
  ]);

  assert.equal(result.created, 1, 'the healthy account is still written');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, 'Broken Account');
});

test('confirm_inferred_types takes effect on an account that already exists', () => {
  const { upsertAccounts } = require('../src/services/accountSync');
  // "Chase Freedom" carries no type keyword, so it infers at medium confidence
  // and lands unconfirmed — the case the option exists for.
  const remote = [{ id: 'ACT-freedom', name: 'Chase Freedom', balance: '-250.00', currency: 'USD' }];

  const first = upsertAccounts(remote);
  assert.equal(first.needsReview.length, 1, 'medium-confidence inference asks for review');
  const before = db.prepare('SELECT type_confirmed FROM accounts WHERE simplefin_id = ?').get('ACT-freedom');
  assert.equal(before.type_confirmed, 0);

  // Human reviewed it; re-sync confirming the inferred types.
  const second = upsertAccounts(remote, { confirmInferredTypes: true });

  const after = db.prepare('SELECT type_confirmed FROM accounts WHERE simplefin_id = ?').get('ACT-freedom');
  assert.equal(after.type_confirmed, 1, 'the confirmation is actually persisted on update');
  assert.equal(second.needsReview.length, 0, 'and it is not still reported as needing review');
});

test('an amount correction from the bank is applied', () => {
  const original = txn({ id: 'TRN-fix-me', amount: '-42.50' });
  upsertTransactions(payload([original]));

  const result = upsertTransactions(payload([{ ...original, amount: '-45.00' }]));
  assert.equal(result.updated, 1);
  assert.equal(allTxns()[0].amount, -45);
});

// --- lookback window ---------------------------------------------------------
//
// The window always *ends* at now, so days 45-89 are unreachable by running the
// routine sync more often. The one-time catch-up needs the higher ceiling, and
// the daily job needs to keep the lower one.

test('a routine sync is capped at the 45-day advisory', () => {
  assert.equal(resolveLookbackDays(89), MAX_LOOKBACK_DAYS);
  assert.equal(resolveLookbackDays(45), MAX_LOOKBACK_DAYS);
});

test('a backfill reaches SimpleFIN\'s real 90-day ceiling', () => {
  assert.equal(resolveLookbackDays(89, true), 89);
  assert.equal(resolveLookbackDays(365, true), MAX_BACKFILL_DAYS, 'and no further');
});

test('a window smaller than the cap is left alone either way', () => {
  assert.equal(resolveLookbackDays(7), 7);
  assert.equal(resolveLookbackDays(7, true), 7);
});

test('a missing or junk day count falls back to the default', () => {
  assert.equal(resolveLookbackDays(undefined), DEFAULT_LOOKBACK_DAYS);
  assert.equal(resolveLookbackDays('not a number'), DEFAULT_LOOKBACK_DAYS);
  assert.equal(resolveLookbackDays(0), DEFAULT_LOOKBACK_DAYS);
});

test('a nonsensical day count still yields a usable window', () => {
  assert.equal(resolveLookbackDays(-5), 1, 'never a backwards window');
});
