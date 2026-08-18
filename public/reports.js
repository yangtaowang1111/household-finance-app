/* Reports. Generate a period review, read it, and keep the ones already
   written.
 *
 * "Show the figures" exists because the summary is the whole quality decision:
 * if something important is missing from it, the review cannot recover, and
 * checking costs nothing. */

let kind = 'month';
let history = [];
let notes = [];

/* A very small markdown renderer — headings, bold, italics, lists, code.
   Enough for what the model is asked to produce, and worth 30 lines to avoid a
   dependency on a page that already loads no libraries. Input is escaped first,
   so nothing in a report body can inject markup. */
function markdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let inList = false;

  const inline = (t) =>
    t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

/* Every period is listed, finished or not.
 *
 * Reviewing an unfinished period is misleading — its comparisons are against a
 * partial figure — but WRITING A NOTE about one is not, and noting next month
 * in advance is much of the point: "new salary starts, and a one-time bonus
 * arrives" is worth recording before it happens, not after. So the list is
 * complete and only the review is gated. */
function periodOptions() {
  const year = Number($('year').value);
  const values = kind === 'quarter' ? [4, 3, 2, 1] : Array.from({ length: 12 }, (_, i) => 12 - i);

  return values
    .map((v) => {
      const label =
        kind === 'quarter'
          ? `Q${v}`
          : new Date(2000, v - 1, 1).toLocaleDateString('en-US', { month: 'long' });
      return `<option value="${v}">${label}${isComplete(year, v) ? '' : ' — not finished'}</option>`;
    })
    .join('');
}

/** Whether a period has actually ended. */
function isComplete(year, value) {
  const now = new Date();
  const lastMonth = kind === 'quarter' ? value * 3 : value;
  if (year < now.getFullYear()) return true;
  if (year > now.getFullYear()) return false;
  return lastMonth < now.getMonth() + 1;
}

/** Gates the review on the period being over; the note editor never is. */
function updateGate() {
  const year = Number($('year').value);
  const complete = isComplete(year, Number($('period').value));

  $('generate').disabled = !complete;
  $('preview').disabled = !complete;
  $('gate-note').hidden = complete;
  $('gate-note').textContent = complete
    ? ''
    : 'This period has not finished, so there is nothing to review yet — every comparison would be against a partial figure. You can still write its note now.';
}

function periodParams() {
  const year = Number($('year').value);
  const value = Number($('period').value);
  return kind === 'quarter' ? { year, quarter: value } : { year, month: value };
}

function query(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

/* --- rendering ------------------------------------------------------------ */

function renderFigures(d) {
  const cf = d.cash_flow;
  const row = (label, value, sub) =>
    `<div class="row"><div><span class="label">${label}</span>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <span class="v num">${value}</span></div>`;

  $('preview-out').innerHTML = `
    <div style="margin-top:14px">
      <div class="eyebrow" style="margin-bottom:8px">${escapeHtml(d.period.label)} · what the review is given</div>
      <div class="grid-2" style="gap:0 26px">
        <div>
          ${row('Income', money(cf.income), cf.prior_year.income ? `${money(cf.prior_year.income)} a year earlier` : '')}
          ${row('Spending', money(cf.spending), cf.prior_year.spending ? `${money(cf.prior_year.spending)} a year earlier` : '')}
          ${row('Surplus', money(cf.surplus), `savings rate ${cf.savings_rate_percent === null ? '—' : cf.savings_rate_percent + '%'}`)}
          ${row('Net worth', money(d.net_worth.total), d.net_worth.change_this_period === null ? '' : `${money(d.net_worth.change_this_period, { showPlus: true })} this period`)}
        </div>
        <div>
          ${row('Budgeted', money(d.budget.budgeted), '')}
          ${row('Actual', money(d.budget.actual), d.budget.used_percent === null ? '' : `${d.budget.used_percent}% used`)}
          ${row('Forecast year end', money(d.forecast.year_end_spending), `${money(d.forecast.variance, { showPlus: true })} vs budget`)}
          ${row('Unbudgeted', money(d.budget.unbudgeted_spending), '')}
        </div>
      </div>

      ${d.biggest_changes_vs_last_year.length ? `
        <div class="eyebrow" style="margin:16px 0 6px">Biggest changes against a year earlier</div>
        ${d.biggest_changes_vs_last_year
          .map(
            (m) => `<div class="row" style="padding:6px 0">
              <span class="label">${escapeHtml(m.group)}</span>
              <span><span class="v num ${m.change > 0 ? 'bad' : 'good'}">${money(m.change, { showPlus: true })}</span>
              <span class="pct">${m.percent === null ? 'new' : m.percent + '%'}</span></span>
            </div>`
          )
          .join('')}` : ''}

      ${d.caveats.length ? `
        <div class="eyebrow" style="margin:16px 0 6px">Stated limitations, sent with the figures</div>
        ${d.caveats.map((c) => `<div class="attn-item"><span class="dot"></span><div class="d">${escapeHtml(c)}</div></div>`).join('')}` : ''}
    </div>`;
}

function renderReport(r) {
  const cost = r.input_tokens
    ? `${r.input_tokens.toLocaleString('en-US')} in / ${r.output_tokens.toLocaleString('en-US')} out`
    : '';
  $('report').innerHTML = `
    <section class="card report">
      <div class="card-head">
        <span class="eyebrow">${escapeHtml(r.period_label)}</span>
        <span class="pct">${escapeHtml(r.model || '')} ${cost}</span>
      </div>
      ${markdown(r.body)}
      <p class="note">
        Written ${escapeHtml(r.created_at)} from the figures as they stood then. This is
        analysis to weigh, not advice to follow.
      </p>
    </section>`;
  $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHistory() {
  $('history-count').textContent = history.length ? `${history.length}` : 'none yet';
  $('history').innerHTML = history.length
    ? history
        .map(
          (r) => `<div class="row">
            <div><span class="label">${escapeHtml(r.period_label)}</span>
              <div class="sub">${r.kind} · written ${escapeHtml(r.created_at.slice(0, 10))}</div></div>
            <div style="display:flex;gap:6px">
              <button class="confirm" data-open="${r.id}">read</button>
              <button class="confirm" data-del="${r.id}">delete</button>
            </div>
          </div>`
        )
        .join('')
    : '<div class="skeleton">No reviews written yet.</div>';

  $('history').querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => renderReport(history.find((r) => r.id === Number(el.dataset.open))))
  );
  $('history').querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!confirm('Delete this review? The figures behind it are not affected.')) return;
      await api(`/reports/${el.dataset.del}`, { method: 'DELETE' });
      await load();
    })
  );
}

