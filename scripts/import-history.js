#!/usr/bin/env node
// Imports the hand-categorised historical spreadsheet.
//
//   npm run import:history -- --dry-run          # report, write nothing
//   npm run import:history                       # import for real
//   npm run import:history -- --file path.csv
//
// Defaults to the newest .csv in data/import/ (gitignored — the repo is public,
// so a year of real transactions must never be committed).
//
// Rows dated on or after --before are skipped. The default cutoff is the day
// SimpleFIN's own history begins, so the two sources meet without overlapping.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const { importHistory } = require('../src/services/historyImporter');

// Derived from DB_PATH rather than the app directory, because the two differ
// in the container: the app lives at /app but the data volume is mounted at
// /data. Following the database keeps "next to the data" true in both places.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
const IMPORT_DIR = process.env.IMPORT_DIR || path.join(path.dirname(DB_PATH), 'import');
const DEFAULT_CUTOFF = '2026-05-18'; // earliest date SimpleFIN can serve

function newestCsv() {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs
    .readdirSync(IMPORT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(IMPORT_DIR, files[0].f) : null;
}

function parseArgs(argv) {
  const args = { dryRun: false, file: null, before: DEFAULT_CUTOFF };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--before') args.before = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const file = args.file || newestCsv();

if (!file) {
  console.error(`No CSV found in ${IMPORT_DIR}. Put the export there, or pass --file.`);
  process.exit(1);
}

console.log(`file:   ${file}`);
console.log(`cutoff: importing rows dated before ${args.before}`);
console.log(args.dryRun ? 'mode:   DRY RUN — nothing will be written\n' : 'mode:   writing\n');

seedTaxonomy({ log: true });

const r = importHistory(file, { dryRun: args.dryRun, before: args.before });

console.log(`\nrows read:            ${r.read}`);
console.log(`imported:             ${r.imported}`);
console.log(`skipped (duplicate):  ${r.skippedDuplicate}`);
console.log(`skipped (>= cutoff):  ${r.skippedAfterCutoff}`);
console.log(`sign corrections:     ${r.signsFlipped}`);
console.log(`rules learned:        ${r.rulesLearned}`);
console.log(`rules skipped (conflicting categories): ${r.rulesSkippedConflict}`);

if (r.accountsMatched.length) {
  console.log('\nmatched to existing accounts:');
  for (const m of r.accountsMatched) console.log(`  ${m}`);
}
if (r.accountsCreated.length) {
  console.log('\ncreated new accounts (review these — merge later if any duplicate a synced account):');
  for (const a of r.accountsCreated) console.log(`  ${a}`);
}

const unresolved = Object.entries(r.unresolvedCategories);
if (unresolved.length) {
  console.log('\nUNRESOLVED categories (landed in Uncategorized):');
  for (const [name, n] of unresolved) console.log(`  ${n}x  ${name}`);
} else {
  console.log('\nevery source category resolved ✓');
}

if (!args.dryRun) {
  const spend = db.prepare(`
    SELECT COALESCE(-SUM(t.amount), 0) AS total
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE t.source = 'csv_import' AND c.counts_as_spending = 1
  `).get().total;
  console.log(`\nimported spending total: $${Math.abs(Math.round(spend)).toLocaleString('en-US')}`);
}
