const express = require('express');
const { currentNetWorth, netWorthHistory } = require('../services/networth');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/networth            — balances as they stand, plus property equity
// GET /api/networth/history?from=2026-01-01[&to=2026-08-17]
router.get('/', (req, res) => {
  res.json(currentNetWorth());
});

router.get('/history', (req, res) => {
  const { from, to } = req.query;
  if (!from || !ISO_DATE.test(from)) {
    return res.status(400).json({ error: 'from is required, as YYYY-MM-DD' });
  }
  if (to && !ISO_DATE.test(to)) {
    return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
  }
  if (to && to < from) {
    return res.status(400).json({ error: 'to must be on or after from' });
  }
  res.json(netWorthHistory({ from, to }));
});

module.exports = router;
