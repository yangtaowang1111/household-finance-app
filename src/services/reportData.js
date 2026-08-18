// Assembles the household's position for a period, as structured figures.
//
// This is the whole quality decision for reporting. Handing a model 2,565 raw
// transactions produces worse analysis than handing it thirty well-chosen
// numbers: the model spends its attention arithmetic-checking rows instead of
// noticing what the arithmetic means, and it costs a hundred times more.
//
// So everything here is already computed, already reconciled, and already
// carries the caveats the rest of the app knows about — that investment growth
// is not income, that a mortgage payment hides its escrow, that income is
// projected from a year in which someone changed jobs. A summary that omits
// those invites confident nonsense about them.

const db = require('../db');
const { cashflow } = require('./cashflow');
const { budgetProgress } = require('./budgetProgress');
const { currentNetWorth, netWorthHistory } = require('./networth');
const { forecast } = require('./forecast');

const round2 = (n) => Math.round(n * 100) / 100;

/** Bounds for a month or a quarter. `to` is exclusive throughout the app. */
function periodBounds({ year, month, quarter }) {
  if (quarter) {
    const first = (quarter - 1) * 3 + 1;
    const lastExclusive = first + 3;
    return {
      label: `Q${quarter} ${year}`,
      from: `${year}-${String(first).padStart(2, '0')}-01`,
      to: lastExclusive > 12 ? `${year + 1}-01-01` : `${year}-${String(lastExclusive).padStart(2, '0')}-01`,
      months: [first, first + 1, first + 2],
    };
  }
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return {
    label: new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    from: `${year}-${String(month).padStart(2, '0')}-01`,
    to: next,
    months: [month],
  };
}

/** The same period one year earlier, for a like-for-like comparison. */
function priorYearBounds(bounds, year) {
  return {
    from: bounds.from.replace(String(year), String(year - 1)),
    to: bounds.to.replace(String(year), String(year - 1)).replace(String(year + 1), String(year)),
  };
}

