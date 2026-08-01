const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const MODEL = 'claude-sonnet-5';
const BATCH_SIZE = 25;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(categories) {
  const list = categories.map((c) => `- ${c.name} (bucket: ${c.bucket})`).join('\n');
  return `You are a personal finance transaction categorizer for a household budgeting app.
Assign each transaction to exactly one of the following categories:
${list}

Rules:
- Use "Uncategorized" only when nothing else plausibly fits.
- Judge confidence based on how clearly the merchant/amount maps to a category.
- Respond with ONLY a JSON array, no prose, matching this shape:
[{"id": <transaction id>, "category_name": "<exact category name>", "confidence": "high"|"medium"|"low"}]`;
}

function findRuleMatch(rules, merchant) {
  if (!merchant) return null;
  const lower = merchant.toLowerCase();
  return rules.find((r) => lower.includes(r.merchant_pattern.toLowerCase())) || null;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function categorizeBatch(transactions, categories, systemPrompt) {
  const userContent = JSON.stringify(
    transactions.map((t) => ({ id: t.id, merchant: t.merchant_raw, amount: t.amount }))
  );

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  let results;
  try {
    results = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse categorization response as JSON: ${text}`);
  }

  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  return results.map((r) => ({
    id: r.id,
    confidence: r.confidence,
    category: byName.get(String(r.category_name).toLowerCase()) || null,
  }));
}

/**
 * Categorizes up to `limit` transactions with no category_id set.
 * Merchant-pattern rules (categorization_rules) are checked before any API call.
 * Low-confidence AI guesses are still applied, but flagged in `notes` for review.
 * Non-low-confidence AI results are written back as new rules, so the same
 * merchant skips the API on future runs.
 */
async function categorizeUncategorized(limit = 200) {
  const categories = db.prepare('SELECT id, name, bucket FROM categories').all();
  const rules = db.prepare(`
    SELECT cr.merchant_pattern, c.id AS category_id, c.name
    FROM categorization_rules cr JOIN categories c ON c.id = cr.category_id
  `).all();
  const uncategorized = db.prepare(`
    SELECT id, merchant_raw, amount FROM transactions
    WHERE category_id IS NULL
    LIMIT ?
  `).all(limit);

  if (uncategorized.length === 0) return { ruleMatched: 0, aiCategorized: 0, needsReview: 0, rulesLearned: 0 };

  const updateCategory = db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?');
  const updateCategoryWithNote = db.prepare(
    "UPDATE transactions SET category_id = ?, notes = ? WHERE id = ?"
  );
  const upsertRule = db.prepare(`
    INSERT INTO categorization_rules (merchant_pattern, category_id)
    VALUES (?, ?)
    ON CONFLICT(merchant_pattern) DO UPDATE SET category_id = excluded.category_id
  `);

  const remaining = [];
  let ruleMatched = 0;
  for (const txn of uncategorized) {
    const rule = findRuleMatch(rules, txn.merchant_raw);
    if (rule) {
      updateCategory.run(rule.category_id, txn.id);
      ruleMatched += 1;
    } else {
      remaining.push(txn);
    }
  }

  const systemPrompt = buildSystemPrompt(categories);
  let aiCategorized = 0;
  let needsReview = 0;
  let rulesLearned = 0;

  for (const batch of chunk(remaining, BATCH_SIZE)) {
    const merchantById = new Map(batch.map((t) => [t.id, t.merchant_raw]));
    const results = await categorizeBatch(batch, categories, systemPrompt);
    for (const result of results) {
      if (!result.category) continue;
      if (result.confidence === 'low') {
        updateCategoryWithNote.run(result.category.id, 'AI confidence: low — please review', result.id);
        needsReview += 1;
      } else {
        updateCategory.run(result.category.id, result.id);

        // Learn a rule so the next transaction from this merchant skips the API call.
        const merchant = merchantById.get(result.id);
        if (merchant && result.category.name !== 'Uncategorized') {
          upsertRule.run(merchant, result.category.id);
          rulesLearned += 1;
        }
      }
      aiCategorized += 1;
    }
  }

  return { ruleMatched, aiCategorized, needsReview, rulesLearned };
}

module.exports = { categorizeUncategorized };
