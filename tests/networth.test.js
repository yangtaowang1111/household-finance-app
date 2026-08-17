// Net worth history is reconstructed, not stored, for everything before
// 2026-08-15. These tests pin what the reconstruction may and may not claim —
// the failure mode to avoid is a curve that looks authoritative while quietly
// guessing at investment and property values it cannot know.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-nw-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const db = require('../src/db');
const { seedCategories } = require('../src/db/seed');
const { currentNetWorth, netWorthHistory } = require('../src/services/networth');

seedCategories();

function account(name, type, balance) {
  return db
    .prepare('INSERT INTO accounts (name, type, current_balance, source) VALUES (?, ?, ?, ?)')
    .run(name, type, balance, 'manual').lastInsertRowid;
}

function txn(accountId, date, amount) {
  db.prepare(
    `INSERT INTO transactions (account_id, date, amount, merchant_raw, source)
     VALUES (?, ?, ?, 'TEST', 'csv_import')`
  ).run(accountId, date, amount);
}

test.beforeEach(() => {
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM account_balance_snapshots').run();
  db.prepare('DELETE FROM accounts').run();
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- current ----------------------------------------------------------------

test('assets and liabilities are split by type, not by sign', () => {
  account('Checking', 'checking', -250); // overdrawn, but still an asset account
  account('Card', 'credit', 400); // in credit, but still a liability account

  const r = currentNetWorth();
  assert.equal(r.assets, -250, 'an overdrawn current account is not a liability');
  assert.equal(r.liabilities, 400, 'a card in credit is not an asset');
  assert.equal(r.net_worth, 150);
});

test('net worth is assets less liabilities', () => {
  account('Checking', 'checking', 20000);
  account('Vanguard', 'investment', 58991.46);
  account('House', 'property', 781800);
  account('Card', 'credit', -7014.63);
  account('Mortgage', 'mortgage', -284266.53);

  assert.equal(currentNetWorth().net_worth, 569510.3);
});

// --- property equity --------------------------------------------------------

test('a property pairs with the loan secured against it', () => {
  const house = account('Primary Home', 'property', 781800);
  const loan = account('Mortgage - 1308', 'mortgage', -284266.53);
  db.prepare('UPDATE accounts SET secured_by_account_id = ? WHERE id = ?').run(house, loan);

  const [property] = currentNetWorth().properties;
  assert.equal(property.value, 781800);
  assert.equal(property.mortgage, -284266.53);
  assert.equal(property.equity, 497533.47, 'equity is value plus the negative loan');
});

test('an unlinked property reports no equity rather than full equity', () => {
  account('Rental', 'property', 592500);

  const [property] = currentNetWorth().properties;
  assert.equal(property.value, 592500);
  assert.equal(property.mortgage, null);
  assert.equal(property.equity, null, '"no mortgage recorded" must not read as "owned outright"');
});

test('two loans against one property both count', () => {
  const house = account('Primary Home', 'property', 800000);
  const first = account('First Mortgage', 'mortgage', -300000);
  const second = account('HELOC', 'loan', -50000);
  db.prepare('UPDATE accounts SET secured_by_account_id = ? WHERE id IN (?, ?)').run(house, first, second);

  const [property] = currentNetWorth().properties;
  assert.equal(property.equity, 450000);
  assert.equal(property.mortgage_accounts.length, 2);
});

// --- history ----------------------------------------------------------------

test('a past balance is rebuilt by undoing what happened since', () => {
  const checking = account('Checking', 'checking', 10000);
  txn(checking, '2026-01-15', -1000);
  txn(checking, '2026-01-20', 3000);

  const { series } = netWorthHistory({ from: '2026-01-10', to: '2026-01-25' });
  const on = (d) => series.find((s) => s.date === d).net_worth;

  // Each point is the balance at the END of that day, so a day's own
  // transactions are already in it.
  assert.equal(on('2026-01-25'), 10000, 'today is today');
  assert.equal(on('2026-01-20'), 10000, 'the +3000 landed on the 20th');
  assert.equal(on('2026-01-16'), 7000, 'after the -1000, before the +3000');
  assert.equal(on('2026-01-15'), 7000, 'the -1000 landed on the 15th');
  assert.equal(on('2026-01-14'), 8000, 'before either');
});

test('credit card movement lands on the liability side', () => {
  const card = account('Card', 'credit', -500);
  txn(card, '2026-01-15', -200); // a purchase, increasing debt

  const { series } = netWorthHistory({ from: '2026-01-10', to: '2026-01-20' });
  const before = series.find((s) => s.date === '2026-01-14');

  assert.equal(before.liabilities, 300, 'debt was smaller before the purchase');
  assert.equal(before.net_worth, -300);
});

test('investment balances are held flat, never rebuilt from transactions', () => {
  const vanguard = account('Vanguard', 'investment', 58991.46);
  // A brokerage's own rows explain nothing about its value — market movement
  // has no transaction behind it. Rebuilding from these would be fiction.
  txn(vanguard, '2026-01-15', -30000);

  const { series, held_flat } = netWorthHistory({ from: '2026-01-10', to: '2026-01-20' });
  assert.ok(held_flat.includes('investment'));
  assert.equal(series[0].net_worth, 58991.46, 'flat across the whole reconstructed span');
  assert.equal(series[series.length - 1].net_worth, 58991.46);
});

test('property values are held flat — there is no revaluation history', () => {
  account('House', 'property', 781800);

  const { series } = netWorthHistory({ from: '2026-01-01', to: '2026-06-01' });
  const distinct = new Set(series.map((s) => s.net_worth));
  assert.equal(distinct.size, 1, 'one valuation means one value, not a trend');
});

test('points before the first snapshot are marked reconstructed', () => {
  const checking = account('Checking', 'checking', 1000);
  db.prepare("INSERT INTO account_balance_snapshots (account_id, balance, recorded_at) VALUES (?, ?, '2026-01-15 10:00:00')")
    .run(checking, 1000);

  const { series, reconstructed_before } = netWorthHistory({ from: '2026-01-10', to: '2026-01-20' });
  assert.equal(reconstructed_before, '2026-01-15');
  assert.equal(series.find((s) => s.date === '2026-01-14').reconstructed, true);
  assert.equal(series.find((s) => s.date === '2026-01-16').reconstructed, false);
});

test('with no snapshots at all, every point admits it is reconstructed', () => {
  account('Checking', 'checking', 1000);
  const { series } = netWorthHistory({ from: '2026-01-10', to: '2026-01-12' });
  assert.ok(series.every((s) => s.reconstructed));
});

test('the series runs oldest to newest and covers every day', () => {
  account('Checking', 'checking', 1000);
  const { series } = netWorthHistory({ from: '2026-03-01', to: '2026-03-31' });

  assert.equal(series.length, 31);
  assert.equal(series[0].date, '2026-03-01');
  assert.equal(series[30].date, '2026-03-31');
});

test('the reported change matches the ends of the series', () => {
  const checking = account('Checking', 'checking', 10000);
  txn(checking, '2026-02-15', 2500);

  const r = netWorthHistory({ from: '2026-02-01', to: '2026-02-28' });
  assert.equal(r.opening, 7500);
  assert.equal(r.closing, 10000);
  assert.equal(r.change, 2500);
});
