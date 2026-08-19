const express = require('express');
const db = require('../db');
const { reportData, planData } = require('../services/reportData');
const { writeReport, writePlan, MODELS, DEFAULT_MODEL } = require('../services/reportWriter');

const router = express.Router();

const shape = (row) => ({ ...row, data: JSON.parse(row.data) });

// Past reviews, newest first. Bodies included: they are a few hundred words
// each and the list is short by construction — one a month.
router.get('/', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 24, 100));
  res.json(
    db.prepare('SELECT * FROM reports ORDER BY period_from DESC, kind LIMIT ?').all(limit).map(shape)
  );
});

// The figures for a period without spending an API call. Useful on its own, and
// it is what the review would be written from.
router.get('/preview', (req, res) => {
  try {
    res.json(reportData(parsePeriod(req.query)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The figures behind a plan, without spending anything.
router.get('/plan/preview', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = req.query.month ? Number(req.query.month) : undefined;
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return res.status(400).json({ error: 'month must be 1-12' });
  }
  res.json(planData({ year, month }));
});

// A brief for a month that has not happened. Stored as kind 'plan' so it never
// collides with the review of the same month written afterwards -- the two are
// different documents about one period, and comparing them later is the
// interesting part.
router.post('/plan', async (req, res) => {
  const year = Number(req.body && req.body.year) || new Date().getFullYear();
  const month = req.body && req.body.month ? Number(req.body.month) : undefined;
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return res.status(400).json({ error: 'month must be 1-12' });
  }

  const data = planData({ year, month });
  let written;
  try {
    const chosen = db.prepare("SELECT value FROM settings WHERE key = 'report_model'").get();
    written = await writePlan(data, { model: chosen && chosen.value });
  } catch (err) {
    return res.status(err.missingKey ? 400 : 502).json({ error: err.message });
  }

  db.prepare(
    `INSERT INTO reports (period_label, period_from, period_to, kind, body, data, model, input_tokens, output_tokens)
     VALUES (@label, @from, @to, 'plan', @body, @data, @model, @input_tokens, @output_tokens)
     ON CONFLICT(period_from, kind) DO UPDATE SET
       body = excluded.body, data = excluded.data, model = excluded.model,
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       created_at = datetime('now')`
  ).run({
    label: `Plan for ${data.planning_for.label}`,
    from: data.planning_for.from,
    to: data.planning_for.to,
    body: written.text,
    data: JSON.stringify(data),
    model: written.model,
    input_tokens: written.usage.input_tokens,
    output_tokens: written.usage.output_tokens,
  });

  res.json(shape(db.prepare("SELECT * FROM reports WHERE period_from = ? AND kind = 'plan'").get(data.planning_for.from)));
});

router.post('/', async (req, res) => {
  let period;
  try {
    period = parsePeriod(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const data = reportData(period);
  const kind = period.quarter ? 'quarter' : 'month';

  // Regenerating replaces the stored review rather than adding a second one for
  // the same period — two reviews of one month is a question, not a record.
  const existing = db
    .prepare('SELECT id FROM reports WHERE period_from = ? AND kind = ?')
    .get(data.period.from, kind);
  if (existing && !req.body.replace) {
    return res.status(409).json({
      error: `A ${kind} review already exists for ${data.period.label}. Send replace: true to regenerate it.`,
      report_id: existing.id,
    });
  }

  let written;
  try {
    // Whichever model the household has chosen to pay for.
    const chosen = db.prepare("SELECT value FROM settings WHERE key = 'report_model'").get();
    written = await writeReport(data, { model: chosen && chosen.value });
  } catch (err) {
    // A missing key is a setup problem, not a server fault, and says so.
    return res.status(err.missingKey ? 400 : 502).json({ error: err.message });
  }

  db.prepare(
    `INSERT INTO reports (period_label, period_from, period_to, kind, body, data, model, input_tokens, output_tokens)
     VALUES (@label, @from, @to, @kind, @body, @data, @model, @input_tokens, @output_tokens)
     ON CONFLICT(period_from, kind) DO UPDATE SET
       body = excluded.body, data = excluded.data, model = excluded.model,
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       created_at = datetime('now')`
  ).run({
    label: data.period.label,
    from: data.period.from,
    to: data.period.to,
    kind,
    body: written.text,
    data: JSON.stringify(data),
    model: written.model,
    input_tokens: written.usage.input_tokens,
    output_tokens: written.usage.output_tokens,
  });

  res.json(shape(db.prepare('SELECT * FROM reports WHERE period_from = ? AND kind = ?').get(data.period.from, kind)));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'report not found' });
  res.status(204).end();
});

function parsePeriod(source) {
  const year = Number(source.year) || new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('year must be a four-digit year');

  if (source.quarter) {
    const quarter = Number(source.quarter);
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('quarter must be 1-4');
    return { year, quarter };
  }
  const month = Number(source.month) || new Date().getMonth() || 12;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month must be 1-12');
  return { year, month };
}

module.exports = router;
