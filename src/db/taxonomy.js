// The household's category taxonomy: a two-level tree (group -> category),
// plus the mapping from the hand-written 2025 spreadsheet categories onto it.
//
// Designed from a profile of the real 2025 data (1,614 rows, 72 hand-written
// categories), not invented: every group below carries real weight, and every
// one of the 72 source categories maps somewhere. Three principles shaped it —
//
//   1. Dashboards read the GROUP level. Fourteen groups is scannable;
//      seventy-two is not. The detail lives underneath and rolls up.
//   2. Rental Property is isolated from Housing on purpose. It's a tax
//      boundary (Schedule E wants income, mortgage interest, HOA, repairs and
//      management fees separable), not a stylistic grouping.
//   3. Not everything that moves money is spending. Credit card payments,
//      internal transfers and fee/waiver pairs are real transactions that must
//      not reach budget math — hence `countsAsSpending: false` rather than a
//      naming convention someone has to remember.

// bucket maps onto the brief's four-bucket framework where relevant.
const GROUPS = [
  {
    name: 'Income',
    countsAsSpending: false, // income is tracked, but it isn't "spend"
    children: ["Tony's Paycheck", "Sophia's Paycheck", 'Rental Income', 'Interest & Dividends', 'Reimbursements'],
  },
  {
    name: 'Home & Utilities',
    children: ['Mortgage', 'HOA, Water & Sewer', 'Home Repairs & Maintenance', 'Electricity', 'Gas', 'Internet', 'Mobile Phone'],
  },
  {
    // Kept separate from Home & Utilities for tax reporting (Schedule E).
    name: 'Rental Property',
    children: ['Rental Mortgage', 'Rental HOA', 'Rental Repairs & Maintenance', 'Rental Management Fee'],
  },
  {
    name: 'Childcare & Education',
    children: ['Childcare', 'Kids — Other'],
  },
  {
    name: 'Food',
    children: ['Groceries', 'Dining Out', 'Coffee'],
  },
  {
    name: 'Transportation',
    children: ['Auto Loan', 'Gasoline', 'Auto Insurance', 'Registration & Fees', 'Vehicle Maintenance', 'Tolls'],
  },
  {
    // Top-level by request and by weight: $13.5k across 112 transactions in
    // 2025, more than groceries. Spans green fees, gear, coaching and range
    // time, which would otherwise scatter across three other groups.
    name: 'Golf',
    children: ['Green Fees', 'Driving Range', 'Golf Gear', 'Golf Coaching'],
  },
  {
    name: 'Shopping',
    children: ['General & Household', 'Home & Furniture', 'Electronics & Hobby', 'Clothing'],
  },
  {
    name: 'Health & Personal',
    children: ['Medical', 'Pharmacy', 'Haircut', 'Vape', 'Pet'],
  },
  {
    name: 'Entertainment & Travel',
    children: ['Activities', 'Subscriptions', 'Travel'],
  },
  {
    name: 'Giving & Family Support',
    children: ['Family Support', 'Gifts', 'Donations'],
  },
  {
    name: 'Financial & Professional',
    children: ['Taxes', 'Professional Licenses', 'Insurance', 'Bank & Transfer Fees', 'Card Annual Fees'],
  },
  {
    // NOT spending, revised 2026-08-17. It was counted as spending on the
    // "pay yourself first" argument — a contribution claims money just as a
    // bill does, so a month shouldn't look affordable once the 529 payment has
    // taken its share. That argument is about *budgeting* a contribution, which
    // still works: budgets are per-category, so a monthly 529 or Roth target is
    // set and tracked exactly like any other, independent of this flag.
    //
    // What the flag governs is whether an outflow counted as consumption, and a
    // contribution isn't: it converts cash into an asset the household still
    // owns, leaving net worth unchanged. Structurally it is a transfer, and once
    // the destination is tracked it nets to zero against the receiving account
    // the same way the Chase -> Ally moves do.
    //
    // The 2026 data forced the issue: $61,500 went to Vanguard in February.
    // Counted as spending, that reads as a catastrophic month and a savings rate
    // of zero. Net worth is understated by that amount either way until Vanguard
    // is linked — so counting it as spending fixes nothing and corrupts the
    // spending view too.
    name: 'Savings & Investments',
    countsAsSpending: false,
    children: [
      { name: 'Retirement Contributions', bucket: 'retirement' },
      { name: 'Investment Contributions', bucket: 'investment' },
      { name: 'College Fund (529)', bucket: 'college_fund' },
      { name: 'Emergency Fund', bucket: 'emergency_fund' },
    ],
  },
  {
    // Real transactions that must never reach budget math.
    name: 'Transfers & Non-Spending',
    countsAsSpending: false,
    children: ['Credit Card Payment', 'Internal Transfer', 'Bank Fee & Waiver', 'Card Credits & Rebates'],
  },
  {
    // The categorizer's escape hatch, and where anything unmatched lands. A
    // group with no children so it is still assignable.
    name: 'Uncategorized',
    children: [],
  },
];

