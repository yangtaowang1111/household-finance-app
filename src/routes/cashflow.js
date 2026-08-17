const express = require('express');
const { cashflow } = require('../services/cashflow');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** First day of the month after the one given: '2026-02' -> '2026-03-01'. */
function monthEnd(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
}

// GET /api/cashflow?month=2026-02
// GET /api/cashflow?from=2026-01-01&to=2026-06-01
//
// `month` is the common case and expands to that month's bounds; from/to is
// there for a quarter, a year, or the span between two sources.
router.get('/', (req, res) => {
  const { month, from, to } = req.query;

  if (month) {
    if (!MONTH.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    return res.json(cashflow({ from: `${month}-01`, to: monthEnd(month) }));
  }

  if (!from || !to) {
    return res.status(400).json({ error: 'provide either month=YYYY-MM, or both from and to as YYYY-MM-DD' });
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  }
  if (from >= to) {
    return res.status(400).json({ error: 'from must be before to' });
  }

  res.json(cashflow({ from, to }));
});

module.exports = router;
