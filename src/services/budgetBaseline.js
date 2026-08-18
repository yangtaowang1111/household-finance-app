// Working out what a budget should be, from what actually happened.
//
// Nobody knows what they spend on 59 categories. They know roughly what last
// year felt like, and whether this year feels worse. So the job here is to put
// both numbers in front of a person and let them adjust from there — not to
// compute a "correct" budget, which does not exist.
//
// Four design points, each of which the real data forced:
//
//   1. The annual figure comes from the annual TOTAL, never from a typical
//      month multiplied by twelve. Multiplying assumes twelve active months:
//      2025 Travel spent in five, so median x 12 suggested $6,727 against
//      $4,001 actually spent, and a category with a single $60 purchase all
//      year suggested $720. The median is still reported, because it describes
//      a normal month well — it just must not be scaled.
//   2. One-offs are named, not smoothed away. 2025 Taxes was 100% in April and
//      Insurance 100% in January. Trimming them would hide a real annual cost;
//      averaging them in would imply it recurs monthly. So `largest_month`
//      reports the spike and its share, and a person decides whether it repeats.
//   3. Seasonality is detected, not assumed. Travel really is summer-heavy and
//      Gifts really is December; Groceries and Childcare are flat. Spreading an
//      annual figure evenly across a seasonal category invents an overspend
//      every summer and an underspend every winter.
//   4. Both years are offered and neither is chosen. Last year is the fuller
//      picture; this year is what is actually happening now. Which one matters
//      is a judgement about intent, and the app does not have it.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

/** Coefficient of variation above which a category is treated as seasonal. */
const SEASONAL_CV = 0.55;

/** Months with no spending at all are excluded from the median. */
function median(values) {
  const present = values.filter((v) => v !== 0).sort((a, b) => a - b);
  if (!present.length) return 0;
  const mid = Math.floor(present.length / 2);
  return present.length % 2 ? present[mid] : (present[mid - 1] + present[mid]) / 2;
}

/**
 * How unevenly a year's spending is distributed. Near 0 means every month looks
 * the same; a large value means the category arrives in bursts.
 */
function coefficientOfVariation(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  const mean = total / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** The heaviest month of a year, and how much of the year landed in it. */
function largestMonth(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  let index = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[index]) index = i;
  return {
    month: index + 1,
    amount: round2(values[index]),
    share: Math.round((values[index] / total) * 100) / 100,
  };
}

/**
 * The share of the year each month should carry. For a flat category this is
 * 1/12 twelve times; for a seasonal one it follows what actually happened, so
 * an annual budget lands in the months the spending lands in.
 */
function monthlyShape(values, seasonal) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!seasonal || total === 0) return Array(12).fill(1 / 12);
  return values.map((v) => v / total);
}

/**
 * Per-category spending history, with a suggested annual figure.
 *
 * @param {object} [options]
 * @param {number} [options.year]      the year being budgeted (default: current)
 * @param {number} [options.reference] the year to learn from (default: year - 1)
 */
