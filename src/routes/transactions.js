const express = require('express');
const db = require('../db');
const { rulePatternFor } = require('../services/categorizer');

const router = express.Router();

router.get('/', (req, res) => {
  const { account_id, category_id, month, pending, possible_duplicates } = req.query;
  const clauses = [];
  const params = [];

  if (account_id) {
    clauses.push('t.account_id = ?');
    params.push(account_id);
  }
  if (category_id) {
    clauses.push('t.category_id = ?');
    params.push(category_id);
  }
  if (month) {
    clauses.push("strftime('%Y-%m', t.date) = ?");
    params.push(month);
  }
  if (pending !== undefined) {
    clauses.push('t.pending = ?');
    params.push(pending === '0' || pending === 'false' ? 0 : 1);
  }
  // The review queue for rows the sync flagged as duplicating something entered
  // by hand or imported from a CSV. Nothing acts on the flag automatically, so
  // there has to be a way to list them.
  if (possible_duplicates !== undefined && possible_duplicates !== '0' && possible_duplicates !== 'false') {
    clauses.push('t.possible_duplicate_of IS NOT NULL');
  }

  // Filters the dashboard drills down with. `group` matches a top-level group by
  // name, catching every child under it — the Overview's spending breakdown is
  // by group, so clicking "Food" has to reach Groceries, Dining Out and Coffee
  // rather than only rows filed on the group itself.
  const { group, uncategorized, needs_review, min_amount, search } = req.query;

  if (group) {
    clauses.push('COALESCE(parent.name, c.name) = ?');
    params.push(group);
  }
  if (uncategorized !== undefined && uncategorized !== '0' && uncategorized !== 'false') {
    clauses.push('t.category_id IS NULL');
  }
  if (needs_review !== undefined && needs_review !== '0' && needs_review !== 'false') {
    clauses.push("t.notes LIKE 'AI confidence: low%'");
  }
  if (min_amount) {
    // On absolute value: "everything over $1,000" means large in either
    // direction, and the large inbound rows (a $78,299 equity event) are exactly
    // the ones worth finding.
    clauses.push('ABS(t.amount) >= ?');
    params.push(Number(min_amount));
  }
  if (search) {
    clauses.push('(LOWER(COALESCE(t.merchant_raw, \'\')) LIKE ? OR LOWER(COALESCE(t.payee, \'\')) LIKE ?)');
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Clamped at both ends: SQLite reads a negative LIMIT as "no limit", so
  // ?limit=-1 would otherwise return all 2,500+ rows to a caller asking for a
  // short list. The default is generous but finite.
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 500, 2000));

  // Joined rather than left to the caller: every consumer of this list needs the
  // account and category names, and resolving them client-side means three
  // requests and a join in the browser for what SQLite does here for free.
  const rows = db
    .prepare(
      `SELECT t.*,
              a.name AS account_name,
              a.nickname AS account_nickname,
              c.name AS category_name,
              COALESCE(parent.name, c.name) AS category_group
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       ${where}
       ORDER BY t.date DESC, t.id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  res.json(rows);
});

// Manual transaction entry — cash spending, or anything else SimpleFIN
// can't reach. `source` is always 'manual' here; SimpleFIN-sourced and
// CSV-imported transactions come in through their own pipelines.
router.post('/', (req, res) => {
  const { account_id, date, amount, merchant_raw, category_id, notes } = req.body;
  if (!account_id || !date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'account_id, date, and amount are required' });
  }
  if (isNaN(Number(amount))) {
    return res.status(400).json({ error: 'amount must be a number' });
  }

  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!account) return res.status(400).json({ error: 'account_id does not reference an existing account' });

  const result = db.prepare(`
    INSERT INTO transactions (account_id, date, amount, merchant_raw, category_id, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, 'manual')
  `).run(account_id, date, Number(amount), merchant_raw || null, category_id || null, notes || null);

  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid));
});

// Resolving a flagged duplicate means deleting one of the two rows, which is
// what `possible_duplicate_of`'s ON DELETE SET NULL was added for. Without this
// route the documented cleanup needs raw SQL on the NAS.
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'transaction not found' });
  res.status(204).end();
});

// Registered BEFORE /:id/category on purpose. Express matches in order, so
// with the parameterised route first a PATCH to /bulk/category binds id="bulk"
// and 404s on a transaction that does not exist.
// Applies one category to many transactions at once. 180 Food transactions is
// too many to fix one at a time, and a systematic mistake is exactly the kind
// that spans dozens of rows.
router.patch('/bulk/category', (req, res) => {
  const { ids, category_id } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids (array) is required' });
  if (!category_id) return res.status(400).json({ error: 'category_id is required' });
  if (ids.length > 1000) return res.status(400).json({ error: 'at most 1000 at a time' });

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
  if (!category) return res.status(400).json({ error: 'category_id does not exist' });

  const update = db.prepare(
    "UPDATE transactions SET category_id = ?, categorized_by = 'manual' WHERE id = ?"
  );
  const updated = db.transaction(() => ids.reduce((n, id) => n + update.run(category_id, id).changes, 0))();

  res.json({ updated });
});

// Correcting a category by hand.
//
// `learn_rule` is the interesting half. Correcting one row and stopping there
// means the same merchant arrives wrong again next month; always writing a rule
// is equally wrong, because one odd correction (a Target run that was really a
// gift) would then misfile every future transaction from that merchant. So the
// caller decides, per correction.
//
// A manual correction also clears the low-confidence note. That note is a
// request for a human to look, and a human just looked.
router.patch('/:id/category', (req, res) => {
  const { category_id, learn_rule = false, notes } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id is required' });

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!txn) return res.status(404).json({ error: 'transaction not found' });

  const category = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(category_id);
  if (!category) return res.status(400).json({ error: 'category_id does not exist' });

  const clearsReviewNote = /^AI confidence: low/.test(txn.notes || '');
  const nextNotes = notes !== undefined ? notes : clearsReviewNote ? null : txn.notes;

  let rule = null;
  const result = db.transaction(() => {
    db.prepare(
      "UPDATE transactions SET category_id = ?, notes = ?, categorized_by = 'manual' WHERE id = ?"
    ).run(category_id, nextNotes, req.params.id);

    if (learn_rule) {
      // Same pattern source the categorizer learns from: the cleaned payee when
      // there is one, else the raw descriptor. A pattern shorter than four
      // characters would match half the ledger.
      const pattern = rulePatternFor(txn);
      if (pattern && pattern.length >= 4) {
        db.prepare(
          `INSERT INTO categorization_rules (merchant_pattern, category_id)
           VALUES (?, ?)
           ON CONFLICT(merchant_pattern) DO UPDATE SET category_id = excluded.category_id`
        ).run(pattern, category_id);
        rule = { merchant_pattern: pattern, category_id, category_name: category.name };
      }
    }
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  })();

  // `rule` is echoed so the UI can say what it just taught, and offer to undo
  // it — a rule created by accident is otherwise invisible until it misfiles
  // something months later.
  res.json({ ...result, rule_learned: rule });
});

// Everything a given rule would catch. Answers "what else does this affect?"
// before a rule is created or deleted — with 296 rules already, one bad pattern
// is worth more than one bad row.
router.get('/matching', (req, res) => {
  const { pattern } = req.query;
  if (!pattern || pattern.length < 3) {
    return res.status(400).json({ error: 'pattern is required, at least 3 characters' });
  }
  const like = `%${pattern.toLowerCase()}%`;
  res.json(
    db
      .prepare(
        `SELECT t.id, t.date, t.amount, t.merchant_raw, t.payee, c.name AS category_name
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE LOWER(COALESCE(t.payee, '')) LIKE ? OR LOWER(COALESCE(t.merchant_raw, '')) LIKE ?
         ORDER BY t.date DESC LIMIT 100`
      )
      .all(like, like)
  );
});

module.exports = router;
