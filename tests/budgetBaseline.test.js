// Suggesting a budget from history. The failure mode that matters is confident
// nonsense — a suggestion that looks authoritative while being 68% above what
// was actually spent, which is what median-times-twelve produced before these
// tests existed.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-budget-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const {
  baseline,
  writePlan,
  median,
  coefficientOfVariation,
  monthlyShape,
} = require('../src/services/budgetBaseline');

seedTaxonomy();

const categoryId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
let accountId;

/** Spends `amount` in each given month of `year`, on one category. */
function spend(category, year, monthAmounts) {
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, source)
     VALUES (?, ?, ?, 'TEST', ?, 'csv_import')`
  );
  for (const [month, amount] of Object.entries(monthAmounts)) {
    insert.run(accountId, `${year}-${String(month).padStart(2, '0')}-15`, -amount, categoryId(category));
  }
}

const find = (result, name) => result.categories.find((c) => c.name === name);

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

// --- the statistics ---------------------------------------------------------

test('the median ignores months with no spending', () => {
  assert.equal(median([0, 0, 100, 200, 300, 0, 0, 0, 0, 0, 0, 0]), 200);
});

test('an even year has no variation; a single-month year has a lot', () => {
  assert.equal(coefficientOfVariation(Array(12).fill(100)), 0);
  assert.ok(coefficientOfVariation([1200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) > 3);
});

test('a flat category spreads evenly; a seasonal one keeps its shape', () => {
  assert.deepEqual(monthlyShape(Array(12).fill(100), false), Array(12).fill(1 / 12));

  const summerHeavy = [0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0];
  const shape = monthlyShape(summerHeavy, true);
  assert.equal(shape[6], 1, 'all of it lands in July, where it actually happened');
  assert.equal(shape[0], 0);
});

// --- the suggestion ---------------------------------------------------------

test('a sparse category is not scaled up to twelve months', () => {
  // The bug this exists to prevent: one $60 purchase all year suggested $720.
  spend('Kids — Other', 2025, { 10: 60 });

  const r = find(baseline({ year: 2026, reference: 2025 }), 'Kids — Other');
  assert.equal(r.reference_year.total, 60);
  assert.equal(r.suggested_annual, 60, 'spending $60 once is a $60 budget');
});

test('a part-year category suggests what it actually cost', () => {
  // 2025 Travel: five active months, $4,000. median x 12 said $6,727.
  spend('Travel', 2025, { 3: 400, 6: 1200, 7: 1800, 8: 400, 11: 200 });

  const r = find(baseline({ year: 2026, reference: 2025 }), 'Travel');
  assert.equal(r.reference_year.total, 4000);
  assert.equal(r.suggested_annual, 4000);
  assert.equal(r.reference_year.active_months, 5);
});

test('the current run rate pulls the suggestion, without overwhelming it', () => {
  // Two complete past years, so the assertion does not change depending on
  // which month the suite happens to run in.
  const everyMonth = (amount) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, amount]));
  spend('Groceries', 2024, everyMonth(1000)); // 12,000
  spend('Groceries', 2025, everyMonth(1500)); // 18,000

  const r = find(baseline({ year: 2025, reference: 2024 }), 'Groceries');
  assert.ok(r.suggested_annual > 12000, 'a category trending up is not going back');
  assert.ok(r.suggested_annual < 18000, 'but the older year still carries weight');
});

test('an unspent month counts against the run rate', () => {
  // A category quiet since May is running at less than its January pace, and
  // the suggestion should say so — months_elapsed is the divisor, not the
  // number of months that happened to have spending.
  spend('Groceries', 2025, { 1: 1500, 2: 1500, 3: 1500, 4: 1500 });

  const r = find(baseline({ year: 2025, reference: 2024 }), 'Groceries');
  assert.equal(r.current_year.months_elapsed, 12, 'a past year is fully elapsed');
  assert.equal(r.current_year.run_rate, 500, '6,000 across twelve months, not four');
});

test('a category with no history at all suggests nothing', () => {
  const r = find(baseline({ year: 2026, reference: 2025 }), 'Golf Gear');
  assert.equal(r.suggested_annual, 0);
  assert.equal(r.reference_year.total, 0);
});

// --- one-offs ---------------------------------------------------------------

test('a spike is reported rather than smoothed away', () => {
  // 2025 Taxes was one $10,349 payment in April. Both hiding it and averaging
  // it across the year would be wrong; naming it lets a person decide.
  spend('Taxes', 2025, { 4: 10349 });

  const r = find(baseline({ year: 2026, reference: 2025 }), 'Taxes');
  assert.equal(r.reference_year.largest_month.month, 4);
  assert.equal(r.reference_year.largest_month.amount, 10349);
  assert.equal(r.reference_year.largest_month.share, 1, 'the whole year landed in one month');
});

test('an even category reports no dominant month', () => {
  spend('Groceries', 2025, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1000])));

  const r = find(baseline({ year: 2026, reference: 2025 }), 'Groceries');
  assert.ok(r.reference_year.largest_month.share < 0.1);
  assert.equal(r.seasonal, false);
});

// --- writing the plan -------------------------------------------------------

test('an annual figure becomes twelve monthly budgets', () => {
  const id = categoryId('Groceries');
  const r = writePlan(2026, [{ category_id: id, annual_amount: 12000 }]);

  assert.equal(r.written, 12);
  const rows = db.prepare('SELECT month, budgeted_amount FROM budgets WHERE category_id = ? ORDER BY month').all(id);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].month, '2026-01');
  assert.equal(rows[0].budgeted_amount, 1000);
});

test('a seasonal shape puts the money in the months it belongs', () => {
  const id = categoryId('Travel');
  const shape = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0];
  writePlan(2026, [{ category_id: id, annual_amount: 4000, shape }]);

  const rows = db.prepare('SELECT month, budgeted_amount FROM budgets WHERE category_id = ? ORDER BY month').all(id);
  assert.equal(rows.find((r) => r.month === '2026-07').budgeted_amount, 2000);
  assert.equal(rows.find((r) => r.month === '2026-01').budgeted_amount, 0);
});

test('rewriting a plan replaces it rather than doubling it', () => {
  const id = categoryId('Groceries');
  writePlan(2026, [{ category_id: id, annual_amount: 12000 }]);
  writePlan(2026, [{ category_id: id, annual_amount: 6000 }]);

  const rows = db.prepare('SELECT budgeted_amount FROM budgets WHERE category_id = ?').all(id);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].budgeted_amount, 500);
});

test('a zero annual figure clears the budget instead of setting one of zero', () => {
  // "No budget" and "a budget of nothing" are different: the second reports
  // every purchase as an overspend.
  const id = categoryId('Groceries');
  writePlan(2026, [{ category_id: id, annual_amount: 12000 }]);
  const r = writePlan(2026, [{ category_id: id, annual_amount: 0 }]);

  assert.equal(r.cleared, 12);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM budgets WHERE category_id = ?').get(id).n, 0);
});

test('a written plan is reported back as the existing budget', () => {
  const id = categoryId('Groceries');
  writePlan(2026, [{ category_id: id, annual_amount: 12000 }]);

  assert.equal(find(baseline({ year: 2026, reference: 2025 }), 'Groceries').budgeted_annual, 12000);
});

test('writing one year leaves another alone', () => {
  const id = categoryId('Groceries');
  writePlan(2026, [{ category_id: id, annual_amount: 12000 }]);
  writePlan(2027, [{ category_id: id, annual_amount: 6000 }]);

  assert.equal(find(baseline({ year: 2026, reference: 2025 }), 'Groceries').budgeted_annual, 12000);
  assert.equal(find(baseline({ year: 2027, reference: 2026 }), 'Groceries').budgeted_annual, 6000);
});

// --- projecting a part-finished year ----------------------------------------

test('a once-a-year cost that has happened projects to what was paid', () => {
  // The tax case. April 2026 was $8,042 for tax year 2025. Annualising a flat
  // run rate over eight elapsed months projects ~$12,000 for a payment that
  // happens once and is already done.
  spend('Taxes', 2024, { 4: 10349 });
  spend('Taxes', 2025, { 4: 8042 });

  const r = find(baseline({ year: 2025, reference: 2024 }), 'Taxes');
  assert.equal(r.current_year.projected_annual, 8042, 'the year is already fully spent for this category');
  assert.equal(r.current_year.elapsed_share, 1);
});

test('a flat category still annualises normally', () => {
  spend('Groceries', 2024, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1000])));
  spend('Groceries', 2025, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1200])));

  const r = find(baseline({ year: 2025, reference: 2024 }), 'Groceries');
  assert.equal(r.current_year.projected_annual, 14400);
});

test('a spend still to come is not projected from almost nothing', () => {
  // A December-only category has no basis for a projection in March. Dividing
  // by a near-zero elapsed share would produce an enormous number.
  spend('Gifts', 2024, { 12: 3000 });

  const r = find(baseline({ year: 2025, reference: 2024 }), 'Gifts');
  assert.ok(Number.isFinite(r.current_year.projected_annual));
  assert.ok(r.current_year.projected_annual < 3001, 'no explosion from a tiny divisor');
});
