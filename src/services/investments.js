// Investment accounts: what they hold, what was put in, and the difference.
//
// The difference is the only interesting number, and it is only honest because
// Vanguard is new in 2026 — every contribution is inside the data, so "worth
// today minus what went in" really is the gain. On an account with years of
// untracked history the cost basis would be missing and the same subtraction
// would report the entire balance as profit.
//
// Contributions cannot be attributed to a *particular* account. The outflow
// that funds them leaves a chequing account reading "VANGUARD BUY INVESTMENT"
// and says nothing about which of three Vanguard accounts received it. So the
// gain is reported in aggregate and per-account balances are reported without
// one. Guessing an allocation would produce three plausible numbers, all wrong.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

function investments(options = {}) {
  const accounts = db
    .prepare(
      `SELECT id, name, nickname, institution, current_balance, source
       FROM accounts WHERE type = 'investment' ORDER BY current_balance DESC`
    )
    .all();

  // Contributions whose destination is one of these accounts — and only those.
  //
  // Not the whole Savings & Investments group, which was the first attempt and
  // is wrong: it also holds College Fund (529) and Emergency Fund, neither of
  // which lands in a brokerage. The 529 in particular is untracked, so counting
  // its $10,000 here would subtract from the gain a balance this page cannot
  // see, and report a loss that did not happen.
  //
  // The cash side only. The mirror inside the brokerage is excluded, or the
  // same money counts twice.
  const INVESTED_INTO = ['Investment Contributions', 'Retirement Contributions'];
  const placeholders = INVESTED_INTO.map(() => '?').join(', ');

  const contributions = db
    .prepare(
      `SELECT ROUND(SUM(-t.amount), 2) AS total, MIN(t.date) AS first, COUNT(*) AS n
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id
       WHERE a.type != 'investment' AND t.amount < 0 AND c.name IN (${placeholders})`
    )
    .get(...INVESTED_INTO);

  // Reported separately rather than folded in: money that genuinely left for
  // somewhere this page cannot see. Without naming it, the totals look like
  // they simply do not add up.
  const elsewhere = db
    .prepare(
      `SELECT c.name, ROUND(SUM(-t.amount), 2) AS total
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_category_id
       WHERE a.type != 'investment' AND t.amount < 0
         AND COALESCE(parent.name, c.name) = 'Savings & Investments'
         AND c.name NOT IN (${placeholders})
       GROUP BY c.name ORDER BY total DESC`
    )
    .all(...INVESTED_INTO);

  // Balance history, so the page can draw where each account has been. Daily
  // snapshots start when Phase 3 went live; before that there is nothing, and
  // the chart says so rather than inventing a line.
  const history = db
    .prepare(
      `SELECT account_id, date(recorded_at) AS day, ROUND(AVG(balance), 2) AS balance
       FROM account_balance_snapshots
       WHERE account_id IN (SELECT id FROM accounts WHERE type = 'investment')
       GROUP BY account_id, day
       ORDER BY day`
    )
    .all();

  const byAccount = new Map();
  for (const row of history) {
    if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, []);
    byAccount.get(row.account_id).push({ date: row.day, balance: row.balance });
  }

  const value = accounts.reduce((s, a) => s + a.current_balance, 0);
  const contributed = contributions.total || 0;

  return {
    value: round2(value),
    contributed: round2(contributed),
    // Unrealised, and never income — it changes a balance with no cash flow
    // behind it, which is also how it is taxed until something is sold.
    gain: round2(value - contributed),
    gain_percent: contributed > 0 ? round2(((value - contributed) / contributed) * 100) : null,
    contributions_since: contributions.first || null,
    contribution_count: contributions.n || 0,
    // Named so a reader knows the gain is a household total rather than
    // something known per account.
    gain_is_aggregate: true,
    // Contributions that went somewhere this page cannot value — a 529, an
    // untracked savings pot. Shown so the numbers visibly account for
    // themselves instead of appearing not to add up.
    contributed_elsewhere: elsewhere.map((e) => ({ category: e.name, total: e.total })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.nickname || a.name,
      full_name: a.name,
      institution: a.institution,
      balance: round2(a.current_balance),
      source: a.source,
      history: byAccount.get(a.id) || [],
    })),
  };
}

module.exports = { investments };