function baseline(options = {}) {
  const year = options.year || new Date().getFullYear();
  const reference = options.reference || year - 1;

  const categories = db
    .prepare(
      `SELECT c.id, c.name, c.counts_as_spending, parent.name AS group_name, c.parent_category_id
       FROM categories c
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       ORDER BY COALESCE(parent.name, c.name), c.name`
    )
    .all();

  // One pass for every category-month, rather than 59 × 2 queries. Investment
  // accounts are excluded for the same reason the cash flow summary excludes
  // them: a brokerage's internal activity is not household spending.
  const rows = db
    .prepare(
      `SELECT t.category_id,
              CAST(strftime('%Y', t.date) AS INTEGER) AS year,
              CAST(strftime('%m', t.date) AS INTEGER) AS month,
              ROUND(SUM(-t.amount), 2) AS spent
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.category_id IS NOT NULL
         AND a.type != 'investment'
         AND CAST(strftime('%Y', t.date) AS INTEGER) IN (?, ?)
       GROUP BY t.category_id, year, month`
    )
    .all(reference, year);

  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category_id)) {
      byCategory.set(row.category_id, { [reference]: Array(12).fill(0), [year]: Array(12).fill(0) });
    }
    byCategory.get(row.category_id)[row.year][row.month - 1] = row.spent;
  }

  const existing = new Map(
    db
      .prepare(
        `SELECT category_id, ROUND(SUM(budgeted_amount), 2) AS annual
         FROM budgets WHERE month LIKE ? GROUP BY category_id`
      )
      .all(`${year}-%`)
      .map((b) => [b.category_id, b.annual])
  );

  // How much of the current year has actually happened, so a part-year total
  // can be projected without pretending the remaining months were zero.
  const now = new Date();
  const monthsElapsed = now.getFullYear() === year ? now.getMonth() + 1 : 12;

  const result = categories.map((c) => {
    const history = byCategory.get(c.id) || { [reference]: Array(12).fill(0), [year]: Array(12).fill(0) };
    const ref = history[reference];
    const cur = history[year];

    const refTotal = ref.reduce((s, v) => s + v, 0);
    const curTotal = cur.reduce((s, v) => s + v, 0);
    const refMedian = median(ref);
    const cv = coefficientOfVariation(ref);
    const seasonal = refTotal > 0 && cv >= SEASONAL_CV;

    // The run rate deliberately uses elapsed months rather than months with
    // spending — a category that was quiet in March was still budgeted in March.
    const runRate = monthsElapsed ? curTotal / monthsElapsed : 0;

    // The annual suggestion is built from the annual TOTAL, not from the median
    // month multiplied by twelve. The median describes a typical month well, but
    // multiplying it assumes twelve active months — Travel spent in seven, so
    // median x 12 suggested $6,727 against $4,001 actually spent, and a category
    // with one $60 purchase all year suggested $720.
    //
    // One-off spikes are handled by naming them instead of smoothing them away:
    // `largest_month` lets the caller ask "June was $10,000 of this — is that
    // happening again?", which is a question only a person can answer.
    const fromReference = refTotal;
    const fromRunRate = runRate * 12;
    let suggested = fromReference;
    if (fromReference > 0 && fromRunRate > 0) suggested = fromReference * 0.6 + fromRunRate * 0.4;
    else if (fromRunRate > 0) suggested = fromRunRate;

    return {
      id: c.id,
      name: c.name,
      group: c.group_name,
      is_group: c.parent_category_id === null,
      counts_as_spending: Boolean(c.counts_as_spending),
      reference_year: {
        year: reference,
        total: round2(refTotal),
        monthly: ref.map(round2),
        median_month: round2(refMedian),
        active_months: ref.filter((v) => v !== 0).length,
        // The biggest single month and its share of the year. A category where
        // one month is most of the total is usually a one-off wearing a
        // category's clothes, and the person budgeting needs to see that.
        largest_month: largestMonth(ref),
      },
      current_year: {
        year,
        total: round2(curTotal),
        monthly: cur.map(round2),
        months_elapsed: monthsElapsed,
        run_rate: round2(runRate),
      },
      seasonal,
      shape: monthlyShape(ref, seasonal).map((v) => round2(v * 1000) / 1000),
      suggested_annual: round2(suggested),
      budgeted_annual: existing.has(c.id) ? existing.get(c.id) : null,
    };
  });

  return {
    year,
    reference_year: reference,
    months_elapsed: monthsElapsed,
    categories: result,
  };
}

/**
 * Writes a year of budgets from annual figures, distributing each across the
 * months using its own shape.
 *
 * @param {number} year
 * @param {Array<{category_id: number, annual_amount: number, shape?: number[]}>} plans
 */
function writePlan(year, plans) {
  const upsert = db.prepare(
    `INSERT INTO budgets (category_id, month, budgeted_amount)
     VALUES (?, ?, ?)
     ON CONFLICT(category_id, month) DO UPDATE SET budgeted_amount = excluded.budgeted_amount`
  );
  const clear = db.prepare('DELETE FROM budgets WHERE category_id = ? AND month LIKE ?');

  let written = 0;
  let cleared = 0;

  db.transaction(() => {
    for (const plan of plans) {
      // A zero or null annual figure means "no budget for this", which is a
      // different statement from "budget of nothing" — the latter would report
      // every purchase as an overspend.
      if (!plan.annual_amount) {
        cleared += clear.run(plan.category_id, `${year}-%`).changes;
        continue;
      }

      const shape =
        Array.isArray(plan.shape) && plan.shape.length === 12 ? plan.shape : Array(12).fill(1 / 12);
      const sum = shape.reduce((s, v) => s + v, 0) || 1;

      for (let m = 0; m < 12; m += 1) {
        const month = `${year}-${String(m + 1).padStart(2, '0')}`;
        upsert.run(plan.category_id, month, round2((plan.annual_amount * shape[m]) / sum));
        written += 1;
      }
    }
  })();

  return { written, cleared };
}

module.exports = { baseline, writePlan, median, coefficientOfVariation, monthlyShape };
