// Net worth: what it is now, and what it was.
//
// The "was" is the hard half. `account_balance_snapshots` only started
// recording when Phase 3 went live (2026-08-15), so there is no stored history
// before that — but the dashboard wants a curve running back through the year.
//
// Most of it can be rebuilt: for an account whose balance only moves when a
// transaction moves it, the balance on day D is today's balance minus
// everything that happened since. That holds for chequing, savings and credit
// cards, and the 2026 statement import means transaction coverage is complete
// back to 1 January.
//
// It does NOT hold for the other three types, each for its own reason:
//
//   investment  Market movement changes the balance with no transaction behind
//               it. Rebuilding from transactions would draw a flat line through
//               every rise and fall and call it history.
//   property    Valued by hand, once. There is no revaluation history to draw,
//               and inventing one would be worse than admitting it.
//   mortgage    Payments are recorded on the chequing account that sent them,
//               not on the loan, so the loan's principal paydown is invisible
//               here. Held flat, which understates past debt by roughly
//               $1,000/month — the reconstructed curve is therefore slightly
//               conservative, showing less growth than really happened.
//
// So those three are held at today's value and the series is labelled
// `reconstructed` for every point before real snapshots begin. Better a curve
// that is honest about its own boundary than one that quietly guesses.

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

// Classified by type rather than by sign: an overdrawn chequing account is
// still an asset account, and a credit card in credit is still a liability.
const ASSET_TYPES = ['checking', 'savings', 'investment', 'property'];
const LIABILITY_TYPES = ['credit', 'mortgage', 'loan'];
const RECONSTRUCTABLE = ['checking', 'savings', 'credit'];

/** Balances as they stand, grouped the way the dashboard shows them. */
function currentNetWorth() {
  const accounts = db
    .prepare('SELECT id, name, nickname, type, current_balance, secured_by_account_id FROM accounts')
    .all();

  let assets = 0;
  let liabilities = 0;
  const byType = new Map();

  for (const a of accounts) {
    if (ASSET_TYPES.includes(a.type)) assets += a.current_balance;
    else liabilities += a.current_balance;

    if (!byType.has(a.type)) byType.set(a.type, { type: a.type, accounts: 0, total: 0 });
    const group = byType.get(a.type);
    group.accounts += 1;
    group.total += a.current_balance;
  }

  // A property and the loan against it, paired. Equity is a sum rather than a
  // difference because the loan is already stored negative.
  const properties = accounts
    .filter((a) => a.type === 'property')
    .map((property) => {
      const loans = accounts.filter((a) => a.secured_by_account_id === property.id);
      const debt = loans.reduce((sum, l) => sum + l.current_balance, 0);
      return {
        id: property.id,
        name: property.nickname || property.name,
        value: round2(property.current_balance),
        // null rather than 0 when nothing is linked: "no mortgage recorded" and
        // "owned outright" are different claims, and only one of them is safe to
        // make on this data.
        mortgage: loans.length ? round2(debt) : null,
        equity: loans.length ? round2(property.current_balance + debt) : null,
        mortgage_accounts: loans.map((l) => l.name),
      };
    });

  return {
    net_worth: round2(assets + liabilities),
    assets: round2(assets),
    liabilities: round2(Math.abs(liabilities)),
    by_type: [...byType.values()]
      .map((g) => ({ ...g, total: round2(g.total) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    properties,
  };
}

/**
 * Net worth per day across a range, rebuilt backwards from today.
 *
 * @param {object} options
 * @param {string} options.from  inclusive ISO date
 * @param {string} options.to    inclusive ISO date; defaults to today
 */
function netWorthHistory({ from, to }) {
  const today = to || new Date().toISOString().slice(0, 10);

  const accounts = db.prepare('SELECT id, type, current_balance FROM accounts').all();
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (ASSET_TYPES.includes(a.type)) assets += a.current_balance;
    else liabilities += a.current_balance;
  }

  // Daily movement, split by which side of the balance sheet it lands on, and
  // only for the account types whose balances transactions actually explain.
  const placeholders = RECONSTRUCTABLE.map(() => '?').join(', ');
  const deltas = db
    .prepare(
      `SELECT t.date,
              SUM(CASE WHEN a.type IN ('checking','savings') THEN t.amount ELSE 0 END) AS asset_delta,
              SUM(CASE WHEN a.type IN ('credit') THEN t.amount ELSE 0 END) AS liability_delta
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.type IN (${placeholders}) AND t.date > ? AND t.date <= ?
       GROUP BY t.date
       ORDER BY t.date DESC`
    )
    .all(...RECONSTRUCTABLE, from, today);

  const deltaByDate = new Map(deltas.map((d) => [d.date, d]));

  // Where stored history takes over from reconstruction. Everything at or after
  // this date is backed by a real snapshot.
  const firstSnapshot = db
    .prepare('SELECT MIN(date(recorded_at)) AS d FROM account_balance_snapshots')
    .get().d;

  const series = [];
  for (let cursor = today; cursor >= from; cursor = previousDay(cursor)) {
    series.push({
      date: cursor,
      net_worth: round2(assets + liabilities),
      assets: round2(assets),
      liabilities: round2(Math.abs(liabilities)),
      reconstructed: !firstSnapshot || cursor < firstSnapshot,
    });

    // Step back over this day's movement to reach the previous day's close.
    const delta = deltaByDate.get(cursor);
    if (delta) {
      assets -= delta.asset_delta;
      liabilities -= delta.liability_delta;
    }
  }

  series.reverse();

  const opening = series[0];
  const closing = series[series.length - 1];

  return {
    window: { from, to: today },
    opening: opening ? opening.net_worth : null,
    closing: closing ? closing.net_worth : null,
    change: opening && closing ? round2(closing.net_worth - opening.net_worth) : null,
    // Named so a reader knows how much of the curve is inference. Investment,
    // property and mortgage balances are flat across the reconstructed span
    // whatever this says — they are held at today's value throughout.
    reconstructed_before: firstSnapshot || null,
    held_flat: ['investment', 'property', 'mortgage'],
    series,
  };
}

function previousDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { currentNetWorth, netWorthHistory, ASSET_TYPES, LIABILITY_TYPES };
