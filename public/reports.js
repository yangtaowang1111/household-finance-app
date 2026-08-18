/* Reports. Generate a period review, read it, and keep the ones already
   written.
 *
 * "Show the figures" exists because the summary is the whole quality decision:
 * if something important is missing from it, the review cannot recover, and
 * checking costs nothing. */

let kind = 'month';
let history = [];

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

function periodOptions() {
  const year = Number($('year').value);
  const now = new Date();
  if (kind === 'quarter') {
    return [1, 2, 3, 4]
      .map((q) => `<option value="${q}">Q${q}</option>`)
      .join('');
  }
  // Only months that have actually finished — reviewing a month still running
  // reports a period that is not over.
  const last = year === now.getFullYear() ? now.getMonth() : 12;
  return Array.from({ length: last }, (_, i) => i + 1)
    .reverse()
    .map((m) => `<option value="${m}">${new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })}</option>`)
    .join('');
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

async function saveContext() {
  try {
    await api('/settings', { method: 'PUT', body: { report_context: $('report-context').value.trim() || null } });
    toast('Context saved — it goes with every review from now on.');
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

async function load() {
  try {
    const settings = await api('/settings').catch(() => ({}));
    if (settings.report_context) $('report-context').value = settings.report_context;
    history = await api('/reports?limit=50');
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
  };
  $('kind-month').addEventListener('click', () => setKind('month'));
  $('kind-quarter').addEventListener('click', () => setKind('quarter'));
  $('year').addEventListener('change', () => { $('period').innerHTML = periodOptions(); });
  $('preview').addEventListener('click', preview);
  $('generate').addEventListener('click', () => generate(false));
  $('save-context').addEventListener('click', saveContext);

  load();
});
