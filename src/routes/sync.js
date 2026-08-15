const express = require('express');
const { syncAccounts } = require('../services/accountSync');

const router = express.Router();

// Pulls current balances for every SimpleFIN-linked account.
// `confirm_inferred_types` should only be sent when a human has actually
// reviewed the inferred account types — it suppresses the review flag.
router.post('/accounts', async (req, res) => {
  try {
    const result = await syncAccounts({
      confirmInferredTypes: Boolean(req.body && req.body.confirm_inferred_types),
    });
    // A SimpleFIN partial failure (one bank needing re-auth) still returns 200
    // with the accounts it could fetch, so surface `errors` rather than letting
    // a partial sync look clean.
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