function reportData(options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  const quarter = options.quarter || null;
  const month = quarter ? null : options.month || now.getMonth() || 12;

  const bounds = periodBounds({ year, month, quarter });
  const prior = priorYearBounds(bounds, year);

  const period = cashflow({ from: bounds.from, to: bounds.to });
  const lastYear = cashflow({ from: prior.from, to: prior.to });

  // Biggest movers against the same period last year. Ranked by absolute
  // change, because a category that halved matters as much as one that doubled.
  const priorByGroup = new Map(lastYear.groups.map((g) => [g.group, g.total]));
  const movers = period.groups
    .filter((g) => g.counts_as_spending)
    .map((g) => {
      const before = priorByGroup.get(g.group) || 0;
      return {
        group: g.group,
        now: round2(-g.total),
        then: round2(-before),
        change: round2(-g.total - -before),
        percent: before ? Math.round(((-g.total - -before) / Math.abs(before)) * 100) : null,
      };
    })
    .filter((m) => Math.abs(m.change) >= 50)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 8);

  // Budget position across the whole period, plus whatever is off pace.
  const progress = quarter
    ? budgetProgress({ year })
    : budgetProgress({ year, month });
  const overspent = progress.groups
    .flatMap((g) => g.categories)
    .filter((c) => c.over && c.budgeted)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 8)
    .map((c) => ({ category: c.name, budgeted: c.budgeted, actual: c.actual, over_by: round2(-c.remaining) }));

  const nw = currentNetWorth();
  const history = netWorthHistory({ from: bounds.from, to: undefined });
  const projections = forecast({ year });

  // Things a person needs to know before trusting any of the above. Stated as
  // data so the reviewer cannot miss them.
  const caveats = [];
  if (period.uncategorized_transactions > 0) {
    caveats.push(`${period.uncategorized_transactions} transactions in this period are uncategorised and excluded from every total.`);
  }
  const needsReview = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE needs_review = 1').get().n;
  if (needsReview) caveats.push(`${needsReview} transactions are flagged as low-confidence categorisations.`);
  if (history.reconstructed_before) {
    caveats.push(
      `Net worth before ${history.reconstructed_before} is reconstructed from transactions; investment, property and mortgage balances are held flat across that span, so growth is understated.`
    );
  }
  const untracked = db
    .prepare("SELECT COUNT(*) AS n FROM accounts WHERE type = 'property' AND id NOT IN (SELECT secured_by_account_id FROM accounts WHERE secured_by_account_id IS NOT NULL)")
    .get().n;
  if (untracked) caveats.push(`${untracked} properties have no mortgage linked, so their equity is unknown.`);

  return {
    period: { label: bounds.label, from: bounds.from, to: bounds.to, year, month, quarter },
    cash_flow: {
      income: period.income,
      spending: period.spending,
      surplus: period.surplus,
      savings_rate_percent: period.savings_rate,
      moved_to_savings: period.saved,
      left_in_cash: period.unallocated,
      prior_year: {
        income: lastYear.income,
        spending: lastYear.spending,
        savings_rate_percent: lastYear.savings_rate,
      },
    },
    spending_by_group: period.groups
      .filter((g) => g.counts_as_spending && g.total < 0)
      .map((g) => ({ group: g.group, amount: round2(-g.total), transactions: g.transactions }))
      .sort((a, b) => b.amount - a.amount),
    biggest_changes_vs_last_year: movers,
    budget: {
      budgeted: progress.budgeted,
      actual: progress.actual,
      used_percent: progress.used_percent,
      unbudgeted_spending: progress.unbudgeted_spending,
      most_overspent: overspent,
    },
    forecast: {
      year_end_spending: projections.forecast_year_end,
      annual_budget: projections.budget,
      variance: projections.variance,
      months_remaining: projections.months_remaining,
    },
    net_worth: {
      total: nw.net_worth,
      assets: nw.assets,
      liabilities: nw.liabilities,
      change_this_period: history.change,
      by_type: nw.by_type,
    },
    caveats,
    // Household facts no ledger can hold: a job ending, a cost about to stop, a
    // one-off already known about. Without these the reviewer reasons from the
    // numbers alone and reaches confident wrong conclusions -- the July 2026
    // review inferred a rental vacancy from an income drop that was actually a
    // final part-month paycheck.
    household_context: context(year, bounds.months[bounds.months.length - 1]),
  };
}

/**
 * What the household has recorded that no ledger holds.
 *
 * Two parts, because they age differently. The standing note is durable —
 * escrowed insurance, payroll deductions the ledger never sees — and is written
 * once. Period notes are pinned to the month they describe, so they are never
 * stale: a review simply does not read months it does not cover.
 *
 * Notes from earlier in the same year are included, because continuity matters
 * within a year — a December review should know the job changed in July — while
 * a year is a natural boundary at which context stops accumulating.
 */
function context(year, throughMonth) {
  const standing = db.prepare("SELECT value FROM settings WHERE key = 'report_context'").get();
  const notes = db
    .prepare('SELECT period, note FROM period_notes WHERE period >= ? AND period <= ? ORDER BY period')
    .all(`${year}-01`, `${year}-${String(throughMonth).padStart(2, '0')}`);

  // The month immediately after the period, if it has a note. A drawdown reads
  // very differently when the next month has no paycheck either, and that is
  // knowable in advance — but it has not happened, so it is labelled rather than
  // mixed in with what did.
  const nextMonth = throughMonth === 12 ? `${year + 1}-01` : `${year}-${String(throughMonth + 1).padStart(2, '0')}`;
  const upcoming = db.prepare('SELECT period, note FROM period_notes WHERE period = ?').get(nextMonth);

  if (!standing?.value && !notes.length && !upcoming) return null;
  return {
    always_true: standing && standing.value ? standing.value : null,
    by_month: notes.map((n) => ({ month: n.period, note: n.note })),
    what_is_coming: upcoming ? { month: upcoming.period, note: upcoming.note } : null,
  };
}

module.exports = { reportData, periodBounds };
