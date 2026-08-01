const express = require('express');
const multer = require('multer');
const { importCsv } = require('../services/importer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('file'), (req, res) => {
  const { account_id } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field "file")' });

  try {
    const result = importCsv(req.file.buffer.toString('utf8'), account_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
