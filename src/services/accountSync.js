const db = require('../db');
const { fetchAccounts } = require('./simplefinClient');
const { mapAccount } = require('./accountMapper');
const { recordRun } = require('./syncRuns');

// Upserts SimpleFIN accounts into the local `accounts` table, matching on
// `simplefin_id` so repeated syncs update rows instead of duplicating them.
//
// A confirmed `type` is never overwritten: SimpleFIN doesn't send an account
// type, so ours is inferred, and a human's correction outranks a fresh guess.

const selectBySimplefinId = db.prepare('SELECT * FROM accounts WHERE simplefin_id = ?');

const insertAccount = db.prepare(`
  INSERT INTO accounts (name, institution, type, current_balance, currency, source, simplefin_id, type_confirmed)
  VALUES (@name, @institution, @type, @current_balance, @currency, 'simplefin', @simplefin_id, @type_confirmed)
`);

// `type` is only refreshed while type_confirmed = 0. Confirmation itself is
// sticky: a sync can set it (when the caller passed confirmInferredTypes, or
// the inference was high-confidence) but never clears it, because the only
// thing that sets it to 0 is our own guesswork. Every right-hand side here
// reads the pre-update row, so the two clauses don't interfere.
const updateAccount = db.prepare(`
  UPDATE accounts
  SET name = @name,
      institution = @institution,
      current_balance = @current_balance,
      currency = @currency,
      type = CASE WHEN type_confirmed = 1 THEN type ELSE @type END,
      type_confirmed = CASE WHEN @type_confirmed = 1 THEN 1 ELSE type_confirmed END
  WHERE simplefin_id = @simplefin_id
`);

const insertSnapshot = db.prepare(
  'INSERT INTO account_balance_snapshots (account_id, balance) VALUES (?, ?)'
);

/**
 * Upserts already-fetched SimpleFIN accounts. Split out from `syncAccounts` so
 * a combined run can reuse a single API response for both accounts and
 * transactions — the SimpleFIN budget is 24 requests a day, and spending two of
 * them on data one request already returned is wasteful.
 *
 * Runs in its own database transaction unless the caller is already inside one.
 *
 * @param {object[]} remote Raw SimpleFIN account objects
 * @param {object} [options]
 * @param {boolean} [options.confirmInferredTypes] Treat inferred types as
 *   human-confirmed. Only pass this when a human has actually reviewed them.
 * @returns {{created: number, updated: number, needsReview: object[]}}
 */
function upsertAccounts(remote, options = {}) {
  const result = { created: 0, updated: 0, needsReview: [], skipped: [] };

  const runAll = db.transaction((rows) => {
    for (const raw of rows) {
      // Mapped per account rather than up front: `mapAccount` throws on an
      // unparseable balance, and an eager map would let one malformed account
      // abort the entire night — rolling back the other twelve accounts'
      // balances and every transaction along with them. Same per-row tolerance
      // the transaction path already has.
      let row;
      try {
        row = mapAccount(raw);
      } catch (err) {
        result.skipped.push({ simplefin_id: raw && raw.id, name: raw && raw.name, reason: err.message });
        continue;
      }

      const existing = selectBySimplefinId.get(row.simplefin_id);

      const payload = {
        name: row.name,
        institution: row.institution,
        type: row.type,
        current_balance: row.current_balance,
        currency: row.currency,
        simplefin_id: row.simplefin_id,
        type_confirmed:
          options.confirmInferredTypes || row.type_confidence === 'high' ? 1 : 0,
      };

      // Confirmed either already, or by this run. Checking `existing` alone
      // would report an account as still needing review on the very response
      // that confirmed it.
      const confirmed = Boolean(existing && existing.type_confirmed) || payload.type_confirmed === 1;

      let accountId;
      if (existing) {
        updateAccount.run(payload);
        accountId = existing.id;
        result.updated += 1;
      } else {
        accountId = insertAccount.run(payload).lastInsertRowid;
        result.created += 1;
      }
      if (!confirmed) {
        result.needsReview.push({ name: row.name, type: row.type, reason: row.type_reason });
      }

      // One snapshot per sync per account, even when the balance is unchanged —
      // net-worth-over-time charts want an evenly spaced series, and a gap would
      // otherwise be ambiguous between "no change" and "sync didn't run".
      insertSnapshot.run(accountId, row.current_balance);
    }
  });

  runAll(remote);
  return result;
}

/**
 * Pulls current balances for every linked account and writes them to the DB.
 *
 * @param {object} [options] Passed through to `upsertAccounts`.
 * @returns {{created: number, updated: number, needsReview: object[], errors: string[]}}
 */
async function syncAccounts(options = {}) {
  const startedAt = new Date().toISOString();

  let remote;
  let errors;
  try {
    ({ accounts: remote, errors } = await fetchAccounts({ balancesOnly: true }));
  } catch (err) {
    // Balance-only runs land in the same audit table as everything else —
    // `sync_runs.kind` reserves 'accounts' precisely so a failed one is visible
    // through GET /api/sync/runs rather than only in an HTTP response nobody
    // kept.
    recordRun({ kind: 'accounts', status: 'failed', started_at: startedAt, errors: JSON.stringify([err.message]) });
    throw err;
  }

  const result = upsertAccounts(remote, options);
  const allErrors = [
    ...errors,
    ...result.skipped.map((s) => `Skipped account "${s.name}": ${s.reason}`),
  ];

  recordRun({
    kind: 'accounts',
    status: allErrors.length > 0 ? 'partial' : 'success',
    started_at: startedAt,
    accounts_created: result.created,
    accounts_updated: result.updated,
    errors: allErrors.length ? JSON.stringify(allErrors) : null,
  });

  return { ...result, errors: allErrors };
}

module.exports = { syncAccounts, upsertAccounts };
