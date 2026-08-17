const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const MODEL = 'claude-sonnet-5';
const BATCH_SIZE = 25;

// A batch of 25 answers is only ~600 tokens, but 2000 still truncated responses
// mid-object on the 2026-08-17 run — the model's reasoning is drawn from the
// same allowance as its output. Output tokens are billed as generated, not as
// reserved, so a ceiling this high costs nothing until it is used.
const MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500; // hard cap regardless of caller input — bounds Claude API cost per call

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

// Matched against both the cleaned payee and the raw bank descriptor. A rule
// learned as "McDonald's" isn't a substring of "McDonalds 21389" (apostrophe),
// and one learned from a descriptor isn't a substring of the payee — checking
// both means a rule keeps matching whichever field a later transaction carries.
function findRuleMatch(rules, txn) {
  const haystacks = [txn.payee, txn.merchant_raw]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  if (haystacks.length === 0) return null;

  return (
    rules.find((rule) => {
      const pattern = rule.merchant_pattern.toLowerCase();
      return haystacks.some((haystack) => haystack.includes(pattern));
    }) || null
  );
}

// SimpleFIN's `payee` is a cleaned merchant name ("Chick-fil-A") next to a raw
// descriptor carrying store numbers and terminal prefixes ("CHICK-FIL-A #02479",
// "TST*THE LITTLE DINER"). Learning a rule from the descriptor produces a
// pattern that only ever matches that one store, so every branch of the same
// chain costs another API call. Prefer the payee; fall back to the descriptor
// for CSV and manual rows, which have no payee.
function rulePatternFor(txn) {
  if (!txn) return null;

  // Usually the payee generalises better. But SimpleFIN sometimes reduces it to
  // a bare product name that identifies nothing — an incoming Chase Zelle
  // arrives with payee "Zelle Transfer" while the descriptor still carries
  // "Zelle payment from XINPEI FU". Learning from the payee there would write a
  // rule matching every Zelle transaction in the ledger.
  //
  // So a payee is only preferred when it says more than the generic label does.
  // This is a guard, not a substitute for reading the pattern before saving it:
  // the editor shows it and lets it be changed, because no heuristic knows
  // which part of a descriptor is the part that repeats.
  const payee = txn.payee || '';
  const descriptor = txn.merchant_raw || '';
  if (payee && GENERIC_PAYEES.test(payee.trim())) return descriptor || payee || null;
  return payee || descriptor || null;
}

// Payees that name a payment rail rather than a counterparty.
const GENERIC_PAYEES = /^(zelle transfer|quickpay|ach (debit|credit)|online transfer|external transfer|wire transfer|check|atm withdrawal)$/i;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * Reads the model's answer, salvaging what it can from a malformed one.
 *
 * A response cut off by the token limit ends mid-object, which makes the whole
 * array unparseable — including the twenty-odd complete answers before the cut.
 * Those are perfectly good, so they are recovered rather than thrown away with
 * the broken tail. Returns null only when nothing usable came back.
 */
const isUsableAnswer = (entry) => Boolean(entry && entry.id != null && entry.category_name);

function parseResults(text) {
  let entries = null;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // Fall through to salvage.
  }

  if (!entries) {
    entries = [];
    for (const fragment of text.match(/\{[^{}]*\}/g) || []) {
      try {
        entries.push(JSON.parse(fragment));
      } catch {
        // A partial object at the cut point — expected, and the reason for this.
      }
    }
  }

  // The same test whichever route got us here, so a well-formed response
  // carrying a useless entry is treated exactly like a salvaged one.
  const usable = entries.filter(isUsableAnswer);
  return usable.length ? usable : null;
}

