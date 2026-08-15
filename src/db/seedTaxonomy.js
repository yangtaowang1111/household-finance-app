// Seeds the two-level category taxonomy from taxonomy.js.
//
// Idempotent: safe to run on every boot. Groups are inserted first so children
// can point at them, and everything upserts on `name` rather than inserting
// blindly.
//
// Replacing the original flat 21 categories is the interesting part. Those 21
// were seeded in Phase 1 and 119 SimpleFIN transactions are categorised against
// them. Rather than guess a mapping for the ambiguous ones ("Utilities" could be
// electricity, gas, or internet; "Transportation" could be fuel, insurance, or
// registration), those transactions are reset to uncategorised so the
// categoriser can redo them against the new taxonomy — which by then has rules
// learned from a year of the household's own decisions, so it costs almost
// nothing and lands better than any remap would.

const db = require('./index');
const { flatten, GROUPS } = require('./taxonomy');

// The Phase 1 flat categories. Any transaction pointing at one of these gets
// reset; any of these left unused afterwards is deleted.
const LEGACY_CATEGORIES = [
  'Retirement Contributions', 'Investment Contributions', 'College Fund Contributions',
  'Emergency Fund Contributions', 'Housing', 'Utilities', 'Groceries', 'Dining Out',
  'Transportation', 'Insurance', 'Healthcare', 'Subscriptions', 'Entertainment',
  'Shopping', 'Personal Care', 'Travel', 'Kids', 'Gifts & Donations', 'Income',
  'Transfers', 'Uncategorized',
];

// Names the new taxonomy reuses verbatim — those rows are updated in place
// rather than reset, since the meaning is unchanged.
const PRESERVED = new Set(
  flatten().map((c) => c.name).filter((n) => LEGACY_CATEGORIES.includes(n))
);

/**
 * Creates or updates every group and child. Returns what changed.
 * @returns {{groupsCreated:number, childrenCreated:number, updated:number, transactionsReset:number, legacyRemoved:number}}
 */
function seedTaxonomy({ log = false } = {}) {
  const rows = flatten();

  const selectByName = db.prepare('SELECT id, parent_category_id, bucket, counts_as_spending FROM categories WHERE name = ?');
  const insert = db.prepare(`
    INSERT INTO categories (name, bucket, parent_category_id, counts_as_spending)
    VALUES (@name, @bucket, @parent_category_id, @counts_as_spending)
  `);
  const update = db.prepare(`
    UPDATE categories
    SET bucket = @bucket, parent_category_id = @parent_category_id, counts_as_spending = @counts_as_spending
    WHERE id = @id
  `);

  const result = { groupsCreated: 0, childrenCreated: 0, updated: 0, transactionsReset: 0, legacyRemoved: 0 };

  const run = db.transaction(() => {
    // Pass 1: groups, so children have a parent to reference.
    const groupIds = new Map();
    for (const row of rows.filter((r) => r.isGroup)) {
      const payload = {
        name: row.name,
        bucket: row.bucket,
        parent_category_id: null,
        counts_as_spending: row.countsAsSpending ? 1 : 0,
      };
      const existing = selectByName.get(row.name);
      if (existing) {
        update.run({ ...payload, id: existing.id });
        groupIds.set(row.name, existing.id);
        result.updated += 1;
      } else {
        groupIds.set(row.name, insert.run(payload).lastInsertRowid);
        result.groupsCreated += 1;
      }
    }

    // Pass 2: children.
    for (const row of rows.filter((r) => !r.isGroup)) {
      const payload = {
        name: row.name,
        bucket: row.bucket,
        parent_category_id: groupIds.get(row.group),
        counts_as_spending: row.countsAsSpending ? 1 : 0,
      };
      const existing = selectByName.get(row.name);
      if (existing) {
        update.run({ ...payload, id: existing.id });
        result.updated += 1;
      } else {
        insert.run(payload);
        result.childrenCreated += 1;
      }
    }

    // Retire the legacy flat categories the new taxonomy doesn't reuse.
    const stale = LEGACY_CATEGORIES.filter((n) => !PRESERVED.has(n));
    for (const name of stale) {
      const row = selectByName.get(name);
      if (!row) continue;

      // Only a top-level legacy row is stale; if the new taxonomy adopted this
      // id as a group or child it will have a parent or children by now.
      const isAdopted = rows.some((r) => r.name === name);
      if (isAdopted) continue;

      const reset = db
        .prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?')
        .run(row.id);
      result.transactionsReset += reset.changes;

      db.prepare('DELETE FROM categorization_rules WHERE category_id = ?').run(row.id);
      db.prepare('DELETE FROM budgets WHERE category_id = ?').run(row.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(row.id);
      result.legacyRemoved += 1;
    }
  });

  run();

  if (log) {
    console.log(
      `Taxonomy: ${GROUPS.length} groups, ${rows.length - GROUPS.length} children ` +
        `(+${result.groupsCreated} groups, +${result.childrenCreated} children, ${result.updated} updated)`
    );
    if (result.legacyRemoved) {
      console.log(
        `  retired ${result.legacyRemoved} legacy flat categories; ` +
          `${result.transactionsReset} transactions reset for re-categorization`
      );
    }
  }

  return result;
}

if (require.main === module) {
  seedTaxonomy({ log: true });
}

module.exports = { seedTaxonomy, LEGACY_CATEGORIES };
