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

router.patch('/:id/category', (req, res) => {
  const { category_id } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id is required' });

  db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(category_id, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

module.exports = router;
