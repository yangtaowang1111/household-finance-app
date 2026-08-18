// Properties: what they are worth, what is owed, and what the rental earns.
//
// One finding shapes this whole file: **property tax and homeowner's insurance
// are not in the ledger.** Both are escrowed inside the mortgage payment, so the
// only categories matching "tax" or "insurance" are income tax and car
// insurance. A chart of property tax built from transactions would be empty, and
// an empty chart implies zero rather than invisible.
//
// What can be seen is the payment itself. Escrow is re-analysed annually and the
// monthly payment moves when tax or insurance does — so the payment history is a
// faithful proxy for the thing being watched, and a step in it is exactly the
// event worth noticing. It is reported as what it is, rather than dressed up as
// a tax figure it cannot produce.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

function properties(options = {}) {
  const year = options.year || new Date().getFullYear();

  const rows = db
    .prepare(
      `SELECT id, name, nickname, current_balance, created_at
       FROM accounts WHERE type = 'property' ORDER BY current_balance DESC`
    )
    .all();

  const loans = db
    .prepare(
      `SELECT id, name, current_balance, secured_by_account_id
       FROM accounts WHERE type IN ('mortgage', 'loan') AND secured_by_account_id IS NOT NULL`
    )
    .all();

  // Monthly payment per loan. A step here is an escrow re-analysis, which is
  // the only visible trace of a property tax or insurance change.
  const payments = db
    .prepare(
      `SELECT c.name AS category,
              strftime('%Y-%m', t.date) AS month,
              ROUND(SUM(-t.amount), 2) AS amount
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE c.name IN ('Mortgage', 'Rental Mortgage')
         AND t.date >= date('now', '-24 months')
       GROUP BY c.name, month ORDER BY month`
    )
    .all();

  const paymentsByCategory = new Map();
  for (const p of payments) {
    if (!paymentsByCategory.has(p.category)) paymentsByCategory.set(p.category, []);
    paymentsByCategory.get(p.category).push({ month: p.month, amount: p.amount });
  }

  // Rental income and the expenses filed against the rental, this year and last,
  // so the two can be compared without a second request.
  const rentalIncome = db
    .prepare(
      `SELECT strftime('%Y-%m', t.date) AS month, ROUND(SUM(t.amount), 2) AS amount
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE c.name = 'Rental Income' AND strftime('%Y', t.date) IN (?, ?)
       GROUP BY month ORDER BY month`
    )
    .all(String(year), String(year - 1));

  const rentalExpenses = db
    .prepare(
      `SELECT c.name AS category,
              CAST(strftime('%Y', t.date) AS INTEGER) AS year,
              ROUND(SUM(-t.amount), 2) AS amount,
              COUNT(*) AS n
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       JOIN categories p ON p.id = c.parent_category_id
       WHERE p.name = 'Rental Property' AND CAST(strftime('%Y', t.date) AS INTEGER) IN (?, ?)
       GROUP BY c.name, year ORDER BY amount DESC`
    )
    .all(year, year - 1);

  const thisYearIncome = rentalIncome
    .filter((r) => r.month.startsWith(String(year)))
    .reduce((s, r) => s + r.amount, 0);
  const thisYearExpenses = rentalExpenses
    .filter((e) => e.year === year)
    .reduce((s, e) => s + e.amount, 0);

  const result = rows.map((p) => {
    const secured = loans.filter((l) => l.secured_by_account_id === p.id);
    const debt = secured.reduce((s, l) => s + l.current_balance, 0);
    // Named by the category its payments are filed under, which is how the
    // payment history is found.
    const isRental = /rental/i.test(p.nickname || p.name);
    const paymentCategory = isRental ? 'Rental Mortgage' : 'Mortgage';

    return {
      id: p.id,
      name: p.nickname || p.name,
      full_name: p.name,
      is_rental: isRental,
      value: round2(p.current_balance),
      mortgage: secured.length ? round2(debt) : null,
      equity: secured.length ? round2(p.current_balance + debt) : null,
      loan_accounts: secured.map((l) => l.name),
      // A step in this line is an escrow re-analysis — the only visible trace of
      // a property tax or insurance change, since both are escrowed.
      payment_history: paymentsByCategory.get(paymentCategory) || [],
    };
  });

  return {
    year,
    total_value: round2(result.reduce((s, p) => s + p.value, 0)),
    total_debt: round2(result.reduce((s, p) => s + (p.mortgage || 0), 0)),
    total_equity: round2(result.reduce((s, p) => s + (p.equity || 0), 0)),
    properties: result,
    rental: {
      income_ytd: round2(thisYearIncome),
      expenses_ytd: round2(thisYearExpenses),
      net_ytd: round2(thisYearIncome - thisYearExpenses),
      income_by_month: rentalIncome,
      expenses_by_category: rentalExpenses,
    },
    // Stated rather than left to be discovered. A property tax chart built from
    // this data would be empty, and an empty chart reads as zero.
    escrowed: {
      note:
        'Property tax and homeowner’s insurance are escrowed inside the mortgage payment and do not appear as separate transactions. The payment history below is the visible proxy: escrow is re-analysed annually, so a step in the payment is a tax or insurance change.',
    },
  };
}

module.exports = { properties };
