// The point of this summary is that not every outflow is spending. These tests
// pin the separation, using the shapes the real 2026 data takes: a Vanguard
// contribution, a credit card autopay and its matching leg, a refund.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-cash-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const { cashflow } = require('../src/services/cashflow');

seedTaxonomy();

const WINDOW = { from: '2026-02-01', to: '2026-03-01' };
let accountId;

const categoryId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

function txn(date, amount, merchant, category) {
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
     VALUES (?, ?, ?, ?, ?, 'csv_import')`
  ).run(accountId, date, amount, merchant, category === null ? null : categoryId(category));
}

test.beforeEach(() => {
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM accounts').run();
  accountId = db
    .prepare("INSERT INTO accounts (name, type, current_balance, source) VALUES ('Test', 'checking', 0, 'manual')")
    .run().lastInsertRowid;
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a contribution is saved, not spent', () => {
  txn('2026-02-10', 6521.5, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-18', -30000, 'VANGUARD BUY INVESTMENT', 'Investment Contributions');
  txn('2026-02-14', -50, 'RESTAURANT', 'Dining Out');

  const r = cashflow(WINDOW);
  assert.equal(r.spending, 50, 'only the meal was consumed');
  assert.equal(r.saved, 30000);
  assert.equal(r.income, 6521.5);
});

test('a transfer counts as neither, and its legs cancel', () => {
  txn('2026-02-11', 10000, 'PAYCHECK', "Tony's Paycheck");
  txn('2026-02-17', -10000, 'ALLY BANK $TRANSFER', 'Internal Transfer');
  txn('2026-02-19', 10000, 'Requested transfer from ALLY', 'Internal Transfer');

  const r = cashflow(WINDOW);
  assert.equal(r.spending, 0);
  assert.equal(r.saved, 0);
  assert.equal(r.income, 10000, 'the inbound leg is not income');
});

test('a credit card payment is not spending — the purchases already were', () => {
  txn('2026-02-10', -8690, 'CHASE CREDIT CRD AUTOPAY', 'Credit Card Payment');
  txn('2026-02-09', 8690, 'AUTOMATIC PAYMENT - THANK', 'Credit Card Payment');
  txn('2026-02-05', -120, 'GROCERY STORE', 'Groceries');

  const r = cashflow(WINDOW);
  assert.equal(r.spending, 120, 'counting the autopay too would double the groceries');
});

test('a refund reduces spending rather than adding income', () => {
  txn('2026-02-01', -200, 'PETCO', 'Pet');
  txn('2026-02-02', 59.03, 'PETCO REFUND', 'Pet');

  const r = cashflow(WINDOW);
  assert.equal(r.spending, 140.97);
  assert.equal(r.income, 0, 'a positive amount in a spending group is not income');
});

test('the savings rate is what was not spent, not what was transferred', () => {
  txn('2026-02-10', 10000, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-18', -2500, 'VANGUARD', 'Investment Contributions');
  txn('2026-02-20', -1000, 'RENT', 'Mortgage');

  const r = cashflow(WINDOW);
  assert.equal(r.surplus, 9000, 'earned less consumed');
  assert.equal(r.savings_rate, 90);
  assert.equal(r.saved, 2500, 'of which this much actually moved');
  assert.equal(r.unallocated, 6500, 'and this much stayed in cash');
});

test('living below your means counts even with nothing transferred', () => {
  // Under contributions/income this reads 0% while the cash balance climbs.
  txn('2026-02-10', 10000, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-20', -2000, 'RENT', 'Mortgage');

  const r = cashflow(WINDOW);
  assert.equal(r.savings_rate, 80);
  assert.equal(r.saved, 0);
  assert.equal(r.unallocated, 8000);
});

test('surplus reconciles to what moved plus what stayed', () => {
  txn('2026-02-10', 10000, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-18', -3000, 'VANGUARD', 'Investment Contributions');
  txn('2026-02-20', -1000, 'RENT', 'Mortgage');

  const r = cashflow(WINDOW);
  assert.equal(r.saved + r.unallocated, r.surplus);
});

test('no income means no savings rate rather than a division by zero', () => {
  txn('2026-02-20', -1000, 'RENT', 'Mortgage');
  assert.equal(cashflow(WINDOW).savings_rate, null);
});

test('spending more than you earn is a negative savings rate', () => {
  txn('2026-02-10', 5000, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-20', -6000, 'RENT', 'Mortgage');

  assert.equal(cashflow(WINDOW).savings_rate, -20);
});

test('rows outside the window are excluded', () => {
  txn('2026-01-31', -100, 'JANUARY', 'Groceries');
  txn('2026-02-15', -100, 'FEBRUARY', 'Groceries');
  txn('2026-03-01', -100, 'MARCH', 'Groceries');

  assert.equal(cashflow(WINDOW).spending, 100, 'the bounds are inclusive then exclusive');
});

test('uncategorized rows are counted so a partial picture is visible', () => {
  txn('2026-02-15', -100, 'GROCERY', 'Groceries');
  txn('2026-02-16', -75, 'MYSTERY', null);

  const r = cashflow(WINDOW);
  assert.equal(r.uncategorized_transactions, 1);
  assert.equal(r.spending, 100, 'and it is not silently folded into spending');
});

test('groups are reported with whether they counted as spending', () => {
  txn('2026-02-18', -30000, 'VANGUARD', 'Investment Contributions');
  txn('2026-02-15', -100, 'GROCERY', 'Groceries');

  const groups = cashflow(WINDOW).groups;
  const savings = groups.find((g) => g.group === 'Savings & Investments');
  const food = groups.find((g) => g.group === 'Food');
  assert.equal(savings.counts_as_spending, false);
  assert.equal(food.counts_as_spending, true);
});

// --- investment accounts -----------------------------------------------------
//
// A brokerage reports its own internal activity. None of it is household cash
// flow, and one piece of it is a live double-count risk: the contribution that
// funded a buy was already recorded as the outbound transfer from chequing.

function investmentAccount() {
  return db
    .prepare("INSERT INTO accounts (name, type, current_balance, source) VALUES ('Vanguard Roth IRA', 'investment', 0, 'simplefin')")
    .run().lastInsertRowid;
}

function txnOn(account, date, amount, merchant, category) {
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
     VALUES (?, ?, ?, ?, ?, 'simplefin')`
  ).run(account, date, amount, merchant, categoryId(category));
}

