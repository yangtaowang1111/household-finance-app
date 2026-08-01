const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Budget-vs-actual for a given month (format 'YYYY-MM').
 * Actual spend is the negated sum of transaction amounts in that category/month
 * (transactions store expenses as negative amounts).
 */
function budgetVsActual(month) {
  const budgets = db.prepare(`
    SELECT b.category_id, c.name AS category_name, c.bucket, b.budgeted_amount
    FROM budgets b JOIN categories c ON c.id = b.category_id
    WHERE b.month = ?
  `).all(month);

  const actualStmt = db.prepare(`
    SELECT COALESCE(-SUM(amount), 0) AS actual
    FROM transactions
    WHERE category_id = ? AND strftime('%Y-%m', date) = ?
  `);

  return budgets.map((b) => {
    const { actual } = actualStmt.get(b.category_id, month);
    return {
      category_id: b.category_id,
      category_name: b.category_name,
      bucket: b.bucket,
      budgeted_amount: b.budgeted_amount,
      actual_spent: round2(actual),
      variance: round2(b.budgeted_amount - actual),
    };
  });
}

module.exports = { budgetVsActual };
