const express = require('express');
const { categorizeUncategorized } = require('../services/categorizer');

const router = express.Router();

router.post('/', async (req, res) => {
  const limit = req.body.limit ? Number(req.body.limit) : undefined;
  try {
    const result = await categorizeUncategorized(limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
