const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { importCsv } = require('../services/importer');
const { importStatements } = require('../services/statementImporter');

const router = express.Router();
// 8 MB is far above any real statement and far below anything that could
// exhaust memory on the NAS.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Derived from DB_PATH rather than the app directory, because the two differ in
// the container: the app lives at /app and the data volume is mounted at /data.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'finance.db');
const IMPORT_DIR = process.env.IMPORT_DIR || path.join(path.dirname(DB_PATH), 'import');

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

// Bank statement upload, replacing scp-then-ssh with a file picker.
//
// The upload is written to disk before being read, rather than parsed from
// memory: the importer matches a file to an account by the last four digits in
// its NAME, so the filename is data, not decoration. Keeping the file also
// leaves an audit trail of what was actually imported.
router.post('/statements', upload.array('files', 30), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'at least one file is required (multipart field "files")' });
  }

  const dryRun = req.body.dry_run === 'true' || req.body.dry_run === '1';
  const from = req.body.from || undefined;
  const before = req.body.before || undefined;

  // A directory per upload, so one batch's dry run cannot pick up files left by
  // an earlier one — which would silently import more than was chosen.
  const batch = path.join(IMPORT_DIR, `upload-${Date.now()}`);
  fs.mkdirSync(batch, { recursive: true });

  try {
    for (const file of req.files) {
      // basename only: an originalname is attacker-controlled and could
      // otherwise carry a path out of the batch directory.
      const safe = path.basename(file.originalname).replace(/[^\w .\-()]/g, '_');
      fs.writeFileSync(path.join(batch, safe), file.buffer);
    }

    const reports = importStatements(batch, { dryRun, from, before });
    const imported = reports.reduce((n, r) => n + r.imported, 0);
    const failed = reports.filter((r) => r.error);

    // A dry run leaves nothing behind; a real import keeps the files.
    if (dryRun) fs.rmSync(batch, { recursive: true, force: true });

    res.json({
      dry_run: dryRun,
      imported,
      files: reports.length,
      skipped: failed.length,
      uncategorized: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL').get().n,
      reports,
    });
  } catch (err) {
    fs.rmSync(batch, { recursive: true, force: true });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
