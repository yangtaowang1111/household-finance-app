// Statement importing has two ways to go quietly wrong, and both are expensive
// to unpick later: a file attributed to the wrong account (a year of someone
// else's spending), and a window that lets rows in twice (the December that is
// already in the database from the spreadsheet import). These tests pin both,
// plus the four real bank formats.
//
//   npm test
//
// Fixtures are trimmed copies of the real 2026-08-16 exports — same headers,
// same quoting, same quirks (Ally's leading spaces, Chase's trailing comma).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-stmt-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.TIMEZONE = 'America/Denver';

const db = require('../src/db');
const { seedCategories } = require('../src/db/seed');
const {
  importStatements,
  detectFormat,
  resolveAccount,
  nicknameFrom,
  usDate,
  isoDate,
} = require('../src/services/statementImporter');

seedCategories();

const IMPORT_DIR = path.join(TMP, 'import');

/** Writes a fixture CSV and returns the directory holding it. */
function fixture(name, content) {
  fs.rmSync(IMPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMPORT_DIR, name), content);
  return IMPORT_DIR;
}

function makeAccount(name) {
  return db
    .prepare("INSERT INTO accounts (name, type, current_balance, source) VALUES (?, 'credit', 0, 'manual')")
    .run(name).lastInsertRowid;
}

const allTxns = () => db.prepare('SELECT * FROM transactions ORDER BY date, id').all();

