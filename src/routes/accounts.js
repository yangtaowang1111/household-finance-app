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
  const { name, institution, type, current_balance = 0, source = 'manual', nickname, owner } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

  const result = db.prepare(`
    INSERT INTO accounts (name, institution, type, current_balance, source, nickname, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, institution || null, type, current_balance, source, nickname || null, owner || null);

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

// Editable metadata — the fields a human owns and sync must never overwrite.
// Balance is deliberately not among them: it belongs to PATCH /:id/balance,
// which also records a snapshot so the change reaches the net worth history.
const EDITABLE = ['nickname', 'owner', 'institution', 'secured_by_account_id', 'type'];

router.patch('/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'account not found' });

  const fields = Object.keys(req.body).filter((key) => EDITABLE.includes(key));
  if (!fields.length) {
    return res.status(400).json({ error: `nothing to update — editable fields are ${EDITABLE.join(', ')}` });
  }

  if (fields.includes('secured_by_account_id')) {
    const target = req.body.secured_by_account_id;
    if (target !== null) {
      const property = db.prepare('SELECT id, type FROM accounts WHERE id = ?').get(target);
      if (!property) return res.status(400).json({ error: 'secured_by_account_id does not exist' });
      if (Number(target) === Number(req.params.id)) {
        return res.status(400).json({ error: 'an account cannot secure itself' });
      }
      // Not enforced as a schema CHECK because the useful error is here, where
      // it can name what was actually passed.
      if (property.type !== 'property') {
        return res.status(400).json({ error: `secured_by_account_id must be a property, not a ${property.type}` });
      }
    }
  }

  // A confirmed type outranks whatever sync inferred, so setting it by hand
  // also marks it confirmed — otherwise the next sync would silently undo it.
  const sets = fields.map((f) => `${f} = @${f}`);
  if (fields.includes('type')) sets.push('type_confirmed = 1');

  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`).run({
    ...Object.fromEntries(fields.map((f) => [f, req.body[f]])),
    id: req.params.id,
  });

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
