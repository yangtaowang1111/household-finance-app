// The correction endpoint, which is the one place a human overrides the
// categoriser. Two things it must get right: a correction that teaches a rule
// changes every future transaction from that merchant, and one that doesn't
// must leave the rule set alone.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-routes-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.API_KEY = 'test-key';

const db = require('../src/db');
const { seedTaxonomy } = require('../src/db/seedTaxonomy');

seedTaxonomy();

const app = require('../src/server');
const PORT = 31999;
let server;

const categoryId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

let accountId;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(PORT, resolve); });
});

test.beforeEach(() => {
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM categorization_rules').run();
  db.prepare('DELETE FROM accounts').run();
  accountId = db
    .prepare("INSERT INTO accounts (name, type, current_balance, source) VALUES ('Card', 'credit', 0, 'manual')")
    .run().lastInsertRowid;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function txn(fields = {}) {
  const { merchant = 'PGA TOUR SUPERSTORE', payee = null, notes = null, category = null, review = 0 } = fields;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, date, amount, merchant_raw, payee, notes, category_id, needs_review, source)
       VALUES (?, '2026-02-10', -53.61, ?, ?, ?, ?, ?, 'simplefin')`
    )
    .run(accountId, merchant, payee, notes, category ? categoryId(category) : null, review).lastInsertRowid;
}

test('a correction without learn_rule leaves the rule set alone', async () => {
  const id = txn({ category: 'Shopping' });
  const r = await call('PATCH', `/api/transactions/${id}/category`, { category_id: categoryId('Golf Gear') });

  assert.equal(r.status, 200);
  assert.equal(r.body.category_id, categoryId('Golf Gear'));
  assert.equal(r.body.categorized_by, 'manual');
  assert.equal(r.body.rule_learned, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM categorization_rules').get().n, 0);
});

test('a correction with learn_rule writes one, and says which', async () => {
  const id = txn({ payee: 'PGA Tour Superstore' });
  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Golf Gear'),
    learn_rule: true,
  });

  assert.equal(r.body.rule_learned.merchant_pattern, 'PGA Tour Superstore', 'the payee generalises better than the descriptor');
  const rule = db.prepare('SELECT * FROM categorization_rules').get();
  assert.equal(rule.category_id, categoryId('Golf Gear'));
});

test('correcting the same merchant again replaces the rule rather than duplicating it', async () => {
  const first = txn({ payee: 'PGA Tour Superstore' });
  await call('PATCH', `/api/transactions/${first}/category`, { category_id: categoryId('Golf Gear'), learn_rule: true });

  const second = txn({ payee: 'PGA Tour Superstore' });
  await call('PATCH', `/api/transactions/${second}/category`, { category_id: categoryId('Shopping'), learn_rule: true });

  const rules = db.prepare('SELECT * FROM categorization_rules').all();
  assert.equal(rules.length, 1, 'merchant_pattern is UNIQUE — the newer answer wins');
  assert.equal(rules[0].category_id, categoryId('Shopping'));
});

test('a manual correction clears the review flag', async () => {
  const id = txn({ review: 1, category: 'Shopping' });
  const r = await call('PATCH', `/api/transactions/${id}/category`, { category_id: categoryId('Golf Gear') });

  assert.equal(r.body.needs_review, 0, 'the flag asked a human to look, and one just did');
});

test('a note the user wrote is not clobbered by a correction', async () => {
  const id = txn({ notes: 'Birthday present for Dad', category: 'Shopping' });
  const r = await call('PATCH', `/api/transactions/${id}/category`, { category_id: categoryId('Gifts') });

  assert.equal(r.body.notes, 'Birthday present for Dad');
});

test('a correction can set a note explicitly', async () => {
  const id = txn({});
  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Green Fees'),
    notes: 'Sunday round with Dave',
  });
  assert.equal(r.body.notes, 'Sunday round with Dave');
});

test('an unknown category is refused rather than stored', async () => {
  const id = txn({});
  const r = await call('PATCH', `/api/transactions/${id}/category`, { category_id: 999999 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not exist/);
});

test('bulk correction reaches its own route, not /:id/category', async () => {
  // Registration order matters: with /:id/category first, this binds id="bulk".
  const a = txn({});
  const b = txn({});
  const r = await call('PATCH', '/api/transactions/bulk/category', {
    ids: [a, b],
    category_id: categoryId('Green Fees'),
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.updated, 2);
  const rows = db.prepare('SELECT category_id, categorized_by FROM transactions').all();
  assert.ok(rows.every((t) => t.category_id === categoryId('Green Fees') && t.categorized_by === 'manual'));
});

test('bulk correction refuses an unreasonable batch', async () => {
  const r = await call('PATCH', '/api/transactions/bulk/category', {
    ids: Array.from({ length: 1001 }, (_, i) => i + 1),
    category_id: categoryId('Groceries'),
  });
  assert.equal(r.status, 400);
});

test('the matching preview shows what a pattern would catch', async () => {
  txn({ merchant: 'PGA TOUR SUPERSTORE 06' });
  txn({ merchant: 'WHOLE FOODS MARKET' });

  const r = await call('GET', '/api/transactions/matching?pattern=PGA');
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].merchant_raw, /PGA/);
});

test('the list joins account and category names and honours limit', async () => {
  txn({ category: 'Groceries' });
  txn({});
  const r = await call('GET', '/api/transactions?limit=1');

  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].account_name, 'Card');
});

// --- filters ----------------------------------------------------------------
//
// These are what the Overview drills down with, so a broken one sends you to an
// empty page from a number you just clicked.

test('group filter reaches every child of the group', async () => {
  // The Overview breaks spending down by group, so clicking "Food" must find
  // rows filed under Groceries and Dining Out — not only ones filed on the
  // group itself, which in practice is none of them.
  txn({ merchant: 'WHOLE FOODS', category: 'Groceries' });
  txn({ merchant: 'RESTAURANT', category: 'Dining Out' });
  txn({ merchant: 'PINE VALLEY GC', category: 'Green Fees' });

  const r = await call('GET', '/api/transactions?group=Food');
  assert.equal(r.body.length, 2);
  assert.deepEqual(
    r.body.map((t) => t.category_name).sort(),
    ['Dining Out', 'Groceries']
  );
});

test('uncategorized filter finds only unfiled rows', async () => {
  txn({ category: 'Groceries' });
  txn({});

  const r = await call('GET', '/api/transactions?uncategorized=1');
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].category_id, null);
});

test('needs_review filter finds the review queue', async () => {
  txn({ review: 1, category: 'Shopping' });
  txn({ notes: 'Birthday present', category: 'Gifts' });

  const r = await call('GET', '/api/transactions?needs_review=1');
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].needs_review, 1);
});

test('min_amount works on absolute value, so big credits are found too', async () => {
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-02-11', 78299.40, 'SOLIUM INC', 'csv_import')"
  ).run(accountId);
  txn({}); // -53.61

  const r = await call('GET', '/api/transactions?min_amount=1000');
  assert.equal(r.body.length, 1, 'a $78,299 credit is exactly the row worth finding');
  assert.match(r.body[0].merchant_raw, /SOLIUM/);
});

test('search matches the descriptor case-insensitively', async () => {
  txn({ merchant: 'WHOLE FOODS MARKET' });
  txn({ merchant: 'SHELL OIL' });

  const r = await call('GET', '/api/transactions?search=whole foods');
  assert.equal(r.body.length, 1);
});

test('filters combine rather than replace each other', async () => {
  txn({ merchant: 'WHOLE FOODS MARKET', category: 'Groceries' });
  txn({ merchant: 'WHOLE FOODS MARKET' });

  const r = await call('GET', '/api/transactions?search=whole&uncategorized=1');
  assert.equal(r.body.length, 1, 'both conditions apply, not the last one');
  assert.equal(r.body[0].category_id, null);
});

// --- rules that a person shapes ---------------------------------------------

test('an explicit rule pattern beats the derived one', async () => {
  // The derived pattern carries the per-transaction reference, so a rule built
  // from it matches exactly one row and never fires again. Only a person knows
  // the part worth keeping is the name.
  const id = txn({ merchant: 'Zelle payment from XINPEI FU 30139262629', payee: 'Zelle Transfer' });

  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Rental Income'),
    learn_rule: true,
    rule_pattern: 'Zelle payment from XINPEI FU',
  });

  assert.equal(r.body.rule_learned.merchant_pattern, 'Zelle payment from XINPEI FU');
});

test('a generic payee is not used as a rule pattern', async () => {
  // SimpleFIN reduces an incoming Chase Zelle to payee "Zelle Transfer". A rule
  // on that string would swallow every Zelle transaction in the ledger.
  const id = txn({ merchant: 'Zelle payment from XINPEI FU 30139262629', payee: 'Zelle Transfer' });

  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Rental Income'),
    learn_rule: true,
  });

  assert.notEqual(r.body.rule_learned.merchant_pattern, 'Zelle Transfer');
  assert.match(r.body.rule_learned.merchant_pattern, /XINPEI FU/);
});

test('a rule can categorise and still ask for review', async () => {
  const id = txn({ merchant: 'Zelle payment to Da Dao 30179022977' });

  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Family Support'),
    learn_rule: true,
    rule_pattern: 'Zelle payment to Da Dao',
    rule_always_review: true,
  });

  assert.equal(r.body.rule_learned.always_review, true);
  const rule = db.prepare('SELECT always_review FROM categorization_rules').get();
  assert.equal(rule.always_review, 1);
});

test('confirming accepts the category and clears the flag', async () => {
  const id = txn({ review: 1, category: 'Groceries' });
  const r = await call('PATCH', `/api/transactions/${id}/confirm`);

  assert.equal(r.body.needs_review, 0);
  assert.equal(r.body.category_id, categoryId('Groceries'), 'the category is untouched');
  assert.equal(r.body.categorized_by, 'manual');
});

test('a pattern too short to be safe is not stored', async () => {
  const id = txn({});
  const r = await call('PATCH', `/api/transactions/${id}/category`, {
    category_id: categoryId('Groceries'),
    learn_rule: true,
    rule_pattern: 'ab',
  });

  assert.equal(r.body.rule_learned, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM categorization_rules').get().n, 0);
});

// --- amount range -----------------------------------------------------------
//
// One minimum and one maximum, either or both, covers every way of asking:
// over, under, between, and exactly.

test('a maximum finds small transactions', async () => {
  txn({ merchant: 'COFFEE' }); // -53.61
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-02-10', -4.00, 'RANGE BALLS', 'simplefin')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?max_amount=10');
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].merchant_raw, /RANGE BALLS/);
});

test('a minimum and maximum together make a range', async () => {
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-02-10', -4.00, 'SMALL', 'simplefin')"
  ).run(accountId);
  txn({ merchant: 'MIDDLE' }); // -53.61
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-02-10', -9000, 'LARGE', 'simplefin')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?min_amount=10&max_amount=100');
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].merchant_raw, /MIDDLE/);
});

test('the same figure in both finds one exact amount', async () => {
  // The mortgage case: two nearly identical descriptors, told apart by amount.
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-07-01', -2237.31, 'US BANK HOME MTG 1176', 'simplefin')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-07-01', -2864.62, 'US BANK HOME MTG 1308', 'simplefin')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?min_amount=2237.31&max_amount=2237.31');
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].merchant_raw, /1176/);
});

test('an exact search survives floating point', async () => {
  // Amounts are REAL. Without rounding on both sides, a stored 2237.3099999
  // would not equal a searched 2237.31.
  db.prepare(
    'INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, ?, ?, ?, ?)'
  ).run(accountId, '2026-07-01', -(2237.30 + 0.01), 'PAYMENT', 'simplefin');

  const r = await call('GET', '/api/transactions?min_amount=2237.31&max_amount=2237.31');
  assert.equal(r.body.length, 1);
});

test('search reaches notes, not only the bank descriptor', async () => {
  txn({ merchant: 'FSP*LEGACY RIDGE', notes: 'green fees, not gear' });
  txn({ merchant: 'PGA TOUR SUPERSTORE' });

  const r = await call('GET', '/api/transactions?search=green fees');
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].merchant_raw, /LEGACY RIDGE/);
});

// --- year and month ---------------------------------------------------------

test('a month with no year spans every year', async () => {
  // The comparison this exists for: the same month against itself across years.
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2025-03-15', -100, 'MARCH 2025', 'csv_import')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-03-15', -100, 'MARCH 2026', 'csv_import')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-04-15', -100, 'APRIL 2026', 'csv_import')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?month=3');
  assert.equal(r.body.length, 2);
  assert.deepEqual(r.body.map((t) => t.date.slice(0, 4)).sort(), ['2025', '2026']);
});

test('a year with no month covers the whole year', async () => {
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-01-15', -100, 'JAN', 'csv_import')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-11-15', -100, 'NOV', 'csv_import')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2025-06-15', -100, 'LAST YEAR', 'csv_import')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?year=2026');
  assert.equal(r.body.length, 2);
  assert.ok(r.body.every((t) => t.date.startsWith('2026')));
});

test('a single-digit month matches a zero-padded date', async () => {
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-03-15', -100, 'MARCH', 'csv_import')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions?year=2026&month=3');
  assert.equal(r.body.length, 1);
});

test('the years list reports only years that have transactions', async () => {
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2026-03-15', -100, 'X', 'csv_import')"
  ).run(accountId);
  db.prepare(
    "INSERT INTO transactions (account_id, date, amount, merchant_raw, source) VALUES (?, '2024-03-15', -100, 'Y', 'csv_import')"
  ).run(accountId);

  const r = await call('GET', '/api/transactions/years');
  assert.deepEqual(r.body, [2026, 2024], 'newest first, and no empty years between');
});
