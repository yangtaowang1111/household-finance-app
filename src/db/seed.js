const db = require('./index');

// Four-bucket framework (savings/investment allocations) + everyday spending categories.
const DEFAULT_CATEGORIES = [
  { name: 'Retirement Contributions', bucket: 'retirement' },
  { name: 'Investment Contributions', bucket: 'investment' },
  { name: 'College Fund Contributions', bucket: 'college_fund' },
  { name: 'Emergency Fund Contributions', bucket: 'emergency_fund' },

  { name: 'Housing', bucket: 'other' },
  { name: 'Utilities', bucket: 'other' },
  { name: 'Groceries', bucket: 'other' },
  { name: 'Dining Out', bucket: 'other' },
  { name: 'Transportation', bucket: 'other' },
  { name: 'Insurance', bucket: 'other' },
  { name: 'Healthcare', bucket: 'other' },
  { name: 'Subscriptions', bucket: 'other' },
  { name: 'Entertainment', bucket: 'other' },
  { name: 'Shopping', bucket: 'other' },
  { name: 'Personal Care', bucket: 'other' },
  { name: 'Travel', bucket: 'other' },
  { name: 'Kids', bucket: 'other' },
  { name: 'Gifts & Donations', bucket: 'other' },
  { name: 'Income', bucket: 'other' },
  { name: 'Transfers', bucket: 'other' },
  { name: 'Uncategorized', bucket: 'other' },
];

function seedCategories() {
  const insert = db.prepare('INSERT INTO categories (name, bucket) VALUES (?, ?)');
  const existing = db.prepare('SELECT COUNT(*) AS count FROM categories').get();
  if (existing.count > 0) {
    console.log('Categories already seeded, skipping.');
    return;
  }
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row.name, row.bucket);
  });
  insertMany(DEFAULT_CATEGORIES);
  console.log(`Seeded ${DEFAULT_CATEGORIES.length} categories.`);
}

if (require.main === module) {
  seedCategories();
}

module.exports = { seedCategories, DEFAULT_CATEGORIES };
