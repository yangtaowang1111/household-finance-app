// Income / spending / saved for a date range, plus the per-group breakdown.
//
// This is the view the `counts_as_spending` flag exists for. Summing every
// outflow together answers the wrong question: a credit card autopay, a transfer
// to Ally and a Vanguard contribution all leave a chequing account, but none of
// them is consumption. Only the flag separates money that left the household
// from money that merely moved inside it.
//
// Three lines rather than two, because "income minus spending" hides the thing
// most worth watching:
//
//   income   what came in
//   spending what was consumed  (counts_as_spending = 1)
//   saved    what was kept      (contributions — an asset, not an expense)
//
// Transfers appear in neither total. Both legs are real transactions, so they
// cancel; including them would double-count in one direction and cancel to noise
// in the other.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} options
 * @param {string} options.from   inclusive ISO date
 * @param {string} options.to     exclusive ISO date
 */
function cashflow({ from, to }) {
  const byGroup = db
    .prepare(
      `SELECT
         COALESCE(parent.name, c.name) AS group_name,
         MAX(COALESCE(parent.counts_as_spending, c.counts_as_spending)) AS counts_as_spending,
         COUNT(*) AS transactions,
         ROUND(SUM(t.amount), 2) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       WHERE t.date >= ? AND t.date < ?
       GROUP BY group_name
       ORDER BY ABS(SUM(t.amount)) DESC`
    )
    .all(from, to);

  // Income is identified by its group rather than by sign: a refund is a
  // positive amount inside a spending group, and treating every credit as income
  // would inflate it by every return and rebate.
  let income = 0;
  let spending = 0;
  let saved = 0;

  for (const row of byGroup) {
    if (row.group_name === 'Income') income += row.total;
    else if (row.counts_as_spending) spending += -row.total;
    else if (row.group_name === 'Savings & Investments') saved += -row.total;
  }

  const uncategorized = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND date >= ? AND date < ?')
    .get(from, to).n;

  return {
    window: { from, to },
    income: round2(income),
    spending: round2(spending),
    saved: round2(saved),
    net: round2(income - spending - saved),
    savings_rate: income > 0 ? round2((saved / income) * 100) : null,
    // Counted, not silently omitted: a summary built while rows are still
    // uncategorized is incomplete, and the reader should be able to tell.
    uncategorized_transactions: uncategorized,
    groups: byGroup.map((g) => ({
      group: g.group_name,
      transactions: g.transactions,
      total: g.total,
      counts_as_spending: Boolean(g.counts_as_spending),
    })),
  };
}

module.exports = { cashflow };
