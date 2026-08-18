// Where the year lands if nothing changes.
//
// Deliberately arithmetic, not judgement. A trailing average is a trailing
// average, and producing one with a language model would give a number that is
// different on every run, impossible to audit, and no more accurate. The model
// earns its place reviewing a forecast — noticing that a figure is correct but
// factually wrong, which is a different skill — and that lives in Reporting.
//
// The method is chosen from the category's own shape rather than asked for,
// because the shape already says which one applies:
//
//   recurring    steady, active nearly every month     Mortgage, Childcare
//   trailing_3   variable, no strong season            Groceries, Dining Out
//   seasonal     repeats, but concentrated             Travel, Gifts
//   one_off      lands in one or two months a year     Taxes, Insurance
//   none         no history to forecast from
//
// The one_off case carries most of the value. 2026 Taxes is budgeted $8,042 and
// was paid in April; a run-rate forecast projects another ~$4,000 by December,
// and the right answer is zero. The app knows April has passed and knows the
// money already went, so no judgement is needed — only the discipline to ask.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

const METHODS = ['recurring', 'trailing_3', 'seasonal', 'one_off', 'none'];

// Thresholds for classification. Deliberately loose: a misclassification costs
// a slightly worse forecast, and the method is visible and overridable.
const RECURRING_CV = 0.25;
const RECURRING_MIN_MONTHS = 10;
const SEASONAL_CV = 0.55;
const ONE_OFF_SHARE = 0.7;

function stats(monthly) {
  const total = monthly.reduce((s, v) => s + v, 0);
  const active = monthly.filter((v) => v > 0).length;
  if (total <= 0) return { total: 0, active: 0, cv: 0, peakMonth: null, peakShare: 0 };

  const mean = total / 12;
  const cv = Math.sqrt(monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / 12) / mean;
  let peak = 0;
  for (let i = 1; i < 12; i += 1) if (monthly[i] > monthly[peak]) peak = i;
  return { total, active, cv, peakMonth: peak + 1, peakShare: monthly[peak] / total };
}

/** Picks a method from the shape of a reference year. */
function classify(reference) {
  const s = stats(reference);
  if (s.total <= 0) return 'none';
  if (s.peakShare >= ONE_OFF_SHARE || s.active <= 2) return 'one_off';
  if (s.cv >= SEASONAL_CV) return 'seasonal';
  if (s.cv < RECURRING_CV && s.active >= RECURRING_MIN_MONTHS) return 'recurring';
  return 'trailing_3';
}

/**
 * What is still to come this year, under one method.
 *
 * @param {string} method
 * @param {number[]} current    this year, by month (0-indexed)
 * @param {number[]} reference  last year, by month
 * @param {number} monthsElapsed
 */
function remaining(method, current, reference, monthsElapsed) {
  const monthsLeft = 12 - monthsElapsed;
  if (monthsLeft <= 0) return 0;

  const spent = current.slice(0, monthsElapsed);
  const ref = stats(reference);

  switch (method) {
    case 'recurring': {
      // The typical month of what has actually happened this year, which picks
      // up a rent rise the reference year cannot know about.
      const active = spent.filter((v) => v > 0).sort((a, b) => a - b);
      const typical = active.length ? active[Math.floor(active.length / 2)] : ref.total / 12;
      return typical * monthsLeft;
    }

    case 'trailing_3': {
      // Three months rather than the year to date: three notices a change of
      // habit, where a YTD average takes half a year to admit it.
      const window = spent.slice(Math.max(0, monthsElapsed - 3));
      const average = window.length ? window.reduce((s, v) => s + v, 0) / window.length : 0;
      return average * monthsLeft;
    }

    case 'seasonal': {
      // The remaining share of last year's distribution, scaled to how this year
      // is actually running against it.
      if (ref.total <= 0) return 0;
      const shape = reference.map((v) => v / ref.total);
      const elapsedShare = shape.slice(0, monthsElapsed).reduce((s, v) => s + v, 0);
      const remainingShare = 1 - elapsedShare;
      const spentSoFar = spent.reduce((s, v) => s + v, 0);
      // Scale by this year's own pace where there is enough elapsed shape to
      // judge it; otherwise fall back to last year's remaining amount.
      const scale = elapsedShare > 0.15 && spentSoFar > 0 ? spentSoFar / (ref.total * elapsedShare) : 1;
      return ref.total * remainingShare * scale;
    }

    case 'one_off': {
      // The whole question is whether it has happened yet. Both halves are
      // knowable: whether money went out this year, and whether the month it
      // usually lands in has passed.
      const spentSoFar = spent.reduce((s, v) => s + v, 0);
      if (spentSoFar > 0) return 0; // already paid this year
      if (ref.peakMonth && ref.peakMonth <= monthsElapsed) return 0; // its month came and went
      return ref.total; // still to come
    }

    default:
      return 0;
  }
}

