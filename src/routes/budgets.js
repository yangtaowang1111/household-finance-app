const express = require('express');
const db = require('../db');
const { budgetVsActual } = require('../services/budgetCalc');
const { baseline, writePlan } = require('../services/budgetBaseline');
const { budgetProgress } = require('../services/budgetProgress');

const router = express.Router();

// Budget against actual. ?month=N compares one month; omitting it compares the
// year so far against the budget for the months that have actually happened.
router.get('/progress', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = req.query.month ? Number(req.query.month) : undefined;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'year must be a four-digit year' });
  }
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return res.status(400).json({ error: 'month must be 1-12' });
  }
  res.json(budgetProgress({ year, month }));
});

// What each category actually cost, last year and this, with a suggested annual
// figure. This is the data behind setting a budget for the first time — nobody
// knows what they spend on 59 categories, but they can react to a number.
router.get('/baseline', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const reference = req.query.reference ? Number(req.query.reference) : undefined;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'year must be a four-digit year' });
  }
  res.json(baseline({ year, reference }));
});

// Writes a whole year at once, spreading each annual figure over the months
// using that category's own shape.
router.post('/plan', (req, res) => {
  const { year, plans } = req.body || {};
  if (!Number.isInteger(year)) return res.status(400).json({ error: 'year (integer) is required' });
  if (!Array.isArray(plans) || !plans.length) return res.status(400).json({ error: 'plans (array) is required' });
  if (plans.length > 500) return res.status(400).json({ error: 'at most 500 categories at a time' });

  for (const plan of plans) {
    if (!plan || !Number.isInteger(plan.category_id)) {
      return res.status(400).json({ error: 'each plan needs an integer category_id' });
    }
    if (plan.annual_amount != null && !Number.isFinite(Number(plan.annual_amount))) {
      return res.status(400).json({ error: `annual_amount for category ${plan.category_id} is not a number` });
    }
  }

  res.json(writePlan(year, plans.map((p) => ({ ...p, annual_amount: Number(p.annual_amount) || 0 }))));
});

router.get('/', (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month query param (YYYY-MM) is required' });
  res.json(db.prepare('SELECT * FROM budgets WHERE month = ?').all(month));
});

router.post('/', (req, res) => {
  const { category_id, month, budgeted_amount } = req.body;
  if (!category_id || !month || budgeted_amount === undefined) {
    return res.status(400).json({ error: 'category_id, month, and budgeted_amount are required' });
  }

  db.prepare(`
    INSERT INTO budgets (category_id, month, budgeted_amount)
    VALUES (?, ?, ?)
    ON CONFLICT(category_id, month) DO UPDATE SET budgeted_amount = excluded.budgeted_amount
  `).run(category_id, month, budgeted_amount);

  res.status(201).json(db.prepare('SELECT * FROM budgets WHERE category_id = ? AND month = ?').get(category_id, month));
});

router.get('/vs-actual', (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month query param (YYYY-MM) is required' });
  res.json(budgetVsActual(month));
});

module.exports = router;