async function categorizeBatch(transactions, categories, systemPrompt) {
  const userContent = JSON.stringify(
    transactions.map((t) => ({
      id: t.id,
      // Both, when available: the payee is easier to recognise, the raw
      // descriptor sometimes carries the only useful signal (a "TST*" prefix
      // marks a restaurant POS, "PPD ID" an ACH debit).
      merchant: t.payee || t.merchant_raw,
      descriptor: t.merchant_raw,
      amount: t.amount,
    }))
  );

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const results = parseResults(text);
  if (!results) {
    const hint = response.stop_reason === 'max_tokens' ? ' (response hit the token limit)' : '';
    throw new Error(`Failed to parse categorization response as JSON${hint}: ${text.slice(0, 300)}`);
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
async function categorizeUncategorized(limit = DEFAULT_LIMIT) {
  // Clamped at both ends. A negative limit is truthy, so it would slip past the
  // `|| DEFAULT_LIMIT` fallback and past Math.min — and SQLite reads a negative
  // LIMIT as unbounded, sending the entire backlog to the Claude API in
  // 25-row batches. That is the exact cost exposure MAX_LIMIT exists to stop.
  const requested = Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT;
  const cappedLimit = Math.max(1, Math.min(requested, MAX_LIMIT));
  const categories = db.prepare('SELECT id, name, bucket FROM categories').all();
  const rules = db.prepare(`
    SELECT cr.merchant_pattern, cr.always_review, c.id AS category_id, c.name
    FROM categorization_rules cr JOIN categories c ON c.id = cr.category_id
  `).all();
  const uncategorized = db.prepare(`
    SELECT id, merchant_raw, payee, amount FROM transactions
    WHERE category_id IS NULL
    LIMIT ?
  `).all(cappedLimit);

  if (uncategorized.length === 0) return { ruleMatched: 0, aiCategorized: 0, needsReview: 0, rulesLearned: 0 };

  // `categorized_by` records how each answer was reached. A wrong AI guess is
  // one bad row; a wrong rule is every future transaction from that merchant.
  // The review screen cannot tell those apart without this.
  const updateByRule = db.prepare(
    "UPDATE transactions SET category_id = ?, categorized_by = 'rule', needs_review = ? WHERE id = ?"
  );
  const updateByAi = db.prepare(
    "UPDATE transactions SET category_id = ?, categorized_by = 'ai', needs_review = 0 WHERE id = ?"
  );
  // Low confidence sets the flag rather than writing a sentence into `notes`.
  // Notes belong to the user; this is a state the system is in.
  const updateByAiUnsure = db.prepare(
    "UPDATE transactions SET category_id = ?, categorized_by = 'ai', needs_review = 1 WHERE id = ?"
  );
  const upsertRule = db.prepare(`
    INSERT INTO categorization_rules (merchant_pattern, category_id)
    VALUES (?, ?)
    ON CONFLICT(merchant_pattern) DO UPDATE SET category_id = excluded.category_id
  `);

  const remaining = [];
  let ruleMatched = 0;
  for (const txn of uncategorized) {
    const rule = findRuleMatch(rules, txn);
    if (rule) {
      updateByRule.run(rule.category_id, rule.always_review ? 1 : 0, txn.id);
      ruleMatched += 1;
    } else {
      remaining.push(txn);
    }
  }

  const systemPrompt = buildSystemPrompt(categories);
  let aiCategorized = 0;
  let needsReview = 0;
  let rulesLearned = 0;

  const failures = [];

  for (const batch of chunk(remaining, BATCH_SIZE)) {
    const txnById = new Map(batch.map((t) => [t.id, t]));

    // Contained per batch on purpose. A single unparseable response used to
    // throw out of this loop and abandon every batch behind it — on the
    // 2026-08-17 run that stranded 96 transactions when only about 50 were
    // actually affected. Nothing here is lost by continuing: the rows keep
    // category_id NULL and the next run picks them up.
    let results;
    try {
      results = await categorizeBatch(batch, categories, systemPrompt);
    } catch (err) {
      failures.push({ size: batch.length, error: err.message.slice(0, 200) });
      continue;
    }

    for (const result of results) {
      if (!result.category) continue;
      if (result.confidence === 'low') {
        updateByAiUnsure.run(result.category.id, result.id);
        needsReview += 1;
      } else {
        updateByAi.run(result.category.id, result.id);

        // Learn a rule so the next transaction from this merchant skips the API call.
        const pattern = rulePatternFor(txnById.get(result.id));
        if (pattern && result.category.name !== 'Uncategorized') {
          upsertRule.run(pattern, result.category.id);
          rulesLearned += 1;
        }
      }
      aiCategorized += 1;
    }
  }

  return {
    ruleMatched,
    aiCategorized,
    needsReview,
    rulesLearned,
    // Surfaced rather than swallowed: a batch that failed leaves its rows
    // uncategorized, and a caller that sees only the successes would read a
    // partial run as a complete one.
    failedBatches: failures.length,
    failedTransactions: failures.reduce((n, f) => n + f.size, 0),
    failures,
  };
}

module.exports = { categorizeUncategorized, findRuleMatch, rulePatternFor, parseResults };
