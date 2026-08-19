// Turns a period's figures into a written review.
//
// The model is given only the assembled summary from reportData.js — around 600
// tokens of already-reconciled figures — and never the transaction ledger. That
// is a quality decision before it is a cost one: given raw rows, a model spends
// its attention checking arithmetic that SQLite already did, and has less left
// for the thing it is actually better at.
//
// What it is actually better at is noticing that a number is arithmetically
// correct and factually wrong. "Childcare is forecast flat, but your youngest
// starts school in March" is not something a rule will ever produce, and it is
// worth more than any amount of restating the totals back.
//
// Opus rather than the categoriser's Sonnet. A measured run costs about 7c --
// 2,661 tokens in, 2,535 out, most of the latter being thinking. At one review
// a month that is under a dollar a year, and judgement is the entire point of
// the feature. Sonnet would be roughly a fifth the price and would restate the
// figures more and question them less; the questioning is what is being bought.

const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 4000;

// Opus at roughly 7c a review, Sonnet at roughly a fifth of that. The
// difference bought is questioning rather than restating -- Opus spotted that
// the July net worth drop was overstated by held-flat mortgage balances, which
// is the kind of observation the feature exists for. But once a month is a
// habit and the choice should sit with whoever pays for it.
const MODELS = ['claude-opus-5', 'claude-sonnet-5'];

const SYSTEM = `You are reviewing a household's finances for one period. You are given a compact summary of already-reconciled figures — not the underlying transactions.

Write for two people who know their own situation well. Be direct and specific. Use their actual numbers.

Cover, in this order, and only where there is something worth saying:

1. **What happened** — two or three sentences on the period. Lead with what changed, not what stayed the same.
2. **What deserves attention** — anything overspent, off pace, or moving in a direction that compounds. Rank by how much money is involved, not how alarming it sounds.
3. **What looks right but may not be** — the most valuable part. A figure can be arithmetically correct and factually wrong: a forecast that assumes a cost continues when it is about to stop, income projected from a job that ended, a category flat only because data is missing. The caveats list names known gaps; use it, and reason beyond it.
4. **One or two things worth doing** — concrete, and only if genuinely warranted. "Nothing needs doing" is a legitimate and useful answer.

Rules:
- **household_context, where present, is fact.** It holds what the ledger cannot: a job ending, a cost about to stop, a payment already expected. Prefer it over anything you would infer from the numbers, and say when it changes the reading of a figure.
- household_context has two parts. \`always_true\` holds durable facts that apply to every period. \`by_month\` holds notes pinned to specific months of this year, up to and including the one under review — the ones from earlier months are there for continuity, so use them to explain how the period came about rather than reporting them as news. \`what_is_coming\` is the note for the month AFTER this one, which has not happened yet: use it to say what this period's position means for what follows, and never report it as something that occurred.
- Never invent a figure. If something is not in the summary, say it is not known rather than estimating it.
- Investment gains are never income. A balance change is not a cash flow.
- Do not moralise about spending. Golf and dining out are choices, not failures.
- Do not give investment, tax or legal advice. Describe what the numbers show and what might be worth checking; leave decisions to them.
- No preamble. Start with the substance.

Format as markdown with those four headings. Keep it under 500 words — this is read monthly, and length is not thoroughness.`;

/**
 * @param {object} data  the output of reportData()
 * @param {object} [options]
 * @param {string} [options.apiKey]
 */
async function writeReport(data, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so no review can be generated.');
    err.missingKey = true;
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const model = MODELS.includes(options.model) ? options.model : DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // Adaptive rather than a token budget: this is exactly the kind of judgement
    // call worth thinking about, and the summary is small enough that thinking
    // costs little.
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Review this period.\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('The model returned no review text.');

  return {
    text,
    model,
    // Recorded so the cost of a habit is visible rather than a surprise on the
    // bill.
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

const PLAN_SYSTEM = `You are writing a short planning brief for a household, for a month that has not happened yet. You are given what the month cost a year ago, what the last three months have averaged, the budget set for it, whatever is currently overspending, and any notes the household has already written about the month ahead.

This is not a review. Nothing has happened yet. Do not report figures as though they have.

Cover, in this order:

1. **What this month usually costs** — how it compares to a normal month, and which groups drive the difference. Name the amounts.
2. **What is running hot now** — anything currently over budget or off pace. A category overspending this month tends to keep doing so, and that is the actionable part.
3. **What to watch** — the overlap between those two lists is the sharpest signal: a category that is expensive in this month historically AND running hot right now. Say so explicitly where it applies.
4. **Already known** — anything in household_context about the month ahead, and what it means for the figures above.

Rules:
- Everything here is a projection. Write in terms of what is likely or worth watching, never what happened.
- Never invent a figure. If something is not in the data, say it is not known.
- Do not moralise about spending. This is preparation, not judgement.
- Do not give investment, tax or legal advice.
- No preamble. Under 400 words — this is read before a month starts, and length is not usefulness.

Format as markdown with those four headings.`;

/**
 * A forward-looking brief for a month that has not happened.
 *
 * @param {object} data  the output of planData()
 */
async function writePlan(data, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so no brief can be generated.');
    err.missingKey = true;
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const model = MODELS.includes(options.model) ? options.model : DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: 'adaptive' },
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: `Brief us on the month ahead.

${JSON.stringify(data, null, 2)}` }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('The model returned no brief.');

  return {
    text,
    model,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  };
}

module.exports = { writeReport, writePlan, SYSTEM, PLAN_SYSTEM, DEFAULT_MODEL, MODELS };
