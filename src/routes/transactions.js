const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const { account_id, category_id, month } = req.query;
  const clauses = [];
  const params = [];

  if (account_id) {
    clauses.push('account_id = ?');
    params.push(account_id);
  }
  if (category_id) {
    clauses.push('category_id = ?');
    params.push(category_id);
  }
  if (month) {
    clauses.push("strftime('%Y-%m', date) = ?");
    params.push(month);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM transactions ${where} ORDER BY date DESC`).all(...params);
  res.json(rows);
});

// Manual transaction entry — cash spending, or anything else SimpleFIN
// can't reach. `source` is always 'manual' here; SimpleFIN-sourced and
// CSV-imported transactions come in through their own pipelines.
router.post('/', (req, res) => {
  const { account_id, date, amount, merchant_raw, category_id, notes } = req.body;
  if (!account_id || !date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'account_id, date, and amount are required' });
  }
  if (isNaN(Number(amount))) {
    return res.status(400).json({ error: 'amount must be a number' });
  }

  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!account) return res.status(400).json({ error: 'account_id does not reference an existing account' });

  const result = db.prepare(`
    INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, 'manual')
  `).run(account_id, date, Number(amount), merchant_raw || null, category_id || null, notes || null);

  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid));
});

router.patch('/:id/category', (req, res) => {
  const { category_id } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id is required' });

  db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(category_id, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

module.exports = router;