// Every one of the 72 spreadsheet categories -> a leaf above.
// Keys are lower-cased and whitespace-collapsed at lookup, which absorbs the
// case variants in the source data ("Dining out"/"Dining Out", "SHopping",
// three spellings of "Credit Card Balance Payment", "Medical Bill"/"Medical
// bill", "Car registration"/"Car Registration").
const CATEGORY_MAP = {
  // Income
  "tony's paycheck direct deposit": "Tony's Paycheck",
  'payroll direct deposit': "Tony's Paycheck", // the $500/mo split to US Bank
  "sophia's payroll direct deposit": "Sophia's Paycheck",
  'rental income': 'Rental Income',
  'interest payment received': 'Interest & Dividends',
  'savings interest income': 'Interest & Dividends',
  'remote check deposit': 'Reimbursements',
  'insurance refund': 'Reimbursements',
  'mobile family plan': 'Reimbursements', // payback from plan participants

  // Home & Utilities
  'primary home mortgage payment': 'Mortgage',
  'primary home hoa/water/sewer': 'HOA, Water & Sewer',
  'primary home hoa assessment fee': 'HOA, Water & Sewer',
  'primary home hoa assessment & trash service': 'HOA, Water & Sewer',
  'primary home r&m': 'Home Repairs & Maintenance',
  electricity: 'Electricity',
  'house gas bill': 'Gas',
  internet: 'Internet',
  'mobile family plan payment': 'Mobile Phone',

  // Rental Property
  'rental property mortgage payment': 'Rental Mortgage',
  'rental property hoa payment': 'Rental HOA',
  'rental property repair and maintainence': 'Rental Repairs & Maintenance',
  'rental property r&m expense': 'Rental Repairs & Maintenance',
  'rental property management fee': 'Rental Management Fee',

  // Childcare & Education
  childcare: 'Childcare',
  "mia's birth certificate support doc": 'Kids — Other',

  // Food
  grocery: 'Groceries',
  'dining out': 'Dining Out',
  food: 'Dining Out',

  // Transportation
  'auto loan': 'Auto Loan',
  'car gasoline': 'Gasoline',
  'auto gasoline': 'Gasoline',
  'auto insurance': 'Auto Insurance',
  'car registration': 'Registration & Fees',
  misc: 'Registration & Fees', // sole row is a driver's licence renewal
  automobile: 'Vehicle Maintenance',

  // Golf — refined further by User_Notes at import time (see NOTE_REFINEMENTS)
  golf: 'Green Fees',

  // Shopping — refined further by User_Notes at import time
  shopping: 'General & Household',
  appliance: 'Home & Furniture',
  'camera gear': 'Electronics & Hobby',

  // Health & Personal
  'medical bill': 'Medical',
  phamacy: 'Pharmacy',
  haircut: 'Haircut',
  'hair cut': 'Haircut',
  'haircut & vape': 'Haircut', // mixed row; flagged on import
  vape: 'Vape',
  pet: 'Pet',
  'pet insurance': 'Pet',

  // Entertainment & Travel
  activities: 'Activities',
  subscription: 'Subscriptions',
  'subscription (need further context)': 'Subscriptions',
  travel: 'Travel',

  // Giving & Family Support
  'family support': 'Family Support',
  gift: 'Gifts',
  donations: 'Donations',

  // Financial & Professional
  'tax return': 'Taxes',
  'cpa license': 'Professional Licenses',
  'cpa reinstatement': 'Professional Licenses',
  insurance: 'Insurance',
  fee: 'Bank & Transfer Fees',
  'credit card annual fee': 'Card Annual Fees',

  // Savings & Investments
  '529 plan education fund contribution': 'College Fund (529)',
  'vanguard investment account': 'Investment Contributions',

  // Transfers & Non-Spending
  'credit card balance payment': 'Credit Card Payment',
  transfer: 'Internal Transfer',
  'us bank monthly maintainence fee & waive': 'Bank Fee & Waiver',
  'credit card travel credit': 'Card Credits & Rebates',
};

// Where one source category covers several real activities, the User_Notes
// column separates them — this is the payoff for a year of hand-written notes.
// First matching pattern wins; no match keeps the CATEGORY_MAP result.
const NOTE_REFINEMENTS = {
  golf: [
    [/gear/i, 'Golf Gear'],
    [/coach/i, 'Golf Coaching'],
    [/driving range/i, 'Driving Range'],
    [/course/i, 'Green Fees'],
  ],
  shopping: [
    [/furniture|ikea/i, 'Home & Furniture'],
    [/video game|computer parts|camera|monitor|electronic|tv\b/i, 'Electronics & Hobby'],
  ],
  'dining out': [[/coffee|starbucks/i, 'Coffee']],
  travel: [[/toll/i, 'Tolls']],
  // Most "Transfer" rows are genuine account-to-account moves. The one-off
  // $10,000 to the 529 is not — that money left the household, so it belongs
  // with the other college-fund contributions rather than netting to nothing.
  transfer: [[/529/i, 'College Fund (529)']],
};

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Resolve a spreadsheet category (+ optional note) to a leaf category name. */
function resolveCategory(sourceCategory, note) {
  const key = normalize(sourceCategory);
  const base = CATEGORY_MAP[key] || null;

  const refinements = NOTE_REFINEMENTS[key];
  if (refinements && note) {
    for (const [pattern, leaf] of refinements) {
      if (pattern.test(note)) return leaf;
    }
  }
  return base;
}

/** Flat list of {group, name, bucket, countsAsSpending} for seeding. */
function flatten() {
  const out = [];
  for (const group of GROUPS) {
    const countsAsSpending = group.countsAsSpending !== false;
    out.push({ group: null, name: group.name, bucket: 'other', countsAsSpending, isGroup: true });
    for (const child of group.children) {
      const c = typeof child === 'string' ? { name: child } : child;
      out.push({ group: group.name, name: c.name, bucket: c.bucket || 'other', countsAsSpending, isGroup: false });
    }
  }
  return out;
}

/** The group a leaf belongs to. */
function groupOf(leafName) {
  for (const group of GROUPS) {
    for (const child of group.children) {
      const name = typeof child === 'string' ? child : child.name;
      if (name === leafName) return group.name;
    }
  }
  return null;
}

module.exports = { GROUPS, CATEGORY_MAP, NOTE_REFINEMENTS, resolveCategory, flatten, groupOf, normalize };
