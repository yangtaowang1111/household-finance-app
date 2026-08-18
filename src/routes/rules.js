const express = require('express');
const db = require('../db');

const router = express.Router();

// The learned rules, which run ahead of the categoriser on every import.
//
// This list exists because a bad rule is worse than a bad transaction: it is
// silent, and it repeats. "Automatic Payment" matches card payments from any
// bank; a rule learned from an incoming Zelle would once have matched all 77 of
// them. Neither was visible anywhere until this page.
//
// Match counts are deliberately not computed here. Doing it would mean a LIKE
// join across ~300 rules and 2,500 transactions on every page load, to answer a
// question only asked about one rule at a time — GET /api/transactions/matching
// already answers that on demand.
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.merchant_pattern, r.category_id, r.always_review, r.reviewed, r.created_at,
              c.name AS category_name,
              COALESCE(parent.name, c.name) AS category_group
       FROM categorization_rules r
       JOIN categories c ON c.id = r.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       ORDER BY LENGTH(r.merchant_pattern) ASC, r.merchant_pattern`
    )
    .all();

  // Shortest patterns first: a short pattern is the one most likely to catch
  // more than it should, so the riskiest rules are the ones you see first.
  res.json(rows);
});

router.patch('/:id', (req, res) => {
  const { category_id, always_review, merchant_pattern, reviewed } = req.body || {};
  const rule = db.prepare('SELECT * FROM categorization_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });

  const sets = [];
  const params = {};
  if (category_id !== undefined) {
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) {
      return res.status(400).json({ error: 'category_id does not exist' });
    }
    sets.push('category_id = @category_id');
    params.category_id = category_id;
  }
  if (always_review !== undefined) {
    sets.push('always_review = @always_review');
    params.always_review = always_review ? 1 : 0;
  }
  if (reviewed !== undefined) {
    sets.push('reviewed = @reviewed');
    params.reviewed = reviewed ? 1 : 0;
  }
  if (merchant_pattern !== undefined) {
    const pattern = String(merchant_pattern).trim();
    if (pattern.length < 4) return res.status(400).json({ error: 'pattern must be at least 4 characters' });
    sets.push('merchant_pattern = @merchant_pattern');
    params.merchant_pattern = pattern;
    // A changed pattern is a different rule, so a previous acceptance no longer
    // applies to it.
    if (reviewed === undefined && pattern !== rule.merchant_pattern) {
      sets.push('reviewed = 0');
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

  try {
    db.prepare(`UPDATE categorization_rules SET ${sets.join(', ')} WHERE id = @id`).run({ ...params, id: req.params.id });
  } catch (err) {
    // merchant_pattern is UNIQUE, so an edit can collide with an existing rule.
    return res.status(409).json({ error: `another rule already uses that pattern` });
  }
  res.json(db.prepare('SELECT * FROM categorization_rules WHERE id = ?').get(req.params.id));
});

// Deleting a rule leaves the transactions it already filed alone. Those were
// real decisions at the time, and silently unfiling them would be a much bigger
// action than the one asked for.
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM categorization_rules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'rule not found' });
  res.status(204).end();
});

module.exports = router;
