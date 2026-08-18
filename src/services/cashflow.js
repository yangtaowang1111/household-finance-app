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
//   income     what came in
//   spending   what was consumed  (counts_as_spending = 1)
//   surplus    income less spending — this is the savings rate
//   saved      how much of the surplus actually moved into savings/investments
//   unallocated the rest of it, still sitting in cash
//
// Transfers appear in neither total. Both legs are real transactions, so they
// cancel; including them would double-count in one direction and cancel to noise
// in the other.
//
// Transactions ON investment accounts are excluded entirely, whatever category
// they carry. Two reasons, and the first is a real double-count:
//
//   1. A contribution is already recorded once, as the outbound transfer from
//      the cash account that funded it. If the brokerage also reports the
//      matching buy, counting both books the same $30,000 twice.
//   2. Dividends, reinvestments and realised gains inside an account are not
//      household cash flow. Nothing was earned or spent until money actually
//      leaves for a chequing account — and that withdrawal appears on the
//      chequing side, where it is captured properly.
//
// So growth and loss never touch income or spending. They show up where they
// belong: in the balance, and therefore in net worth, via the daily snapshots in
// `account_balance_snapshots`. A market gain is not a transaction and must never
// be made to look like one.

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
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       WHERE t.date >= ? AND t.date < ?
         AND a.type != 'investment'
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

  // Scoped the same way as the totals above. Counting brokerage rows here while
  // excluding them from the sums would report "4 uncategorized" forever —
  // Vanguard's money-market sweep pairs are never going to be categorised, and
  // nothing is wrong with that.
  const uncategorized = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.category_id IS NULL AND t.date >= ? AND t.date < ? AND a.type != 'investment'`
    )
    .get(from, to).n;

  return {
    window: { from, to },
    income: round2(income),
    spending: round2(spending),
    saved: round2(saved),
    // What was earned and not spent. This is the savings rate, and it is
    // deliberately NOT contributions/income — a month spent frugally with no
    // transfer made would report 0% under that definition while the cash
    // balance climbed. It also has to match the budget screen, which can only
    // know what a budget controls: income less spending.
    surplus: round2(income - spending),
    savings_rate: income > 0 ? round2(((income - spending) / income) * 100) : null,
    // Where the surplus went. `saved` is what actually moved into savings and
    // investments; `unallocated` is what stayed in cash. They sum to surplus,
    // which is the reconciliation worth being able to see.
    unallocated: round2(income - spending - saved),
    net: round2(income - spending - saved),
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