/**
 * Year-end forecast for every category with a budget or any spending.
 *
 * @param {object} [options]
 * @param {number} [options.year]
 * @param {number} [options.reference]
 */
function forecast(options = {}) {
  const year = options.year || new Date().getFullYear();
  const reference = options.reference || year - 1;

  const now = new Date();
  // Complete months only. A month still running would drag every trailing
  // average down by however much of it is left.
  const monthsElapsed = now.getFullYear() === year ? now.getMonth() : 12;

  const categories = db
    .prepare(
      `SELECT c.id, c.name, c.forecast_method, c.counts_as_spending,
              parent.name AS group_name, parent.id AS group_id
       FROM categories c
       JOIN categories parent ON parent.id = c.parent_category_id
       WHERE c.counts_as_spending = 1`
    )
    .all();

  const rows = db
    .prepare(
      `SELECT t.category_id,
              CAST(strftime('%Y', t.date) AS INTEGER) AS year,
              CAST(strftime('%m', t.date) AS INTEGER) AS month,
              ROUND(SUM(-t.amount), 2) AS spent
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.category_id IS NOT NULL AND a.type != 'investment'
         AND CAST(strftime('%Y', t.date) AS INTEGER) IN (?, ?)
       GROUP BY t.category_id, year, month`
    )
    .all(reference, year);

  const history = new Map();
  for (const row of rows) {
    if (!history.has(row.category_id)) {
      history.set(row.category_id, { [reference]: Array(12).fill(0), [year]: Array(12).fill(0) });
    }
    history.get(row.category_id)[row.year][row.month - 1] = row.spent;
  }

  const budgets = new Map(
    db
      .prepare(
        `SELECT category_id, ROUND(SUM(budgeted_amount), 2) AS budgeted
         FROM budgets WHERE month LIKE ? GROUP BY category_id`
      )
      .all(`${year}-%`)
      .map((r) => [r.category_id, r.budgeted])
  );

  const result = categories
    .map((c) => {
      const h = history.get(c.id) || { [reference]: Array(12).fill(0), [year]: Array(12).fill(0) };
      const ref = h[reference];
      const cur = h[year];

      const chosen = METHODS.includes(c.forecast_method) ? c.forecast_method : classify(ref);
      const spentToDate = round2(cur.slice(0, monthsElapsed).reduce((s, v) => s + v, 0));
      const toCome = round2(Math.max(0, remaining(chosen, cur, ref, monthsElapsed)));
      const budget = budgets.has(c.id) ? budgets.get(c.id) : null;
      const yearEnd = round2(spentToDate + toCome);

      return {
        category_id: c.id,
        name: c.name,
        group: c.group_name,
        group_id: c.group_id,
        method: chosen,
        method_is_override: METHODS.includes(c.forecast_method),
        spent_to_date: spentToDate,
        forecast_remaining: toCome,
        forecast_year_end: yearEnd,
        budget,
        variance: budget === null ? null : round2(budget - yearEnd),
        over_budget: budget !== null && yearEnd > budget,
      };
    })
    .filter((r) => r.budget !== null || r.spent_to_date > 0 || r.forecast_remaining > 0)
    .sort((a, b) => b.forecast_year_end - a.forecast_year_end);

  const totals = result.reduce(
    (acc, r) => ({
      spent_to_date: acc.spent_to_date + r.spent_to_date,
      forecast_remaining: acc.forecast_remaining + r.forecast_remaining,
      forecast_year_end: acc.forecast_year_end + r.forecast_year_end,
      budget: acc.budget + (r.budget || 0),
    }),
    { spent_to_date: 0, forecast_remaining: 0, forecast_year_end: 0, budget: 0 }
  );

  return {
    year,
    reference_year: reference,
    months_elapsed: monthsElapsed,
    months_remaining: 12 - monthsElapsed,
    spent_to_date: round2(totals.spent_to_date),
    forecast_remaining: round2(totals.forecast_remaining),
    forecast_year_end: round2(totals.forecast_year_end),
    budget: round2(totals.budget),
    variance: round2(totals.budget - totals.forecast_year_end),
    categories: result,
  };
}

module.exports = { forecast, classify, remaining, METHODS };
