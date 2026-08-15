const express = require('express');
const db = require('../db');
const { syncAccounts } = require('../services/accountSync');
const { syncAll, syncTransactions, MAX_LOOKBACK_DAYS } = require('../services/transactionSync');

const router = express.Router();

function parseSyncOptions(body = {}) {
  return {
    days: body.days,
    includePending: Boolean(body.include_pending),
    confirmInferredTypes: Boolean(body.confirm_inferred_types),
  };
}

// Balances only — one SimpleFIN request, no transaction bodies.
// `confirm_inferred_types` should only be sent when a human has actually
// reviewed the inferred account types; it suppresses the review flag.
router.post('/accounts', async (req, res) => {
  try {
    const result = await syncAccounts(parseSyncOptions(req.body));
    // A SimpleFIN partial failure (one bank needing re-auth) still returns 200
    // with the accounts it could fetch, so surface `errors` rather than letting
    // a partial sync look clean.
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Transactions only. Still one request, but account balances are left alone.
router.post('/transactions', async (req, res) => {
  try {
    res.json(await syncTransactions(parseSyncOptions(req.body)));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Balances + transactions from a single SimpleFIN request. This is what the
// daily job runs — the API budget is 24 requests a day, so doing both halves
// off one response is the default rather than an optimization.
router.post('/', async (req, res) => {
  try {
    res.json(await syncAll(parseSyncOptions(req.body)));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Sync history. The point of an unattended job is that nobody watches it, so
// there has to be somewhere to see that it is still working.
router.get('/runs', (req, res) => {
  // Clamped at both ends: SQLite reads a negative LIMIT as "no limit", so
  // ?limit=-1 would otherwise dump the entire table.
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100));
  const rows = db
    .prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row, errors: row.errors ? JSON.parse(row.errors) : [] }));
  res.json({ max_lookback_days: MAX_LOOKBACK_DAYS, runs: rows });
});

module.exports = router;
