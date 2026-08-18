const express = require('express');
const db = require('../db');

const router = express.Router();

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

// Notes pinned to the month they describe. A review reads the standing note
// from settings plus that year's notes up to the period it covers, so nothing
// here ever needs pruning: a note about August is simply not read by a review
// of a period that does not include August.
router.get('/', (req, res) => {
  const { year } = req.query;
  const rows = year
    ? db.prepare('SELECT * FROM period_notes WHERE period LIKE ? ORDER BY period DESC').all(`${year}-%`)
    : db.prepare('SELECT * FROM period_notes ORDER BY period DESC LIMIT 60').all();
  res.json(rows);
});

router.put('/:period', (req, res) => {
  const { period } = req.params;
  if (!PERIOD.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (note.length > 4000) return res.status(400).json({ error: 'note is too long (4000 characters max)' });

  // An empty note deletes rather than storing a blank row — "nothing to say
  // about this month" and "a note that says nothing" should not be different
  // states.
  if (!note) {
    db.prepare('DELETE FROM period_notes WHERE period = ?').run(period);
    return res.status(204).end();
  }

  db.prepare(
    `INSERT INTO period_notes (period, note) VALUES (?, ?)
     ON CONFLICT(period) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`
  ).run(period, note);

  res.json(db.prepare('SELECT * FROM period_notes WHERE period = ?').get(period));
});

module.exports = router;
