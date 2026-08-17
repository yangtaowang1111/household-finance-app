// The categorizer's rule path costs nothing and runs before any API call, so
// it can be tested for real — no API key, no network. That matters because
// every rule that fails to match is a paid Claude call on the next sync.
//
// The AI path itself is still untested (it needs a live key); see
// docs/project-status.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hfa-cat-')), 'test.db');
process.env.DB_PATH = DB_FILE;

const db = require('../src/db');
const { seedCategories } = require('../src/db/seed');
const {
  categorizeUncategorized,
  findRuleMatch,
  rulePatternFor,
  parseResults,
} = require('../src/services/categorizer');

seedCategories();

const categoryId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

let accountId;

test.beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM categorization_rules; DELETE FROM account_balance_snapshots; DELETE FROM accounts;');
  accountId = db
    .prepare(
      `INSERT INTO accounts (name, type, current_balance, source) VALUES ('Card', 'credit', 0, 'simplefin')`
    )
    .run().lastInsertRowid;
});

test.after(() => {
  db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

function addTransaction({ merchant_raw, payee = null }) {
  return db
    .prepare(
      `INSERT INTO transactions (account_id, date, amount, merchant_raw, payee, source, simplefin_id)
       VALUES (?, '2026-08-10', -9.99, ?, ?, 'simplefin', ?)`
    )
    .run(accountId, merchant_raw, payee, `TRN-${Math.random().toString(16).slice(2)}`).lastInsertRowid;
}

test('a rule is learned from the payee, not the store-numbered descriptor', () => {
  assert.equal(rulePatternFor({ payee: "McDonald's", merchant_raw: 'McDonalds 21389' }), "McDonald's");
});

test('rows without a payee still learn from the raw descriptor', () => {
  // CSV-imported and hand-entered rows have no payee.
  assert.equal(rulePatternFor({ payee: null, merchant_raw: 'CORNER STORE' }), 'CORNER STORE');
});

test('a payee-derived rule matches a different store of the same chain', () => {
  // The point of the change: a rule learned as "Chick-fil-A" has to match the
  // next visit, whose descriptor carries a different store number.
  const rules = [{ merchant_pattern: 'Chick-fil-A', category_id: 1 }];

  assert.ok(findRuleMatch(rules, { payee: 'Chick-fil-A', merchant_raw: 'CHICK-FIL-A #02479' }));
  assert.ok(
    findRuleMatch(rules, { payee: 'Chick-fil-A', merchant_raw: 'CHICK-FIL-A #01123' }),
    'a different branch of the same chain still matches'
  );
});

test('a rule matches on the descriptor when the payee does not contain it', () => {
  // A rule learned from a CSV row (descriptor only) must keep working once the
  // same merchant starts arriving from SimpleFIN with a cleaned-up payee.
  const rules = [{ merchant_pattern: 'TST*THE LITTLE DINER', category_id: 1 }];
  assert.ok(findRuleMatch(rules, { payee: 'The Little Diner', merchant_raw: 'TST*THE LITTLE DINER' }));
});

test('a transaction with no merchant text matches nothing rather than throwing', () => {
  assert.equal(findRuleMatch([{ merchant_pattern: 'x', category_id: 1 }], { payee: null, merchant_raw: null }), null);
});

test('rule-matched transactions are categorized without any API call', async () => {
  // No ANTHROPIC_API_KEY is set in this process. If the rule path failed to
  // match, categorizeUncategorized would attempt a Claude request and throw —
  // so this passing is itself the proof that no API call was needed.
  db.prepare('INSERT INTO categorization_rules (merchant_pattern, category_id) VALUES (?, ?)').run(
    "McDonald's",
    categoryId('Dining Out')
  );

  const id1 = addTransaction({ merchant_raw: 'McDonalds 21389', payee: "McDonald's" });
  const id2 = addTransaction({ merchant_raw: 'MCDONALDS 44012', payee: "McDonald's" });

  const counts = await categorizeUncategorized();

  assert.equal(counts.ruleMatched, 2);
  assert.equal(counts.aiCategorized, 0);
  for (const id of [id1, id2]) {
    const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id);
    assert.equal(row.category_id, categoryId('Dining Out'));
  }
});

test('a negative limit does not become an unbounded query', async () => {
  // SQLite reads LIMIT -1 as "no limit"; the cap exists to bound Claude spend.
  db.prepare('INSERT INTO categorization_rules (merchant_pattern, category_id) VALUES (?, ?)').run(
    'CORNER STORE',
    categoryId('Groceries')
  );
  addTransaction({ merchant_raw: 'CORNER STORE' });

  const counts = await categorizeUncategorized(-1);
  assert.equal(counts.ruleMatched, 1, 'still runs, just bounded');
});

// --- response parsing --------------------------------------------------------
//
// The 2026-08-17 run truncated mid-object and lost the whole batch with it,
// twice. These pin the salvage.

test('reads a well-formed response', () => {
  const r = parseResults('[{"id":1,"category_name":"Food","confidence":"high"}]');
  assert.equal(r.length, 1);
  assert.equal(r[0].category_name, 'Food');
});

test('salvages the complete answers from a truncated response', () => {
  // Exactly the shape the real failure took: valid entries, then a cut.
  const truncated =
    '[{"id":1,"category_name":"Food","confidence":"high"},' +
    '{"id":2,"category_name":"Golf","confidence":"medium"},' +
    '{"id":3';
  const r = parseResults(truncated);
  assert.equal(r.length, 2, 'the two finished answers are still good');
  assert.deepEqual(r.map((x) => x.id), [1, 2]);
});

test('an entry missing its category is not salvaged', () => {
  const r = parseResults('[{"id":1,"category_name":"Food","confidence":"high"},{"id":2}]');
  assert.equal(r.length, 1, 'an id alone says nothing about where it belongs');
});

test('nothing usable returns null rather than an empty success', () => {
  assert.equal(parseResults('I could not categorize these.'), null);
  assert.equal(parseResults(''), null);
});

test('prose wrapped around the array does not defeat parsing', () => {
  const r = parseResults('Here you go:\n[{"id":7,"category_name":"Shopping","confidence":"low"}]');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 7);
});
