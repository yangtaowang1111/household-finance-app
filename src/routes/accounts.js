const express = require('express');
const db = require('../db');

const router = express.Router();

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

  res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid));
});

module.exports = router;
