const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const { account_id, category_id, month, pending, possible_duplicates } = req.query;
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
  if (pending !== undefined) {
    clauses.push('pending = ?');
    params.push(pending === '0' || pending === 'false' ? 0 : 1);
  }
  // The review queue for rows the sync flagged as duplicating something entered
  // by hand or imported from a CSV. Nothing acts on the flag automatically, so
  // there has to be a way to list them.
  if (possible_duplicates !== undefined && possible_duplicates !== '0' && possible_duplicates !== 'false') {
    clauses.push('possible_duplicate_of IS NOT NULL');
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Clamped at both ends: SQLite reads a negative LIMIT as "no limit", so
  // ?limit=-1 would otherwise return all 2,500+ rows to a caller asking for a
  // short list. The default is generous but finite.
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 500, 2000));

  // Joined rather than left to the caller: every consumer of this list needs the
  // account and category names, and resolving them client-side means three
  // requests and a join in the browser for what SQLite does here for free.
  const rows = db
    .prepare(
      `SELECT t.*,
              a.name AS account_name,
              a.nickname AS account_nickname,
              c.name AS category_name,
              COALESCE(parent.name, c.name) AS category_group
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       ${where.replace(/\b(account_id|category_id|date|pending|possible_duplicate_of)\b/g, 't.$1')}
       ORDER BY t.date DESC, t.id DESC
       LIMIT ?`
    )
    .all(...params, limit);

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

// Resolving a flagged duplicate means deleting one of the two rows, which is
// what `possible_duplicate_of`'s ON DELETE SET NULL was added for. Without this
// route the documented cleanup needs raw SQL on the NAS.
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'transaction not found' });
  res.status(204).end();
});

router.patch('/:id/category', (req, res) => {
  const { category_id } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id is required' });

  db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(category_id, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

module.exports = router;