test('a buy inside the brokerage does not double-count the contribution', () => {
  // The cash side: $30,000 leaves chequing for Vanguard.
  txn('2026-02-18', -30000, 'VANGUARD BUY INVESTMENT', 'Investment Contributions');
  // The brokerage side: Vanguard reports the same money arriving and buying.
  const vanguard = investmentAccount();
  txnOn(vanguard, '2026-02-18', -30000, 'BUY VTSAX', 'Investment Contributions');

  const r = cashflow(WINDOW);
  assert.equal(r.saved, 30000, 'the contribution is counted once, not twice');
});

test('a dividend inside the account is not income', () => {
  txn('2026-02-10', 5000, 'PAYROLL', "Tony's Paycheck");
  const vanguard = investmentAccount();
  txnOn(vanguard, '2026-02-20', 812.44, 'DIVIDEND RECEIVED', 'Interest & Dividends');

  const r = cashflow(WINDOW);
  assert.equal(r.income, 5000, 'nothing was earned until it leaves the account');
});

test('a fee charged inside the account is not household spending', () => {
  txn('2026-02-15', -100, 'GROCERY', 'Groceries');
  const vanguard = investmentAccount();
  txnOn(vanguard, '2026-02-21', -35, 'ACCOUNT SERVICE FEE', 'Bank & Transfer Fees');

  assert.equal(cashflow(WINDOW).spending, 100);
});

test('an uncategorized brokerage row is not reported as a gap', () => {
  txn('2026-02-15', -100, 'GROCERY', 'Groceries');
  const vanguard = investmentAccount();
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
     VALUES (?, '2026-02-20', -0.01, 'VANGUARD FEDERAL MONEY MARKET INVESTOR C', NULL, 'simplefin')`
  ).run(vanguard);

  // Vanguard's sweep pairs will never be categorised, and shouldn't be: they
  // are excluded from the totals, so counting them would report a permanent
  // gap that no amount of work could close.
  assert.equal(cashflow(WINDOW).uncategorized_transactions, 0);
});
