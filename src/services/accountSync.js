const db = require('../db');
const { fetchAccounts } = require('./simplefinClient');
const { mapAccount } = require('./accountMapper');

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

// `type` is only refreshed while type_confirmed = 0.
const updateAccount = db.prepare(`
  UPDATE accounts
  SET name = @name,
      institution = @institution,
      current_balance = @current_balance,
      currency = @currency,
      type = CASE WHEN type_confirmed = 1 THEN type ELSE @type END
  WHERE simplefin_id = @simplefin_id
`);

const insertSnapshot = db.prepare(
  'INSERT INTO account_balance_snapshots (account_id, balance) VALUES (?, ?)'
);

/**
 * Pulls current balances for every linked account and writes them to the DB.
 *
 * @param {object} [options]
 * @param {boolean} [options.confirmInferredTypes] Mark newly-created accounts as
 *   type-confirmed. Only pass this when a human has actually reviewed the
 *   inferred types (e.g. the first run, after a dry run was inspected).
 * @returns {{created: number, updated: number, needsReview: object[], errors: string[]}}
 */
async function syncAccounts(options = {}) {
  const { accounts: remote, errors } = await fetchAccounts({ balancesOnly: true });
  const mapped = remote.map(mapAccount);

  const result = { created: 0, updated: 0, needsReview: [], errors };

  const runAll = db.transaction((rows) => {
    for (const row of rows) {
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

      let accountId;
      if (existing) {
        updateAccount.run(payload);
        accountId = existing.id;
        result.updated += 1;
        if (!existing.type_confirmed && row.type_confidence !== 'high') {
          result.needsReview.push({ name: row.name, type: row.type, reason: row.type_reason });
        }
      } else {
        accountId = insertAccount.run(payload).lastInsertRowid;
        result.created += 1;
        if (!payload.type_confirmed) {
          result.needsReview.push({ name: row.name, type: row.type, reason: row.type_reason });
        }
      }

      // One snapshot per sync per account, even when the balance is unchanged —
      // net-worth-over-time charts want an evenly spaced series, and a gap would
      // otherwise be ambiguous between "no change" and "sync didn't run".
      insertSnapshot.run(accountId, row.current_balance);
    }
  });

  runAll(mapped);
  return result;
}

module.exports = { syncAccounts };
