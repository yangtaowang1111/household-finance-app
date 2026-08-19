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

/**
 * The same period one year earlier — and for a period still running, the same
 * PART of it.
 *
 * Comparing nineteen days of August against all of last August is wrong in the
 * most reassuring direction: it makes an ordinary month look frugal. The prior
 * window is therefore truncated to the same day of the month.
 */
function priorYearBounds(bounds, year, throughDate) {
  const from = bounds.from.replace(String(year), String(year - 1));
  const to = throughDate
    ? throughDate.replace(String(year), String(year - 1))
    : bounds.to.replace(String(year), String(year - 1)).replace(String(year + 1), String(year));
  return { from, to };
}

function reportData(options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  const quarter = options.quarter || null;
  const month = quarter ? null : options.month || now.getMonth() || 12;

  const bounds = periodBounds({ year, month, quarter });

  // A period still running is reported as far as it has actually got, not to its
  // nominal end -- otherwise every figure in it is compared against a month that
  // has not happened.
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const inProgress = bounds.from <= today && today < bounds.to;
  const effectiveTo = inProgress ? tomorrow : bounds.to;

  const prior = priorYearBounds(bounds, year, inProgress ? tomorrow : null);

  const period = cashflow({ from: bounds.from, to: effectiveTo });
  const lastYear = cashflow({ from: prior.from, to: prior.to });

  // How far through, so nothing downstream mistakes a part-month for a whole one.
  const daysElapsed = inProgress
    ? Math.round((new Date(today) - new Date(bounds.from)) / 86400000) + 1
    : Math.round((new Date(bounds.to) - new Date(bounds.from)) / 86400000);
  const daysInPeriod = Math.round((new Date(bounds.to) - new Date(bounds.from)) / 86400000);

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
  if (inProgress) {
    caveats.push(
      `This period is ${daysElapsed} of ${daysInPeriod} days in. Figures are month-to-date, budgets are prorated to the same point, and last year's comparison covers the same span — but the remaining ${daysInPeriod - daysElapsed} days are unknown.`
    );
  }
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
    period: {
      label: inProgress ? `${bounds.label} so far` : bounds.label,
      from: bounds.from,
      to: effectiveTo,
      year,
      month,
      quarter,
      // Stated plainly, because every comparison below depends on it. A
      // part-month compared against a whole one reads as thrift.
      in_progress: inProgress,
      days_elapsed: daysElapsed,
      days_in_period: daysInPeriod,
      prior_year_window: `${prior.from} to ${prior.to} (matched to the same span)`,
    },
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

/**
 * A briefing for a month that has not happened.
 *
 * Deliberately not a review with the numbers left out. A review asks what
 * happened; this asks what is likely to, which needs different evidence: the
 * same month a year ago (what recurs), the last three months (what is trending
 * into it), the budget for the month itself, and whatever the household has
 * already written down about it.
 *
 * The most useful part is usually the overlap — a category that ran hot last
 * month AND was expensive this month last year is the one to watch, and neither
 * fact alone would say so.
 */
function planData(options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  // getMonth() is zero-indexed, so +2 is "next month" as a 1-12 value.
  const nextMonth = now.getMonth() + 2;
  const month = options.month || (nextMonth > 12 ? 1 : nextMonth);
  const target = periodBounds({ year, month });

  // Same month, a year earlier: what this month costs when it comes round.
  const lastYear = cashflow({
    from: target.from.replace(String(year), String(year - 1)),
    to: target.to.replace(String(year), String(year - 1)).replace(String(year + 1), String(year)),
  });

  // The three months before the target, as the trend running into it.
  const start = new Date(year, month - 4, 1);
  const end = new Date(year, month - 1, 1);
  const recent = cashflow({
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  });

  // Where the budget for the target month sits, and what is already off pace in
  // the month now running — a category overspending today is the one likely to
  // overspend again.
  const budget = budgetProgress({ year, month });
  const runningMonth = now.getFullYear() === year && now.getMonth() + 1 < month
    ? budgetProgress({ year, month: now.getMonth() + 1 })
    : null;

  const offPace = runningMonth
    ? runningMonth.groups
        .flatMap((g) => g.categories)
        .filter((c) => c.pace !== null && c.pace > 1.1)
        .sort((a, b) => b.pace - a.pace)
        .slice(0, 8)
        .map((c) => ({ category: c.name, budgeted: c.budgeted, actual: c.actual, pace: c.pace }))
    : [];

  const lastYearByGroup = new Map(lastYear.groups.map((g) => [g.group, -g.total]));
  const recentByGroup = new Map(recent.groups.map((g) => [g.group, -g.total / 3]));

  // A group that is both expensive in this month historically and running above
  // its recent average is the one worth naming.
  const watch = [...lastYearByGroup.entries()]
    .filter(([group, amount]) => amount > 0 && group !== 'Income')
    .map(([group, lastYearAmount]) => ({
      group,
      this_month_last_year: round2(lastYearAmount),
      recent_monthly_average: round2(recentByGroup.get(group) || 0),
      above_recent_by: round2(lastYearAmount - (recentByGroup.get(group) || 0)),
    }))
    .sort((a, b) => b.above_recent_by - a.above_recent_by)
    .slice(0, 8);

  return {
    planning_for: { label: target.label, from: target.from, to: target.to, year, month },
    budget_for_the_month: {
      budgeted: budget.budgeted,
      by_group: budget.groups.map((g) => ({ group: g.name, budgeted: g.budgeted })),
    },
    same_month_last_year: {
      income: lastYear.income,
      spending: lastYear.spending,
      by_group: lastYear.groups
        .filter((g) => g.counts_as_spending && g.total < 0)
        .map((g) => ({ group: g.group, amount: round2(-g.total) }))
        .sort((a, b) => b.amount - a.amount),
    },
    recent_three_months: {
      monthly_average_spending: round2(recent.spending / 3),
      monthly_average_income: round2(recent.income / 3),
    },
    // Groups that cost more in this month historically than they do normally.
    heavier_in_this_month: watch,
    // Categories overspending right now, which tend to keep doing so.
    currently_off_pace: offPace,
    household_context: context(year, month),
  };
}

module.exports = { reportData, planData, periodBounds };
