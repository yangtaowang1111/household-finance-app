const express = require('express');
const db = require('../db');

const router = express.Router();

const insertSnapshot = db.prepare(
  'INSERT INTO account_balance_snapshots (account_id, balance) VALUES (?, ?)'
);

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY id').all());
});

router.post('/', (req, res) => {
  const { name, institution, type, current_balance = 0, source = 'manual' } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

  const result = db.prepare(`
    INSERT INTO accounts (name, institution, type, current_balance, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, institution || null, type, current_balance, source);

  insertSnapshot.run(result.lastInsertRowid, current_balance);

  res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid));
});

// Manual balance adjustment — for accounts SimpleFIN can't reach, or to
// correct drift. Updates the live balance and records a snapshot so the
// change shows up in balance history / net worth trend.
router.patch('/:id/balance', (req, res) => {
  const { current_balance } = req.body;
  if (current_balance === undefined || current_balance === null || isNaN(Number(current_balance))) {
    return res.status(400).json({ error: 'current_balance (number) is required' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'account not found' });

  db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(Number(current_balance), req.params.id);
  insertSnapshot.run(req.params.id, Number(current_balance));

  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id));
});

router.get('/:id/balance-history', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'account not found' });

  const rows = db.prepare(`
    SELECT balance, recorded_at FROM account_balance_snapshots
    WHERE account_id = ?
    ORDER BY recorded_at ASC
  `).all(req.params.id);
  res.json(rows);
});

module.exports = router;
