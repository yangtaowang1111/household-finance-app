#!/usr/bin/env node
// Consistent SQLite backup (safe even with WAL mode active), for use with
// a daily cron job. Usage: node scripts/backup-db.js <destination-dir>
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
const destDir = process.argv[2];

if (!destDir) {
  console.error('Usage: node scripts/backup-db.js <destination-dir>');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destPath = path.join(destDir, `finance-${timestamp}.db`);

const db = new Database(DB_PATH, { readonly: true });
db.backup(destPath)
  .then(() => {
    console.log(`Backed up ${DB_PATH} -> ${destPath}`);
    db.close();
  })
  .catch((err) => {
    console.error('Backup failed:', err);
    db.close();
    process.exit(1);
  });
