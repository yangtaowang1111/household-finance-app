// Year-end forecasting. The case that carries most of the value is one_off:
// a cost that lands once a year and has already landed should forecast nothing
// more, and a run-rate approach gets that badly wrong in a way nobody notices.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-fc-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');
const { forecast, classify, remaining } = require('../src/services/forecast');

seedTaxonomy();

const flat = (amount) => Array(12).fill(amount);
const empty = () => Array(12).fill(0);

// --- classification ---------------------------------------------------------

test('a steady monthly cost is recurring', () => {
  assert.equal(classify(flat(2900)), 'recurring');
});

test('a cost landing in one month is a one-off', () => {
  const april = empty();
  april[3] = 8042;
  assert.equal(classify(april), 'one_off');
});

test('a concentrated but repeating cost is seasonal', () => {
  // Travel: real months, heavily summer-weighted, but present across the year.
  assert.equal(classify([200, 150, 400, 300, 500, 1200, 1800, 900, 300, 200, 150, 100]), 'seasonal');
});

test('a category with no history has no method', () => {
  assert.equal(classify(empty()), 'none');
});

// --- the one-off case -------------------------------------------------------

test('a one-off already paid this year forecasts nothing more', () => {
  // The tax case. Run-rate would project another ~$4,000 by December.
  const april = empty();
  april[3] = 8042;
  const paid = empty();
  paid[3] = 8042;

  assert.equal(remaining('one_off', paid, april, 7), 0, 'it has been paid');
});

test('a one-off whose month has passed unpaid forecasts nothing', () => {
  const april = empty();
  april[3] = 8042;

  assert.equal(remaining('one_off', empty(), april, 7), 0, 'April came and went');
});

test('a one-off still to come forecasts the whole amount', () => {
  const december = empty();
  december[11] = 3000;

  assert.equal(remaining('one_off', empty(), december, 7), 3000);
});

// --- the other methods ------------------------------------------------------

test('recurring projects this year rate across the remaining months', () => {
  // Last year 1,000/mo; this year running at 1,200. The rise should carry.
  const thisYear = empty();
  for (let i = 0; i < 7; i += 1) thisYear[i] = 1200;

  assert.equal(remaining('recurring', thisYear, flat(1000), 7), 6000, '1,200 x 5 remaining months');
});

test('trailing three months notices a recent change', () => {
  // Quiet start, then three months at 900. A year-to-date average would say
  // ~490/mo; the last three months say 900.
  const thisYear = [200, 200, 200, 200, 900, 900, 900, 0, 0, 0, 0, 0];

  assert.equal(remaining('trailing_3', thisYear, flat(400), 7), 4500, '900 x 5');
});

test('seasonal follows the remaining shape', () => {
  // Half the year budgeted into December.
  const ref = empty();
  ref[5] = 1000;
  ref[11] = 1000;
  const thisYear = empty();
  thisYear[5] = 1000; // June happened, on plan

  // December is still to come, and this year is tracking last year exactly.
  assert.equal(Math.round(remaining('seasonal', thisYear, ref, 7)), 1000);
});

test('a finished year forecasts nothing more', () => {
  assert.equal(remaining('recurring', flat(1000), flat(1000), 12), 0);
});

// --- the whole report -------------------------------------------------------

test('an override beats the classification', () => {
  const groceries = db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get().id;
  db.prepare("UPDATE categories SET forecast_method = 'one_off' WHERE id = ?").run(groceries);

  const row = forecast({ year: 2026 }).categories.find((c) => c.name === 'Groceries');
  db.prepare('UPDATE categories SET forecast_method = NULL WHERE id = ?').run(groceries);

  if (row) {
    assert.equal(row.method, 'one_off');
    assert.equal(row.method_is_override, true);
  }
});

test('totals agree with the categories they came from', () => {
  const f = forecast({ year: 2026 });
  const summed = f.categories.reduce((s, c) => s + c.forecast_year_end, 0);
  assert.ok(Math.abs(summed - f.forecast_year_end) < 1);
  assert.equal(f.months_elapsed + f.months_remaining, 12);
});

test('transfers and contributions are never forecast', () => {
  // counts_as_spending = 0 categories are not budget lines, so projecting them
  // would inflate the year-end figure with money that only moved.
  const f = forecast({ year: 2026 });
  assert.equal(f.categories.find((c) => c.name === 'Credit Card Payment'), undefined);
  assert.equal(f.categories.find((c) => c.name === 'Internal Transfer'), undefined);
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