/* --- actions -------------------------------------------------------------- */

async function preview() {
  $('preview-out').innerHTML = '<div class="skeleton">Gathering…</div>';
  try {
    renderFigures(await api(`/reports/preview?${query(periodParams())}`));
  } catch (err) {
    $('preview-out').innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

async function generate(replace = false) {
  const button = $('generate');
  button.disabled = true;
  button.textContent = 'Writing…';
  try {
    const r = await api('/reports', { method: 'POST', body: { ...periodParams(), replace } });
    renderReport(r);
    await load();
    toast('Review written.');
  } catch (err) {
    // A review already existing is a question, not a failure.
    if (/already exists/.test(err.message)) {
      if (confirm(`${err.message}\n\nReplace it?`)) return generate(true);
    } else {
      showError(err.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Write the review';
  }
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* --- context ------------------------------------------------------------- */

/* Two kinds of fact, kept apart because they age differently. The standing note
   is durable and written once; a period note is pinned to the month it
   describes and so is never stale — a review simply does not read months it
   does not cover. */

/** The month a period note attaches to. A quarter takes its last month. */
function notePeriod() {
  const year = Number($('year').value);
  const value = Number($('period').value);
  const month = kind === 'quarter' ? value * 3 : value;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function renderNoteEditor() {
  const period = notePeriod();
  const existing = notes.find((n) => n.period === period);
  const [y, m] = period.split('-');
  $('note-period').textContent = new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('period-note').value = existing ? existing.note : '';
  $('note-status').textContent = existing ? `saved ${existing.updated_at.slice(0, 10)}` : '';

  // The year's other notes, so it is obvious what a review will already know
  // and nothing gets written twice.
  const others = notes.filter((n) => n.period !== period);
  $('notes-year').innerHTML = others.length
    ? `<div class="eyebrow" style="margin-bottom:6px">Other notes this year — a review reads these too</div>` +
      others
        .map(
          (n) => `<div class="row" style="padding:6px 0">
            <div><span class="label">${escapeHtml(n.period)}</span>
              <div class="sub">${escapeHtml(n.note.slice(0, 110))}${n.note.length > 110 ? '…' : ''}</div></div>
          </div>`
        )
        .join('')
    : '';
}

async function saveNote() {
  const period = notePeriod();
  try {
    await api(`/notes/${period}`, { method: 'PUT', body: { note: $('period-note').value } });
    notes = await api(`/notes?year=${$('year').value}`);
    renderNoteEditor();
    toast(`Note saved for ${period}.`);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

async function saveContext() {
  try {
    await api('/settings', { method: 'PUT', body: { report_context: $('report-context').value.trim() || null } });
    toast('Standing context saved — it goes with every review.');
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

async function load() {
  try {
    const [settings, yearNotes, reportList] = await Promise.all([
      api('/settings').catch(() => ({})),
      api(`/notes?year=${$('year').value}`).catch(() => []),
      api('/reports?limit=50'),
    ]);
    if (settings.report_context) $('report-context').value = settings.report_context;
    notes = yearNotes;
    history = reportList;
    renderNoteEditor();
    updateGate();
    renderHistory();
    $('foot').textContent = `${history.length} reviews`;
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(() => {
  const thisYear = new Date().getFullYear();
  $('year').innerHTML = [thisYear, thisYear - 1].map((y) => `<option value="${y}">${y}</option>`).join('');
  $('period').innerHTML = periodOptions();

  const setKind = (next) => {
    kind = next;
    $('kind-month').classList.toggle('on', next === 'month');
    $('kind-quarter').classList.toggle('on', next === 'quarter');
    $('period').innerHTML = periodOptions();
    $('preview-out').innerHTML = '';
    renderNoteEditor();
    updateGate();
  };
  $('kind-month').addEventListener('click', () => setKind('month'));
  $('kind-quarter').addEventListener('click', () => setKind('quarter'));
  $('year').addEventListener('change', async () => {
    $('period').innerHTML = periodOptions();
    notes = await api(`/notes?year=${$('year').value}`).catch(() => []);
    renderNoteEditor();
    updateGate();
  });
  $('preview').addEventListener('click', preview);
  $('generate').addEventListener('click', () => generate(false));
  $('save-context').addEventListener('click', saveContext);
  $('save-note').addEventListener('click', saveNote);
  // The note editor follows whichever period is selected, so writing a note and
  // reviewing that period are the same gesture.
  $('period').addEventListener('change', () => { renderNoteEditor(); updateGate(); });

  load();
});
