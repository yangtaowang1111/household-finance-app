const express = require('express');
const { investments } = require('../services/investments');

const router = express.Router();

router.get('/', (req, res) => res.json(investments()));

module.exports = router;
