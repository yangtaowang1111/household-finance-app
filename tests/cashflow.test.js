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

test('reports the savings rate off income', () => {
  txn('2026-02-10', 10000, 'PAYROLL', "Tony's Paycheck");
  txn('2026-02-18', -2500, 'VANGUARD', 'Investment Contributions');
  txn('2026-02-20', -1000, 'RENT', 'Mortgage');

  const r = cashflow(WINDOW);
  assert.equal(r.savings_rate, 25);
  assert.equal(r.net, 6500, 'income less what was spent and what was put away');
});

test('no income means no savings rate rather than a division by zero', () => {
  txn('2026-02-20', -1000, 'RENT', 'Mortgage');
  assert.equal(cashflow(WINDOW).savings_rate, null);
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
