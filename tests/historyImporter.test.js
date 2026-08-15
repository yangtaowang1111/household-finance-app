// The historical import writes a year of real money into the database in one
// shot. The failure modes are quiet ones — a sign left inverted turns a fee
// into income, a bad rule mis-files every future transaction from that merchant
// — so each is pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-hist-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.TIMEZONE = 'America/Denver';

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const { importHistory, merchantPattern } = require('../src/services/historyImporter');
const { resolveCategory } = require('../src/db/taxonomy');

seedTaxonomy();

const HEADER = 'Date,Description,Amount,Owner,Account_Type,Account_Name,Source_File,Spending_Category,Is_P2P,User_Notes';

function writeCsv(rows) {
  const file = path.join(TMP, `in-${Math.random().toString(16).slice(2)}.csv`);
  fs.writeFileSync(file, [HEADER, ...rows].join('\n'));
  return file;
}

const row = ({ date = '2025-03-01', desc = 'TRADER JOE S #309', amount = '-42.50', owner = 'Tony', type = 'Credit Card', account = "Tony's 2025 Chase Sapphire Reserve Credit Card Transactions", category = 'Grocery', notes = '' }) =>
  `${date},"${desc}",${amount},${owner},${type},"${account}",src.CSV,"${category}",,"${notes}"`;

