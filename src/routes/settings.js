const express = require('express');
const db = require('../db');

const router = express.Router();

// Household facts the ledger cannot know. Free-form keys rather than columns:
// these accumulate slowly and unpredictably, and a migration per fact would be
// a poor trade.
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: 'nothing to set' });
  if (keys.length > 50) return res.status(400).json({ error: 'at most 50 settings at a time' });

  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  db.transaction(() => {
    // null clears a setting rather than storing the string "null", so an empty
    // field on the form means "unknown" rather than "zero".
    for (const key of keys) {
      const value = body[key];
      if (value === null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      else upsert.run(key, String(value));
    }
  })();

  res.json(Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])));
});

module.exports = router;
