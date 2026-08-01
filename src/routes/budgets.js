const express = require('express');
const db = require('../db');
const { budgetVsActual } = require('../services/budgetCalc');

const router = express.Router();

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