const categoryOf = (txnId) =>
  db.prepare('SELECT c.name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(txnId)?.name;

test.beforeEach(() => {
  db.exec("DELETE FROM transactions; DELETE FROM categorization_rules; DELETE FROM account_balance_snapshots; DELETE FROM accounts;");
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the taxonomy seeds as two levels, with groups above children', () => {
  const groups = db.prepare('SELECT COUNT(*) n FROM categories WHERE parent_category_id IS NULL').get().n;
  const children = db.prepare('SELECT COUNT(*) n FROM categories WHERE parent_category_id IS NOT NULL').get().n;
  assert.equal(groups, 15, '14 spending/income groups plus Uncategorized');
  assert.ok(children > 40, `expected the full child set, got ${children}`);

  // No child may itself be a parent — two levels, deliberately.
  const depth3 = db.prepare(`
    SELECT COUNT(*) n FROM categories child
    JOIN categories parent ON parent.id = child.parent_category_id
    WHERE parent.parent_category_id IS NOT NULL
  `).get().n;
  assert.equal(depth3, 0);
});

test('money that moves without being spent is flagged, not just named', () => {
  const flagOf = (name) => db.prepare('SELECT counts_as_spending FROM categories WHERE name = ?').get(name).counts_as_spending;
  assert.equal(flagOf('Credit Card Payment'), 0);
  assert.equal(flagOf('Internal Transfer'), 0);
  assert.equal(flagOf('Bank Fee & Waiver'), 0);
  assert.equal(flagOf("Tony's Paycheck"), 0, 'income is tracked but is not spend');
  assert.equal(flagOf('Groceries'), 1);
  assert.equal(flagOf('College Fund (529)'), 1, 'contributions are budgeted like a bill');
});

test('inverted-sign cards are corrected on import', () => {
  // Hilton Amex exports purchases positive. Left alone, this $550 annual fee
  // would be counted as income.
  const file = writeCsv([
    row({ desc: 'RENEWAL MEMBERSHIP FEE', amount: '550', owner: 'Sophia', account: "Sophia's Hilton American Express", category: 'Credit Card Annual Fee' }),
    row({ desc: 'COSTCO WHSE #1022', amount: '-116.62', category: 'Grocery' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.signsFlipped, 1, 'only the Amex row is flipped');

  const amex = db.prepare("SELECT amount FROM transactions WHERE merchant_raw = 'RENEWAL MEMBERSHIP FEE'").get();
  assert.equal(amex.amount, -550, 'a fee is an expense');

  const chase = db.prepare("SELECT amount FROM transactions WHERE merchant_raw LIKE 'COSTCO%'").get();
  assert.equal(chase.amount, -116.62, 'Chase rows are already correctly signed');
});

test('notes split a single source category into the right leaves', () => {
  assert.equal(resolveCategory('Golf', 'Golf gear'), 'Golf Gear');
  assert.equal(resolveCategory('Golf', 'Golf course'), 'Green Fees');
  assert.equal(resolveCategory('Golf', 'Driving Range'), 'Driving Range');
  assert.equal(resolveCategory('Golf', 'Golf coaching'), 'Golf Coaching');
  assert.equal(resolveCategory('Golf', ''), 'Green Fees', 'unnoted golf defaults to green fees');
});

test('case variants and typos in the source resolve to one category', () => {
  for (const variant of ['Dining out', 'Dining Out', 'DINING OUT']) {
    assert.equal(resolveCategory(variant, ''), 'Dining Out');
  }
  assert.equal(resolveCategory('SHopping', ''), 'General & Household');
  assert.equal(resolveCategory('Phamacy', ''), 'Pharmacy');
  for (const variant of ['Credit Card Balance Payment', 'Credit card balance payment', 'Credit Card balance payment']) {
    assert.equal(resolveCategory(variant, ''), 'Credit Card Payment');
  }
});

test('the one-off 529 transfer is a contribution, not a neutral transfer', () => {
  assert.equal(resolveCategory('Transfer', 'One time transfer to 529 Plan'), 'College Fund (529)');
  assert.equal(resolveCategory('Transfer', 'transfer to US Bank checking account'), 'Internal Transfer');
});

test('merchant patterns drop store numbers and order ids', () => {
  assert.equal(merchantPattern('CHICK-FIL-A #1111'), 'CHICK-FIL-A');
  assert.equal(merchantPattern('AMAZON MKTPL*NW7WD4B52'), 'AMAZON MKTPL');
  assert.equal(merchantPattern('TRADER JOE S #309'), 'TRADER JOE S');
  assert.equal(
    merchantPattern('PRIMROSE SCHOOL  7204887400                 PPD ID: 1470259040'),
    'PRIMROSE SCHOOL'
  );
});

test('a rule is learned only from a merchant categorized consistently', () => {
  const file = writeCsv([
    row({ date: '2025-01-05', desc: 'CHICK-FIL-A #1111', amount: '-11.65', category: 'Dining out' }),
    row({ date: '2025-02-05', desc: 'CHICK-FIL-A #02479', amount: '-11.57', category: 'Dining out' }),
    row({ date: '2025-03-05', desc: 'CHICK-FIL-A #03240', amount: '-11.65', category: 'Dining out' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.rulesLearned, 1);

  const rule = db.prepare(`
    SELECT cr.merchant_pattern, c.name AS category
    FROM categorization_rules cr JOIN categories c ON c.id = cr.category_id
  `).get();
  assert.equal(rule.merchant_pattern, 'CHICK-FIL-A', 'store numbers stripped, so future branches match');
  assert.equal(rule.category, 'Dining Out');
});

test('a merchant filed inconsistently teaches nothing', () => {
  // Better no rule than one that mis-files every future transaction.
  const file = writeCsv([
    row({ date: '2025-01-05', desc: 'WWW COSTCO COM', amount: '-50', category: 'Grocery' }),
    row({ date: '2025-02-05', desc: 'WWW COSTCO COM', amount: '-552', category: 'Rental Property Repair and Maintainence' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.rulesLearned, 0);
  assert.equal(r.rulesSkippedConflict, 1);
});

test('a merchant seen once teaches nothing', () => {
  const file = writeCsv([row({ desc: 'SOME ONE OFF PLACE', category: 'Dining out' })]);
  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.rulesLearned, 0);
});

test('re-running the import creates nothing new', () => {
  const rows = [
    row({ date: '2025-01-05', desc: 'TRADER JOE S #309', amount: '-42.50' }),
    row({ date: '2025-01-06', desc: 'COSTCO WHSE #1022', amount: '-116.62' }),
  ];
  const file = writeCsv(rows);

  assert.equal(importHistory(file, { before: '2026-05-18' }).imported, 2);
  const second = importHistory(file, { before: '2026-05-18' });
  assert.equal(second.imported, 0);
  assert.equal(second.skippedDuplicate, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 2);
});

test('genuine same-day duplicates are both kept', () => {
  // The real file has two identical Western Union transfers on one day and two
  // identical $4 range buckets. An existence-check dedup swallows the second of
  // each — silently losing real money.
  const file = writeCsv([
    row({ date: '2025-11-05', desc: 'WESTERN UNION', amount: '-1000.99', category: 'Family Support' }),
    row({ date: '2025-11-05', desc: 'WESTERN UNION', amount: '-1000.99', category: 'Family Support' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.imported, 2, 'both are real transactions');
  assert.equal(r.skippedDuplicate, 0);

  const total = db.prepare("SELECT SUM(amount) s FROM transactions WHERE merchant_raw = 'WESTERN UNION'").get().s;
  assert.equal(total, -2001.98);

  // ...and re-running still adds nothing.
  const again = importHistory(file, { before: '2026-05-18' });
  assert.equal(again.imported, 0);
  assert.equal(again.skippedDuplicate, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 2);
});

test('rows at or after the cutoff are left to SimpleFIN', () => {
  const file = writeCsv([
    row({ date: '2025-06-01', desc: 'BEFORE CUTOFF' }),
    row({ date: '2026-05-18', desc: 'ON CUTOFF' }),
    row({ date: '2026-07-01', desc: 'AFTER CUTOFF' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.imported, 1);
  assert.equal(r.skippedAfterCutoff, 2);
  assert.equal(db.prepare('SELECT merchant_raw FROM transactions').get().merchant_raw, 'BEFORE CUTOFF');
});

test('a dry run reports without writing', () => {
  const file = writeCsv([
    row({ date: '2025-01-05', desc: 'CHICK-FIL-A #1111', category: 'Dining out' }),
    row({ date: '2025-02-05', desc: 'CHICK-FIL-A #2222', category: 'Dining out' }),
  ]);

  const r = importHistory(file, { dryRun: true, before: '2026-05-18' });
  assert.equal(r.imported, 2, 'reports what it would do');
  assert.equal(r.rulesLearned, 1);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0, 'wrote nothing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM categorization_rules').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 0, 'not even the accounts');
});

test("the user's notes survive the import", () => {
  const file = writeCsv([
    row({ desc: 'AUTOWASH', amount: '-44.99', category: 'Subscription', notes: 'Cash Wash Subscription' }),
  ]);
  importHistory(file, { before: '2026-05-18' });
  const t = db.prepare("SELECT notes FROM transactions WHERE merchant_raw = 'AUTOWASH'").get();
  assert.equal(t.notes, 'Cash Wash Subscription');
});

test('an unknown category lands in Uncategorized and is reported, not dropped', () => {
  const file = writeCsv([row({ desc: 'MYSTERY MERCHANT', category: 'Some Category That Does Not Exist' })]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.imported, 1, 'the transaction is never silently discarded');
  assert.equal(r.unresolvedCategories['Some Category That Does Not Exist'], 1);

  const id = db.prepare("SELECT id FROM transactions WHERE merchant_raw = 'MYSTERY MERCHANT'").get().id;
  assert.equal(categoryOf(id), 'Uncategorized');
});

test('a confidently-matched account reuses the synced row instead of duplicating it', () => {
  db.prepare(`
    INSERT INTO accounts (name, type, current_balance, source, simplefin_id)
    VALUES ('Chase Sapphire Reserve (7530)', 'credit', -1200, 'simplefin', 'ACT-test')
  `).run();

  const file = writeCsv([row({ desc: 'TRADER JOE S #309' })]);
  const r = importHistory(file, { before: '2026-05-18' });

  assert.equal(r.accountsCreated.length, 0);
  assert.equal(r.accountsMatched.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1, 'no duplicate account');

  const t = db.prepare('SELECT account_id FROM transactions').get();
  const a = db.prepare('SELECT simplefin_id FROM accounts WHERE id = ?').get(t.account_id);
  assert.equal(a.simplefin_id, 'ACT-test', 'attached to the synced account');
});

test('an unrecognized account is created with its owner rather than guessed at', () => {
  const file = writeCsv([
    row({ owner: 'Sophia', account: "Sophia's Nordstrom card", desc: 'Nordstrom Visa', amount: '136.56', category: 'Shopping' }),
  ]);

  const r = importHistory(file, { before: '2026-05-18' });
  assert.equal(r.accountsCreated.length, 1);

  const a = db.prepare("SELECT owner, type, source FROM accounts WHERE name = ?").get("Sophia's Nordstrom card");
  assert.equal(a.owner, 'Sophia');
  assert.equal(a.type, 'credit');
  assert.equal(a.source, 'manual', 'never claims to be synced');
});
