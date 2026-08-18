// Budget against actual, for a month or for the year so far.
//
// Distinct from budgetCalc.js, which reports only categories that have a budget
// row. That is the wrong shape for a screen: **spending with no budget against
// it is the most interesting thing on the page**, and a report that iterates
// over budgets can never show it. This iterates over spending and budgets
// together, so an unbudgeted category appears with its actual and a null budget
// rather than silently not existing.
//
// Two modes, because they answer different questions:
//
//   month  "am I over this month?" — compares one month's spending against that
//          month's budget, which for a seasonal category is not one twelfth of
//          the year.
//   ytd    "am I over for the year?" — compares everything so far against the
//          budget for the months that have actually happened. Comparing a
//          part-year actual against a whole-year budget would report every
//          category as comfortably under until December.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} options
 * @param {number} options.year
 * @param {number} [options.month]  1-12. Omitted means year to date.
 */
function budgetProgress({ year, month }) {
  const isMonth = Boolean(month);

  // The window of months being compared. For YTD this stops at the current
  // month so the budget side covers the same ground as the actual side.
  const now = new Date();
  const lastMonth = isMonth
    ? month
    : now.getFullYear() === year
      ? now.getMonth() + 1
      : 12;
  const firstMonth = isMonth ? month : 1;

  const monthKey = (m) => `${year}-${String(m).padStart(2, '0')}`;
  const from = `${monthKey(firstMonth)}-01`;
  const toExclusive =
    lastMonth === 12 ? `${year + 1}-01-01` : `${year}-${String(lastMonth + 1).padStart(2, '0')}-01`;

  // For a month still running, "expected" is a question of days: on 17 August a
  // category that has used 55% of its August budget is exactly on plan, and
  // flagging it would train the reader to ignore the flags.
  const isCurrentMonth =
    isMonth && now.getFullYear() === year && now.getMonth() + 1 === month;
  const daysInMonth = new Date(year, isMonth ? month : 12, 0).getDate();
  const periodElapsed = isCurrentMonth ? now.getDate() / daysInMonth : 1;

  const categories = db
    .prepare(
      `SELECT c.id, c.name, c.counts_as_spending, c.parent_category_id,
              parent.name AS group_name, parent.id AS group_id
       FROM categories c
       LEFT JOIN categories parent ON parent.id = c.parent_category_id`
    )
    .all();

  const actuals = new Map(
    db
      .prepare(
        `SELECT t.category_id, ROUND(SUM(-t.amount), 2) AS spent
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.category_id IS NOT NULL
           AND a.type != 'investment'
           AND t.date >= ? AND t.date < ?
         GROUP BY t.category_id`
      )
      .all(from, toExclusive)
      .map((r) => [r.category_id, r.spent])
  );

  // The full year, used as the denominator for pace and projection. The budget's
  // own distribution is the expectation — for Taxes, being 100% "used" in April
  // is exactly on plan, and a straight line would call it a catastrophe.
  const annualBudgets = new Map(
    db
      .prepare(
        `SELECT category_id, ROUND(SUM(budgeted_amount), 2) AS budgeted
         FROM budgets WHERE month LIKE ? GROUP BY category_id`
      )
      .all(`${year}-%`)
      .map((r) => [r.category_id, r.budgeted])
  );

  const budgets = new Map(
    db
      .prepare(
        `SELECT category_id, ROUND(SUM(budgeted_amount), 2) AS budgeted
         FROM budgets
         WHERE month >= ? AND month <= ?
         GROUP BY category_id`
      )
      .all(monthKey(firstMonth), monthKey(lastMonth))
      .map((r) => [r.category_id, r.budgeted])
  );

  /**
   * How fast a category is spending relative to plan, and where it lands if it
   * carries on. Expressed against the budget's own distribution rather than a
   * straight line, so a seasonal category is not perpetually "ahead".
   */
  function pacing(actual, budgeted, annual) {
    if (!budgeted || budgeted <= 0) {
      return { expected: null, pace: null, projected_year_end: null };
    }
    const expected = round2(budgeted * periodElapsed);
    const pace = expected > 0 ? Math.round((actual / expected) * 100) / 100 : null;

    // Where the year ends if the rest of it follows the plan from here. Only
    // meaningful year-to-date; for a single month the question is not asked.
    let projected = null;
    if (!isMonth && annual > 0 && budgeted > 0) {
      const shareOfYearBudgeted = budgeted / annual;
      if (shareOfYearBudgeted > 0.05) projected = round2(actual / shareOfYearBudgeted);
    }
    return { expected, pace, projected_year_end: projected };
  }

  const rows = categories
    // Groups are included, not only children. The categoriser can file a
    // transaction on a group -- the model answering "Shopping" matches the
    // Shopping group by name -- and filtering those out made the money vanish
    // from the comparison AND from the unbudgeted figure meant to catch it.
    // July 2026 had $4,339 disappear this way while "unbudgeted" read zero.
    .filter((c) => c.counts_as_spending)
    .map((c) => {
      const filedOnGroup = c.parent_category_id === null;
      const actual = actuals.get(c.id) || 0;
      // null, not zero: "no budget set" and "budgeted nothing" are different
      // claims, and only the second is an overspend when money is spent.
      // A budget on a group is a cap over its children, reported separately --
      // so a group-filed row carries no budget of its own, or the cap would be
      // counted twice: once as the cap and once as this row's allowance.
      const budgeted = !filedOnGroup && budgets.has(c.id) ? budgets.get(c.id) : null;
      const annual = filedOnGroup ? 0 : annualBudgets.get(c.id) || 0;

      return {
        category_id: c.id,
        // A group-filed transaction is real money with no child to sit under.
        // Naming it plainly is better than inventing a category or hiding it.
        name: filedOnGroup ? `${c.name} — unspecified` : c.name,
        group: filedOnGroup ? c.name : c.group_name,
        group_id: filedOnGroup ? c.id : c.group_id,
        filed_on_group: filedOnGroup,
        budgeted,
        annual_budget: annual || null,
        actual: round2(actual),
        remaining: budgeted === null ? null : round2(budgeted - actual),
        used_percent: budgeted ? Math.round((actual / budgeted) * 100) : null,
        over: budgeted !== null && actual > budgeted,
        unbudgeted: budgeted === null && actual > 0,
        ...pacing(actual, budgeted, annual),
      };
    })
    // A row with nothing budgeted and nothing spent has nothing to say. This
    // matters for seasonal categories, which genuinely carry a $0 budget in
    // their off months — Travel budgets nothing for June, and printing "$0 of
    // $0" for it in every quiet month would bury the rows that matter.
    //
    // A $0 budget with actual spending still appears, and reads as over, which
    // is correct: money went somewhere it was not planned to go.
    .filter((r) => r.actual !== 0 || (r.budgeted !== null && r.budgeted !== 0));

  // Groups roll up from their children. A budget set on the group itself is a
  // cap rather than a total — see docs/roadmap.md — so it is reported alongside
  // the rolled-up figure and any conflict is left visible instead of resolved.
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group_id)) {
      groups.set(row.group_id, {
        group_id: row.group_id,
        name: row.group,
        budgeted: 0,
        actual: 0,
        cap: budgets.has(row.group_id) ? budgets.get(row.group_id) : null,
        categories: [],
      });
    }
    const g = groups.get(row.group_id);
    g.budgeted += row.budgeted || 0;
    g.actual += row.actual;
    g.categories.push(row);
  }

  const groupRows = [...groups.values()]
    .map((g) => ({
      ...g,
      budgeted: round2(g.budgeted),
      actual: round2(g.actual),
      remaining: round2(g.budgeted - g.actual),
      used_percent: g.budgeted ? Math.round((g.actual / g.budgeted) * 100) : null,
      over: g.budgeted > 0 && g.actual > g.budgeted,
      // Set only when a cap exists and the children exceed it. The roadmap
      // decision: show the conflict rather than silently picking a winner.
      cap_exceeded_by:
        g.cap !== null && g.budgeted > g.cap ? round2(g.budgeted - g.cap) : null,
      categories: g.categories.sort((a, b) => b.actual - a.actual),
    }))
    .sort((a, b) => b.actual - a.actual);

  const totalBudgeted = groupRows.reduce((s, g) => s + g.budgeted, 0);
  const totalActual = groupRows.reduce((s, g) => s + g.actual, 0);

  return {
    year,
    month: isMonth ? month : null,
    mode: isMonth ? 'month' : 'ytd',
    months_covered: lastMonth - firstMonth + 1,
    budgeted: round2(totalBudgeted),
    actual: round2(totalActual),
    remaining: round2(totalBudgeted - totalActual),
    used_percent: totalBudgeted ? Math.round((totalActual / totalBudgeted) * 100) : null,
    unbudgeted_spending: round2(rows.filter((r) => r.unbudgeted).reduce((s, r) => s + r.actual, 0)),
    groups: groupRows,
  };
}

module.exports = { budgetProgress };
