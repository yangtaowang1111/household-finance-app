// Budget against actual. The failure that matters most is silence: spending in
// a category with no budget must appear, because a report that iterates over
// budgets can never show the thing most worth seeing.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-prog-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const { budgetProgress } = require('../src/services/budgetProgress');
const { writePlan } = require('../src/services/budgetBaseline');

seedTaxonomy();

const categoryId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
let accountId;

function spend(category, year, monthAmounts) {
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
     VALUES (?, ?, ?, 'TEST', ?, 'csv_import')`
  );
  for (const [month, amount] of Object.entries(monthAmounts)) {
    insert.run(accountId, `${year}-${String(month).padStart(2, '0')}-15`, -amount, categoryId(category));
  }
}

const cat = (r, name) => r.groups.flatMap((g) => g.categories).find((c) => c.name === name);

test.beforeEach(() => {
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM budgets').run();
  db.prepare('DELETE FROM accounts').run();
  accountId = db
    .prepare("INSERT INTO accounts (name, type, current_balance, source) VALUES ('Card', 'credit', 0, 'manual')")
    .run().lastInsertRowid;
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a month compares against that month, not a twelfth of the year', () => {
  writePlan(2025, [{ category_id: categoryId('Groceries'), annual_amount: 12000 }]);
  spend('Groceries', 2025, { 3: 1150 });

  const g = cat(budgetProgress({ year: 2025, month: 3 }), 'Groceries');
  assert.equal(g.budgeted, 1000);
  assert.equal(g.actual, 1150);
  assert.equal(g.over, true);
  assert.equal(g.remaining, -150);
});

test('a seasonal month gets its seasonal budget', () => {
  // All of Travel is budgeted into July, so June is not one twelfth of the year.
  const shape = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  writePlan(2025, [{ category_id: categoryId('Travel'), annual_amount: 4000, shape }]);

  assert.equal(cat(budgetProgress({ year: 2025, month: 7 }), 'Travel').budgeted, 4000);
  assert.equal(budgetProgress({ year: 2025, month: 6 }).groups.length, 0, 'nothing budgeted or spent in June');
});

test('year to date compares only the months that have happened', () => {
  // A whole-year budget against a part-year actual would report every category
  // as comfortably under until December.
  writePlan(2025, [{ category_id: categoryId('Groceries'), annual_amount: 12000 }]);
  spend('Groceries', 2025, { 1: 1100, 2: 1100, 3: 1100 });

  const r = budgetProgress({ year: 2025 });
  assert.equal(r.months_covered, 12, 'a past year is complete');
  assert.equal(cat(r, 'Groceries').budgeted, 12000);
  assert.equal(cat(r, 'Groceries').actual, 3300);
});

test('spending with no budget is reported, not hidden', () => {
  spend('Golf Gear', 2025, { 5: 480 });

  const r = budgetProgress({ year: 2025 });
  const g = cat(r, 'Golf Gear');
  assert.equal(g.budgeted, null, 'null, because no budget was set');
  assert.equal(g.actual, 480);
  assert.equal(g.unbudgeted, true);
  assert.equal(r.unbudgeted_spending, 480);
});

test('a budget with no spending still appears', () => {
  writePlan(2025, [{ category_id: categoryId('Groceries'), annual_amount: 12000 }]);

  const g = cat(budgetProgress({ year: 2025 }), 'Groceries');
  assert.equal(g.actual, 0);
  assert.equal(g.remaining, 12000);
});

test('a category with neither budget nor spending is left out', () => {
  writePlan(2025, [{ category_id: categoryId('Groceries'), annual_amount: 12000 }]);
  assert.equal(cat(budgetProgress({ year: 2025 }), 'Golf Gear'), undefined);
});

test('children roll up to their group', () => {
  writePlan(2025, [
    { category_id: categoryId('Groceries'), annual_amount: 12000 },
    { category_id: categoryId('Dining Out'), annual_amount: 6000 },
  ]);
  spend('Groceries', 2025, { 1: 1000 });
  spend('Dining Out', 2025, { 1: 800 });

  const food = budgetProgress({ year: 2025 }).groups.find((g) => g.name === 'Food');
  assert.equal(food.budgeted, 18000);
  assert.equal(food.actual, 1800);
});

test('a cap on the group is shown against the children, not instead of them', () => {
  // The roadmap decision: a budget set on a group is a cap, and a conflict with
  // the children is surfaced rather than silently resolved.
  writePlan(2025, [
    { category_id: categoryId('Groceries'), annual_amount: 12000 },
    { category_id: categoryId('Dining Out'), annual_amount: 6000 },
    { category_id: categoryId('Food'), annual_amount: 15000 },
  ]);
  spend('Groceries', 2025, { 1: 100 });

  const food = budgetProgress({ year: 2025 }).groups.find((g) => g.name === 'Food');
  assert.equal(food.cap, 15000);
  assert.equal(food.budgeted, 18000, 'the children still total what they total');
  assert.equal(food.cap_exceeded_by, 3000);
});

test('an unspent cap raises no conflict', () => {
  writePlan(2025, [
    { category_id: categoryId('Groceries'), annual_amount: 12000 },
    { category_id: categoryId('Food'), annual_amount: 15000 },
  ]);
  spend('Groceries', 2025, { 1: 100 });

  const food = budgetProgress({ year: 2025 }).groups.find((g) => g.name === 'Food');
  assert.equal(food.cap_exceeded_by, null);
});

test('transfers and contributions never reach the budget', () => {
  // counts_as_spending = 0 categories are excluded entirely: a credit card
  // payment is not a budget line, and including it would double-count the
  // purchases it settles.
  spend('Credit Card Payment', 2025, { 1: 8690 });
  spend('Groceries', 2025, { 1: 100 });

  const r = budgetProgress({ year: 2025 });
  assert.equal(r.actual, 100);
  assert.equal(cat(r, 'Credit Card Payment'), undefined);
});

test('totals agree with the groups they came from', () => {
  writePlan(2025, [
    { category_id: categoryId('Groceries'), annual_amount: 12000 },
    { category_id: categoryId('Green Fees'), annual_amount: 2400 },
  ]);
  spend('Groceries', 2025, { 1: 1000 });
  spend('Green Fees', 2025, { 1: 300 });

  const r = budgetProgress({ year: 2025 });
  assert.equal(r.budgeted, 14400);
  assert.equal(r.actual, 1300);
  assert.equal(r.remaining, 13100);
  assert.equal(r.used_percent, 9);
});

test('spending against a zero budget reads as over', () => {
  // The off-month case with real money in it: Travel budgets nothing for June,
  // and a June trip is exactly what a budget screen exists to surface.
  const shape = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  writePlan(2025, [{ category_id: categoryId('Travel'), annual_amount: 4000, shape }]);
  spend('Travel', 2025, { 6: 900 });

  const g = cat(budgetProgress({ year: 2025, month: 6 }), 'Travel');
  assert.equal(g.budgeted, 0);
  assert.equal(g.actual, 900);
  assert.equal(g.over, true);
});
