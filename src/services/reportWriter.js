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

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 4000;

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

  const response = await client.messages.create({
    model: MODEL,
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
    model: MODEL,
    // Recorded so the cost of a habit is visible rather than a surprise on the
    // bill.
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

module.exports = { writeReport, SYSTEM, MODEL };
