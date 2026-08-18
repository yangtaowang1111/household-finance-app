const express = require('express');
const { properties } = require('../services/properties');

const router = express.Router();

router.get('/', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'year must be a four-digit year' });
  }
  res.json(properties({ year }));
});

module.exports = router;
