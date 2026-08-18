/* Investments: what they hold, what went in, and the difference.
 *
 * The difference is the only interesting number, and it is only honest because
 * these accounts are new in 2026 — every contribution is inside the data, so
 * "worth today minus what went in" really is the gain. The page says so, because
 * the same subtraction on an account with untracked history would report the
 * whole balance as profit. */

let data = null;

/** Balance over time. Two points is a line and not much of one, so it says so. */
function sparkline(history) {
  if (!history || history.length < 2) {
    return '<span class="sub">not enough history yet</span>';
  }
  const values = history.map((h) => h.balance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = history
    .map((h, i) => `${(i / (history.length - 1)) * 100},${28 - ((h.balance - min) / span) * 26}`)
    .join(' ');
  const rising = values[values.length - 1] >= values[0];
  return `<svg viewBox="0 0 100 28" preserveAspectRatio="none" class="mini" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="var(--${rising ? 'pos' : 'attn'})" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function render() {
  const stat = (label, value, sub, tone) =>
    `<div><div class="eyebrow">${label}</div><div class="v num ${tone || ''}">${value}</div>` +
    `<div class="sub">${sub || ''}</div></div>`;

  const tone = data.gain > 0 ? 'good' : data.gain < 0 ? 'bad' : '';
  $('totals').innerHTML = [
    stat('Value today', money(data.value), `${data.accounts.length} accounts`),
    stat('Contributed', money(data.contributed), data.contributions_since ? `since ${data.contributions_since}` : ''),
    stat(
      'Unrealised gain',
      money(data.gain, { showPlus: true }),
      data.gain_percent === null ? '' : `${data.gain_percent > 0 ? '+' : ''}${data.gain_percent}%`,
      tone
    ),
  ].join('');

  // The caveat belongs on the page, not just in the code: this subtraction is
  // only meaningful while every contribution is inside the data.
  $('gain-note').textContent = data.contributed
    ? 'Gain is worth-today less what was put in, across all accounts together — a contribution leaving a chequing account never says which account received it. It never counts as income: nothing is realised until something is sold.'
    : 'No contributions recorded yet, so there is nothing to measure a gain against.';

  $('accounts').innerHTML = data.accounts.length
    ? `<section class="card">
        <div class="card-head"><span class="eyebrow">Accounts</span></div>
        ${data.accounts
          .map(
            (a) => `
          <div class="row">
            <div>
              <div class="label">${escapeHtml(a.name)}</div>
              ${a.name !== a.full_name ? `<div class="sub">${escapeHtml(a.full_name)}</div>` : ''}
              ${a.balance === 0 ? '<div class="sub">empty — a backdoor Roth conduit sits at zero between conversions</div>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:14px">
              ${sparkline(a.history)}
              <span class="v num">${money(a.balance)}</span>
            </div>
          </div>`
          )
          .join('')}
      </section>`
    : `<section class="card"><div class="skeleton">No investment accounts yet. Link a brokerage, or add one manually from Accounts.</div></section>`;

  if (data.contributed_elsewhere && data.contributed_elsewhere.length) {
    $('elsewhere-card').hidden = false;
    $('elsewhere').innerHTML = data.contributed_elsewhere
      .map(
        (e) => `<div class="row">
          <div><span class="label">${escapeHtml(e.category)}</span>
            <div class="sub">destination not tracked as an account</div></div>
          <div class="v num">${money(e.total)}</div>
        </div>`
      )
      .join('');
  }

  $('foot').textContent = `${data.contribution_count} contributions`;
}

async function load() {
  try {
    data = await api('/investments');
    render();
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(load);
