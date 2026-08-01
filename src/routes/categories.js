const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY id').all());
});

module.exports = router;
