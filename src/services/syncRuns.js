// Writes to the `sync_runs` audit table.
//
// Lives in its own module because both the account sync and the transaction
// sync record runs, and transactionSync already requires accountSync — putting
// this in either one would create a require cycle.

const db = require('../db');

const insertSyncRun = db.prepare(`
  INSERT INTO sync_runs (
    kind, status, started_at, finished_at, window_start, window_end,
    accounts_created, accounts_updated, transactions_created, transactions_updated,
    pending_settled, possible_duplicates, errors
  ) VALUES (
    @kind, @status, @started_at, @finished_at, @window_start, @window_end,
    @accounts_created, @accounts_updated, @transactions_created, @transactions_updated,
    @pending_settled, @possible_duplicates, @errors
  )
`);

/**
 * Records one sync attempt. `finished_at` is written explicitly rather than
 * left to the column default: the default is SQLite's `datetime('now')`
 * ("YYYY-MM-DD HH:MM:SS"), while `started_at` comes from JS as an ISO 8601
 * string. Two formats in one table compare wrong — 'T' sorts after ' ', so
 * every run would look like it finished before it started.
 */
function recordRun(fields) {
  insertSyncRun.run({
    finished_at: new Date().toISOString(),
    accounts_created: 0,
    accounts_updated: 0,
    transactions_created: 0,
    transactions_updated: 0,
    pending_settled: 0,
    possible_duplicates: 0,
    window_start: null,
    window_end: null,
    errors: null,
    ...fields,
  });
}

module.exports = { recordRun };
