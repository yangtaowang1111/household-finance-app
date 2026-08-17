#!/usr/bin/env node
// Imports raw bank statement exports (one file per account) into the database.
//
//   npm run import:statements -- --dry-run     # report, write nothing
//   npm run import:statements                  # import for real
//   npm run import:statements -- --dir data/import/2026
//   npm run import:statements -- --from 2026-01-01 --before 2026-05-20
//
// Each file must have its account's last four digits somewhere in the filename
// — that is how a file is matched to an account, because bank exports rarely
// say which account they came from. A file naming no known account, or more
// than one, is reported and skipped rather than guessed at.
//
// The window is bounded at BOTH ends on purpose. A "2026" export from Chase
// opens in late December 2025, and those rows are already in the database from
// the spreadsheet import; --before keeps it clear of what SimpleFIN already
// syncs. Defaults cover exactly the gap between the two sources.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { importStatements } = require('../src/services/statementImporter');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
const DEFAULT_DIR = path.join(path.dirname(DB_PATH), 'import', '2026');

// The 2025 spreadsheet ends at the close of 2025; SimpleFIN's earliest synced
// transaction is 2026-05-20. These two bounds are the hole between them.
const DEFAULT_FROM = '2026-01-01';
const DEFAULT_BEFORE = '2026-05-20';

function parseArgs(argv) {
  const args = { dryRun: false, dir: DEFAULT_DIR, from: DEFAULT_FROM, before: DEFAULT_BEFORE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--before') args.before = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!fs.existsSync(args.dir)) {
  console.error(`No such directory: ${args.dir}`);
  process.exit(1);
}

console.log(`dir:    ${args.dir}`);
console.log(`window: ${args.from} .. ${args.before} (rows outside are skipped)`);
console.log(args.dryRun ? 'mode:   DRY RUN — nothing will be written\n' : 'mode:   writing\n');

const reports = importStatements(args.dir, {
  dryRun: args.dryRun,
  from: args.from,
  before: args.before,
});

const failed = reports.filter((r) => r.error);
const ok = reports.filter((r) => !r.error);

for (const r of ok) {
  console.log(`${r.file}`);
  console.log(`  ${r.format}  ->  ${r.account}`);
  console.log(
    `  read ${r.read}, imported ${r.imported}, ` +
      `outside window ${r.skippedOutsideWindow}, duplicate ${r.skippedDuplicate}` +
      (r.skippedUnparsable ? `, unparsable ${r.skippedUnparsable}` : '')
  );
  if (r.nickname) console.log(`  named the account "${r.nickname}"`);
  if (r.signAnomalies.length) {
    console.log(`  ⚠ ${r.signAnomalies.length} rows whose sign disagrees with the bank's own label:`);
    for (const a of r.signAnomalies.slice(0, 5)) console.log(`      ${a}`);
    if (r.signAnomalies.length > 5) console.log(`      ... and ${r.signAnomalies.length - 5} more`);
  }
  console.log();
}

if (failed.length) {
  console.log('COULD NOT IMPORT — nothing from these files was written:');
  for (const r of failed) console.log(`  ${r.file}\n      ${r.error}`);
  console.log();
}

const total = ok.reduce((s, r) => s + r.imported, 0);
const anomalies = ok.reduce((s, r) => s + r.signAnomalies.length, 0);
console.log(`${ok.length} files imported, ${failed.length} skipped, ${total} transactions`);

if (anomalies) {
  console.log(
    `\n⚠ ${anomalies} sign anomalies above. Nothing was flipped — check a few against the\n` +
      `  real statement before trusting the totals. Three of the 2025 cards genuinely\n` +
      `  did export inverted, so this is worth a look rather than a shrug.`
  );
}

if (!args.dryRun && total) {
  const uncategorized = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL")
    .get().n;
  console.log(
    `\n${uncategorized} transactions are now uncategorized. Run the categoriser to file them:\n` +
      `  curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \\\n` +
      `    -d '{"limit": 500}' http://localhost:3000/api/categorize`
  );
}

// A file that could not be attributed to an account is a silent data gap, so it
// exits non-zero — the same reason the sync does.
if (failed.length) process.exitCode = 1;
