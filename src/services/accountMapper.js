// Maps a SimpleFIN account object onto this app's `accounts` schema.
//
// SimpleFIN provides no account type, so `type` is inferred from the account
// name. That works well for names carrying an explicit keyword ("Mortgage - 1176",
// "PREMIER PLUS CKG") but not for cards branded without one ("Chase Freedom",
// "Rapid Rewards Plus"). Every inference therefore carries a confidence, and
// low-confidence results are meant to be confirmed by a human before they are
// trusted — the same pattern the categorizer uses for AI-assigned categories.

// Ordered most- to least-specific: 'credit card' must beat the bare 'credit'
// rule, and 'mortgage' must be tested before generic loan wording.
const NAME_RULES = [
  { pattern: /\bmortgage\b/i, type: 'mortgage', confidence: 'high' },
  { pattern: /\b(heloc|home equity)\b/i, type: 'loan', confidence: 'high' },
  { pattern: /\b(auto|student|personal)?\s*loan\b/i, type: 'loan', confidence: 'high' },
  { pattern: /\bcredit\s*card\b/i, type: 'credit', confidence: 'high' },
  { pattern: /\bsavings?\b|\bsav\b/i, type: 'savings', confidence: 'high' },
  { pattern: /\bchecking\b|\bckg\b|\bchk\b/i, type: 'checking', confidence: 'high' },
  { pattern: /\b(brokerage|invest|ira|401k|roth)\b/i, type: 'investment', confidence: 'high' },
  // Card brand names carry no type keyword. Common enough to be worth catching,
  // but flagged medium so a human still eyeballs them.
  {
    pattern: /\b(visa|mastercard|amex|american express|freedom|sapphire|rewards|platinum|cash back)\b/i,
    type: 'credit',
    confidence: 'medium',
  },
];

/**
 * Infers an account type from its name, with a balance-shaped fallback.
 *
 * The fallback leans on a SimpleFIN convention visible in real data: liability
 * accounts report a negative `balance` and a zeroed `available-balance`, while
 * deposit accounts report `available-balance` equal to `balance`. It cannot tell
 * a paid-off credit card (0.00 / 0.00) apart from an empty checking account,
 * which is exactly why those land at 'low' confidence.
 */
function inferAccountType(account) {
  const name = account.name || '';

  for (const rule of NAME_RULES) {
    if (rule.pattern.test(name)) {
      return { type: rule.type, confidence: rule.confidence, reason: `name matched ${rule.pattern}` };
    }
  }

  const balance = Number(account.balance);
  const available = Number(account['available-balance']);

  if (Number.isFinite(balance) && balance < 0) {
    return { type: 'credit', confidence: 'medium', reason: 'negative balance implies a liability' };
  }
  if (Number.isFinite(balance) && Number.isFinite(available) && balance > 0 && balance === available) {
    return { type: 'checking', confidence: 'low', reason: 'positive balance equal to available balance' };
  }

  return { type: 'checking', confidence: 'low', reason: 'no signal in name or balances' };
}

/**
 * Converts a SimpleFIN account into the shape the `accounts` table expects.
 * Does not touch the database — pure, so it can be tested and dry-run.
 */
function mapAccount(account) {
  const inferred = inferAccountType(account);
  const balance = Number(account.balance);

  if (!Number.isFinite(balance)) {
    throw new Error(`Account ${account.id} has an unparseable balance: ${account.balance}`);
  }

  return {
    simplefin_id: account.id,
    name: account.name || '(unnamed account)',
    institution: (account.org && (account.org.name || account.org.domain)) || null,
    type: inferred.type,
    type_confidence: inferred.confidence,
    type_reason: inferred.reason,
    // SimpleFIN already signs liabilities negative, so this carries straight
    // through and net worth is a plain SUM over current_balance.
    current_balance: balance,
    currency: account.currency || 'USD',
    balance_date: account['balance-date']
      ? new Date(account['balance-date'] * 1000).toISOString()
      : null,
    source: 'simplefin',
  };
}

module.exports = { mapAccount, inferAccountType };