test.beforeEach(() => {
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM accounts').run();
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- date parsing ------------------------------------------------------------

test('parses both date conventions the banks use', () => {
  assert.equal(usDate('08/13/2026'), '2026-08-13');
  assert.equal(usDate('1/2/2026'), '2026-01-02', 'unpadded is still valid');
  assert.equal(isoDate('2026-08-03'), '2026-08-03');
  assert.equal(isoDate('2026-08-03T23:42:51'), '2026-08-03', 'a timestamp keeps its date');
  assert.equal(usDate('not a date'), null);
  assert.equal(isoDate(''), null);
});

// --- format detection --------------------------------------------------------

test('tells the four bank formats apart', () => {
  assert.equal(detectFormat(['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance']).name, 'chase-bank');
  assert.equal(detectFormat(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo']).name, 'chase-card');
  assert.equal(detectFormat(['Date', 'Transaction', 'Name', 'Memo', 'Amount']).name, 'usbank');
  assert.equal(detectFormat(['Date', 'Time', 'Amount', 'Type', 'Description']).name, 'ally');
});

test('an unrecognised export is refused rather than half-read', () => {
  assert.equal(detectFormat(['when', 'how much', 'what']), null);
});

// --- account resolution ------------------------------------------------------

test('matches a file to an account by the last four in its name', () => {
  const accounts = new Map([['7530', { id: 1, name: 'Chase Sapphire Reserve (7530)' }]]);
  const { account } = resolveAccount('Chase7530_Activity_20260816.csv', accounts);
  assert.equal(account.id, 1);
});

test('other four-digit runs in a filename are ignored', () => {
  // "20260816" and "01-01-2026" both contain four-digit runs; only a run that
  // names a real account may win.
  const accounts = new Map([['3475', { id: 9, name: 'Checking - 3475 (3475)' }]]);
  const { account } = resolveAccount('USBank Checking - 3475_01-01-2026_08-20-2026.csv', accounts);
  assert.equal(account.id, 9);
});

test('a filename naming no known account is refused', () => {
  const { account } = resolveAccount('mystery-statement.csv', new Map([['7530', { id: 1 }]]));
  assert.equal(account, null);
});

test('a filename naming two accounts is refused rather than guessed', () => {
  const accounts = new Map([
    ['7530', { id: 1 }],
    ['2469', { id: 2 }],
  ]);
  const { account, candidates } = resolveAccount('Chase7530_and_2469.csv', accounts);
  assert.equal(account, null, 'ambiguity must not resolve to whichever came first');
  assert.equal(candidates.length, 2);
});

// --- nicknames ---------------------------------------------------------------

test('takes an account nickname from the filename when there is one', () => {
  assert.equal(nicknameFrom('Ally Bank8794_Friction Buffer.csv'), 'Friction Buffer');
  assert.equal(nicknameFrom('Ally Bank8802_Emergency Fund.csv'), 'Emergency Fund');
});

test('does not mistake structure or dates for a nickname', () => {
  assert.equal(nicknameFrom('Chase0221_Activity_20260816.csv'), null);
  assert.equal(nicknameFrom('USBank Checking - 3475_01-01-2026_08-20-2026.csv'), null);
});

test('a nickname fills a gap but never overwrites one already set', () => {
  const id = makeAccount('Savings Account (8794)');
  db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run('Chosen By Hand', id);

  const dir = fixture(
    'Ally Bank8794_Friction Buffer.csv',
    'Date, Time, Amount, Type, Description\n2026-03-03,23:46:02,11.25,Deposit,Interest Paid\n'
  );
  importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });

  assert.equal(db.prepare('SELECT nickname FROM accounts WHERE id = ?').get(id).nickname, 'Chosen By Hand');
});

// --- the window --------------------------------------------------------------

test('rows before the window are skipped — a 2026 export opens in December 2025', () => {
  makeAccount('Chase Sapphire Reserve (7530)');
  const dir = fixture(
    'Chase7530_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '12/29/2025,12/30/2025,OLD DECEMBER CHARGE,Food & Drink,Sale,-20.00,\n' +
      '01/15/2026,01/16/2026,JANUARY CHARGE,Food & Drink,Sale,-30.00,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.skippedOutsideWindow, 1);
  assert.equal(report.imported, 1);
  assert.equal(allTxns()[0].merchant_raw, 'JANUARY CHARGE', 'the December row would duplicate the spreadsheet import');
});

test('rows on or after the cutoff are skipped — SimpleFIN already has them', () => {
  makeAccount('Chase Sapphire Reserve (7530)');
  const dir = fixture(
    'Chase7530_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '05/19/2026,05/20/2026,DAY BEFORE,Food & Drink,Sale,-10.00,\n' +
      '05/20/2026,05/21/2026,FIRST SYNCED DAY,Food & Drink,Sale,-11.00,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.imported, 1);
  assert.equal(allTxns()[0].merchant_raw, 'DAY BEFORE', 'the cutoff is exclusive at the top');
});

// --- dedup -------------------------------------------------------------------

test('re-importing the same file adds nothing', () => {
  makeAccount('Chase Freedom Unlimited (5053)');
  const csv =
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
    '02/13/2026,02/14/2026,SABOR MEXICAN GRILL,Food & Drink,Sale,-6.89,\n';
  const dir = fixture('Chase5053_Activity_20260816.csv', csv);

  importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  const [second] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });

  assert.equal(second.imported, 0);
  assert.equal(second.skippedDuplicate, 1);
  assert.equal(allTxns().length, 1);
});

test('genuine same-day repeats are both kept', () => {
  makeAccount('Chase Freedom Unlimited (5053)');
  const csv =
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
    '02/13/2026,02/14/2026,SOUTH SUBURBAN GOLF,Golf,Sale,-4.00,\n' +
    '02/13/2026,02/14/2026,SOUTH SUBURBAN GOLF,Golf,Sale,-4.00,\n';
  const dir = fixture('Chase5053_Activity_20260816.csv', csv);

  const [first] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(first.imported, 2, 'two range buckets on one day are two transactions');

  const [second] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(second.imported, 0, 'and a re-run still adds neither');
  assert.equal(allTxns().length, 2);
});

// --- signs -------------------------------------------------------------------

test('an inverted sign is reported, never silently flipped', () => {
  makeAccount('Chase Sapphire Reserve (7530)');
  const dir = fixture(
    'Chase7530_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/01/2026,02/02/2026,ANNUAL MEMBERSHIP FEE,Fees,Fee,550.00,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.signAnomalies.length, 1, 'a positive Fee disagrees with the bank\'s own label');
  assert.equal(allTxns()[0].amount, 550, 'and the amount is left exactly as the bank wrote it');
});

test('correctly signed rows raise nothing', () => {
  makeAccount('Chase Sapphire Reserve (7530)');
  const dir = fixture(
    'Chase7530_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/01/2026,02/02/2026,TST*HICKORY HOUSE RIBS,Food & Drink,Sale,-22.06,\n' +
      '02/02/2026,02/03/2026,PETCO 0912,Shopping,Return,59.03,\n' +
      '02/03/2026,02/04/2026,AUTOMATIC PAYMENT - THANK,,Payment,19.00,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.signAnomalies.length, 0);
  assert.equal(report.imported, 3);
});

// --- per-format parsing ------------------------------------------------------

test('reads Chase checking, trailing comma and all', () => {
  makeAccount('PREMIER PLUS CKG (0221)');
  const dir = fixture(
    'Chase0221_Activity_20260816.csv',
    'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n' +
      'DEBIT,01/13/2026,"AMERICAN EXPRESS ACH PMT    A0850           WEB ID: 9493560001",-18.08,ACH_DEBIT,19726.96,,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.format, 'chase-bank');
  assert.equal(report.imported, 1);
  const t = allTxns()[0];
  assert.equal(t.amount, -18.08);
  assert.equal(t.date, '2026-01-13');
  assert.match(t.merchant_raw, /AMERICAN EXPRESS ACH PMT/);
  assert.ok(!/ {2}/.test(t.merchant_raw), 'runs of spaces are collapsed');
});

test('reads US Bank, ignoring the noise in Memo', () => {
  makeAccount('Credit Card - 6288 (6288)');
  const dir = fixture(
    'USBank Credit Card - 6288_01-01-2026_08-20-2026.csv',
    '"Date","Transaction","Name","Memo","Amount"\n' +
      '"2026-03-10","DEBIT","PGA TOUR SUPERSTORE 06 GREENWOOD VIL CO","24013396210006802149385; 05941; ; ; ;","-53.61"\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.format, 'usbank');
  const t = allTxns()[0];
  assert.equal(t.amount, -53.61);
  assert.match(t.merchant_raw, /PGA TOUR SUPERSTORE/);
  assert.ok(!/24013396/.test(t.merchant_raw), 'the auth string is not part of the merchant');
});

test('reads Ally, whose headers carry leading spaces', () => {
  makeAccount('Savings Account (8802)');
  const dir = fixture(
    'Ally Bank8802_Emergency Fund.csv',
    'Date, Time, Amount, Type, Description\n' +
      '2026-02-10,05:33:06,50000.00,Deposit,Requested transfer from YANGTAO WANG Ally Bank Transfer\n' +
      '2026-03-03,23:46:02,122.81,Deposit,Interest Paid\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  assert.equal(report.format, 'ally', 'untrimmed headers would make every column miss');
  assert.equal(report.imported, 2);
  assert.equal(allTxns()[0].amount, 50000);
});

// --- transactional behaviour -------------------------------------------------

test('a dry run writes nothing at all', () => {
  makeAccount('Chase Freedom Unlimited (5053)');
  const dir = fixture(
    'Chase5053_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/13/2026,02/14/2026,SABOR MEXICAN GRILL,Food & Drink,Sale,-6.89,\n'
  );

  const [report] = importStatements(dir, { from: '2026-01-01', before: '2026-05-20', dryRun: true });
  assert.equal(report.imported, 1, 'it still reports what it would do');
  assert.equal(allTxns().length, 0, 'but nothing landed');
});

test('imported rows are left uncategorized for the categoriser', () => {
  makeAccount('Chase Freedom Unlimited (5053)');
  const dir = fixture(
    'Chase5053_Activity_20260816.csv',
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/13/2026,02/14/2026,SABOR MEXICAN GRILL,Food & Drink,Sale,-6.89,\n'
  );

  importStatements(dir, { from: '2026-01-01', before: '2026-05-20' });
  const t = allTxns()[0];
  assert.equal(t.category_id, null, "Chase's own Category column is not our taxonomy");
  assert.equal(t.source, 'csv_import');
});

test('a file naming no known account is reported without stopping the others', () => {
  makeAccount('Chase Freedom Unlimited (5053)');
  fs.rmSync(IMPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(IMPORT_DIR, 'Chase5053_Activity_20260816.csv'),
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/13/2026,02/14/2026,SABOR MEXICAN GRILL,Food & Drink,Sale,-6.89,\n'
  );
  fs.writeFileSync(
    path.join(IMPORT_DIR, 'unknown-card.csv'),
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' +
      '02/13/2026,02/14/2026,SOMETHING,Food & Drink,Sale,-1.00,\n'
  );

  const reports = importStatements(IMPORT_DIR, { from: '2026-01-01', before: '2026-05-20' });
  const failed = reports.filter((r) => r.error);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /last four digits/);
  assert.equal(allTxns().length, 1, 'the identifiable file still imported');
});
