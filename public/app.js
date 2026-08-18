/* Overview. Shared helpers (api, money, the key gate) live in common.js.

   Every number that represents a set of transactions links into the
   Transactions screen filtered to exactly that set — a figure you can question
   but not inspect is a dead end. */

const pct = (n) => `${n.toFixed(1)}%`;

/** A link into the Transactions screen, pre-filtered. Filters live in the query
    string there, so these are ordinary links: bookmarkable, and the back button
    returns here. */
const txnLink = (filters) => {
  const params = new URLSearchParams();
  // The period travels with the link, so a figure clicked on the Overview opens
  // the same slice of time rather than everything.
  const year = $('ov-year') && $('ov-year').value;
  const month = $('ov-month') && $('ov-month').value;
  if (year) params.set('year', year);
  if (month) params.set('month', month);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  return `transactions.html?${params}`;
};

/** Colours for the spending breakdown, walked round the accent hue. */
const swatchFor = (i) => `oklch(${0.62 - (i % 5) * 0.03} 0.075 ${195 + i * 26})`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
}

/* --- chart ---------------------------------------------------------------- */

/**
 * Net worth sparkline. The series carries a `reconstructed` flag per point —
 * everything before real snapshots began is inferred by replaying transactions
 * backwards. That boundary is drawn (dashed before, solid after) rather than
 * hidden, because a curve that looks equally confident along its whole length
 * would be claiming more than the data supports.
 */
function drawChart(series) {
  const el = $('nw-chart');
  if (!series || series.length < 2) {
    el.innerHTML = '<div class="skeleton">Not enough history yet — the curve builds as balances are recorded each day.</div>';
    return;
  }

  const W = 1000;
  const H = 120;
  const values = series.map((p) => p.net_worth);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = span * 0.12;

  const x = (i) => (i / (series.length - 1)) * W;
  const y = (v) => H - ((v - min + pad) / (span + pad * 2)) * H;

  // Split at the reconstruction boundary so the two halves can be drawn
  // differently. The solid segment starts at the last inferred point so the
  // line does not break visually.
  const firstReal = series.findIndex((p) => !p.reconstructed);
  const cut = firstReal <= 0 ? 0 : firstReal - 1;

  const path = (from, to) =>
    series.slice(from, to).map((p, k) => `${k === 0 ? 'M' : 'L'}${x(from + k).toFixed(1)},${y(p.net_worth).toFixed(1)}`).join(' ');

  const inferred = firstReal === -1 ? path(0, series.length) : path(0, cut + 1);
  const real = firstReal === -1 ? '' : path(cut, series.length);
  const area = `${firstReal === -1 ? inferred : path(0, series.length)} L${W},${H} L0,${H} Z`;

  const label = (i, text) =>
    `<text x="${x(i).toFixed(1)}" y="${H + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${text}</text>`;

  // One label per month change, so the axis reads Jan / Feb / Mar rather than
  // 229 dates.
  const ticks = [];
  let lastMonth = '';
  series.forEach((p, i) => {
    const m = p.date.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      ticks.push(label(i, new Date(`${p.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })));
    }
  });

  el.innerHTML = `
    <svg viewBox="0 -4 ${W} ${H + 22}" preserveAspectRatio="none" role="img"
         aria-label="Net worth from ${series[0].date} to ${series[series.length - 1].date}">
      <defs>
        <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#fade)"/>
      <path d="${inferred}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-dasharray="4 4" stroke-opacity="0.75" vector-effect="non-scaling-stroke"/>
      ${real ? `<path d="${real}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
      ${ticks.join('')}
    </svg>
    <p class="note" style="margin-top:4px">
      Dashed before ${firstReal === -1 ? 'today' : series[cut].date}: rebuilt by replaying transactions.
      Investment, property and mortgage balances are held flat across that span.
    </p>`;
}

/* --- panels --------------------------------------------------------------- */

function renderNetWorth(nw, history) {
  $('nw-total').textContent = money(nw.net_worth);
  $('nw-assets').textContent = money(nw.assets);
  $('nw-liabs').textContent = money(nw.liabilities);

  const counts = Object.fromEntries(nw.by_type.map((g) => [g.type, g.accounts]));
  $('nw-assets-sub').textContent = ['checking', 'savings', 'investment', 'property']
    .filter((t) => counts[t]).map((t) => `${counts[t]} ${t}`).join(' · ');
  $('nw-liabs-sub').textContent = ['credit', 'mortgage', 'loan']
    .filter((t) => counts[t]).map((t) => `${counts[t]} ${t}`).join(' · ');

  if (history && history.change !== null) {
    const d = $('nw-delta');
    d.textContent = `${money(history.change, { showPlus: true })} since ${history.window.from}`;
    d.className = `delta ${history.change >= 0 ? 'up' : 'down'}`;
  }
  drawChart(history && history.series);
}

function renderChips(cash, investments) {
  const chips = [];
  if (cash) chips.push(['Contributions', money(cash.saved)]);
  if (investments && investments.movement !== null) {
    chips.push(['Market movement', money(investments.movement, { showPlus: true })]);
  }
  $('nw-chips').innerHTML = chips
    .map(([l, v]) => `<span class="chip">${l} <strong>${v}</strong></span>`)
    .join('');
}

function renderCashflow(cf, label) {
  $('cf-title').textContent = label;
  $('cf-rows').innerHTML = `
    <div class="row big-row">
      <div><div class="label">Income</div></div>
      <div class="v num">${money(cf.income)}</div>
    </div>
    <div class="row big-row">
      <div><div class="label">Spending</div><div class="sub">${cf.groups.filter((g) => g.counts_as_spending).reduce((n, g) => n + g.transactions, 0).toLocaleString('en-US')} transactions</div></div>
      <div class="v num">${money(cf.spending)}</div>
    </div>
    <div class="row big-row">
      <div><div class="label">Surplus</div>
        <div class="sub">${money(cf.saved)} moved to savings · ${money(cf.unallocated, { showPlus: true })} still in cash</div></div>
      <div class="v num">${money(cf.surplus)}</div>
    </div>
    <div class="row">
      <div><div class="label num" style="font-size:22px;font-weight:600">${cf.savings_rate === null ? '—' : pct(cf.savings_rate)}</div>
        <div class="sub">savings rate — earned and not spent</div></div>
    </div>`;
}

function renderSpending(cf) {
  const spending = cf.groups
    .filter((g) => g.counts_as_spending && g.total < 0)
    .sort((a, b) => a.total - b.total);
  const total = spending.reduce((s, g) => s + Math.abs(g.total), 0) || 1;

  $('spend-sub').textContent = `${money(cf.spending)} across ${spending.length} groups`;

  const bar = spending
    .map((g, i) => `<span style="flex:${Math.abs(g.total)};background:${swatchFor(i)}"></span>`)
    .join('');

  const rows = spending
    .map(
      (g, i) => `
      <div class="row">
        <div><span class="swatch" style="background:${swatchFor(i)}"></span><a class="label" href="${txnLink({ group: g.group })}">${escapeHtml(g.group)}</a>
          <div class="sub" style="margin-left:14px">${g.transactions.toLocaleString('en-US')} transactions</div></div>
        <div><span class="v num">${money(g.total)}</span><span class="pct">${((Math.abs(g.total) / total) * 100).toFixed(1)}%</span></div>
      </div>`
    )
    .join('');

  $('spend').innerHTML = `<div class="bar">${bar}</div><div class="grid-2" style="gap:0 26px">${rows}</div>`;
}

function renderAccounts(nw) {
  const LABEL = {
    checking: 'Checking', savings: 'Savings', investment: 'Investments',
    credit: 'Credit cards', mortgage: 'Mortgages', loan: 'Loans', property: 'Property',
  };
  $('accounts').innerHTML = nw.by_type
    .filter((g) => g.type !== 'property')
    .map(
      (g) => `<div class="row">
        <div><span class="label">${LABEL[g.type] || g.type}</span> <span class="sub">${g.accounts}</span></div>
        <div class="v num">${money(g.total)}</div>
      </div>`
    )
    .join('') + '<p class="note">Properties are listed separately.</p>';
}

function renderProperty(nw) {
  if (!nw.properties.length) {
    $('property').innerHTML = '<div class="skeleton">No properties recorded.</div>';
    return;
  }
  $('property').innerHTML = nw.properties
    .map(
      (p) => `<div style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px">
        <div class="row" style="padding:0;border:0">
          <span class="label">${p.name}</span>
          <span class="v num">${money(p.value)}</span>
        </div>
        <div class="sub" style="margin-top:6px">
          ${p.mortgage === null
            ? 'No mortgage linked — equity unknown'
            : `Mortgage ${money(p.mortgage)} · Equity <strong class="num">${money(p.equity)}</strong>`}
        </div>
      </div>`
    )
    .join('');
}

function renderActivity(txns) {
  if (!txns.length) {
    $('activity').innerHTML = '<div class="skeleton">Nothing yet.</div>';
    return;
  }
  $('activity').innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Group</th><th>Account</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        ${txns
          .map(
            (t) => `<tr>
            <td class="mono">${new Date(`${t.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</td>
            <td class="desc"><a href="${txnLink({ search: (t.payee || t.merchant_raw || '').slice(0, 24) })}">${escapeHtml(t.payee || t.merchant_raw || '').slice(0, 60)}</a></td>
            <td>${t.category_group ? escapeHtml(t.category_group) : '<span style="color:var(--attn)">Uncategorised</span>'}</td>
            <td class="mono">${escapeHtml(t.account_nickname || t.account_name || '')}</td>
            <td class="amt num ${t.amount > 0 ? 'in' : ''}">${money(t.amount, { showPlus: true })}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderAttention(items) {
  $('attn-count').textContent = items.length ? `${items.length} item${items.length > 1 ? 's' : ''}` : 'nothing';
  $('attn').innerHTML = items.length
    ? items
        .map((i) => {
          const body = `<span class="dot"></span><div><div class="t">${escapeHtml(i.title)}</div><div class="d">${escapeHtml(i.detail)}</div></div>`;
          return i.href
            ? `<a class="attn-item ${i.warn ? 'warn' : ''}" href="${i.href}" style="color:inherit">${body}</a>`
            : `<div class="attn-item ${i.warn ? 'warn' : ''}">${body}</div>`;
        })
        .join('')
    : '<div class="skeleton">Nothing needs attention.</div>';
}

/* --- load ----------------------------------------------------------------- */

/* The period on screen, as bounds and as a label.
 *
 * Both are derived from the selected strings and never by parsing a date, which
 * is where the previous label came from and why it read "2025 to date" all of
 * 2026: new Date("2026-01-01") is UTC midnight, and in Denver that is the 31st
 * of December. The figures were always right — only the words above them were
 * wrong — but a heading that disagrees with its own numbers is worse than no
 * heading. */
function selectedPeriod() {
  const year = Number($('ov-year').value) || new Date().getFullYear();
  const month = Number($('ov-month').value) || null;
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();

  if (month) {
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    return {
      from: `${year}-${String(month).padStart(2, '0')}-01`,
      to: next,
      label: `${new Date(2000, month - 1, 1).toLocaleDateString('en-US', { month: 'long' })} ${year}`,
    };
  }

  // Tomorrow, not today: the upper bound is exclusive, so today's own
  // transactions would otherwise be left out of the current year.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    from: `${year}-01-01`,
    to: isCurrentYear ? tomorrow.toISOString().slice(0, 10) : `${year + 1}-01-01`,
    label: isCurrentYear ? `${year} to date` : String(year),
  };
}

async function load() {
  $('greeting').textContent = greeting();
  const period = selectedPeriod();

  try {
    const [nw, history, cf, txns] = await Promise.all([
      api('/networth'),
      api(`/networth/history?from=${period.from}`),
      api(`/cashflow?from=${period.from}&to=${period.to}`),
      api('/transactions?limit=10'),
    ]);

    renderNetWorth(nw, history);
    renderCashflow(cf, period.label);
    renderSpending(cf);
    renderAccounts(nw);
    renderProperty(nw);
    renderActivity(txns);

    const investments = nw.by_type.find((g) => g.type === 'investment');
    renderChips(cf, investments ? { movement: null } : null);

    const attention = [];
    if (cf.uncategorized_transactions > 0) {
      attention.push({
        title: `${cf.uncategorized_transactions} transactions uncategorised`,
        detail: 'They are excluded from the totals above until filed.',
        warn: true,
        href: txnLink({ uncategorized: '1' }),
      });
    }

    const needsReview = await api('/transactions?needs_review=1&limit=2000').catch(() => []);
    if (needsReview.length) {
      attention.push({
        title: `${needsReview.length} low-confidence categories`,
        detail: 'The categoriser was unsure about these and asked for a human.',
        warn: true,
        href: txnLink({ needs_review: '1' }),
      });
    }

    const dupes = await api('/transactions?possible_duplicates=1&limit=2000').catch(() => []);
    if (dupes.length) {
      attention.push({
        title: `${dupes.length} possible duplicates`,
        detail: 'Flagged by the sync, never deleted automatically. Worth resolving.',
        warn: true,
        href: txnLink({ possible_duplicates: '1' }),
      });
    }
    for (const p of nw.properties) {
      if (p.mortgage === null) {
        attention.push({
          title: `${p.name} has no mortgage linked`,
          detail: 'Equity cannot be calculated until a loan is linked to it.',
          warn: false,
        });
      }
    }
    if (history.reconstructed_before) {
      attention.push({
        title: `Balance history starts ${history.reconstructed_before}`,
        detail: 'Earlier points are rebuilt from transactions. Accuracy improves daily as real balances are recorded.',
        warn: false,
      });
    }
    renderAttention(attention);

    // Guarded: these are decorations on the nav, and a nav that changes shape
    // must not be able to throw an error banner onto a page that rendered fine.
    const setText = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    setText('nav-txns', txns.length >= 10 ? '2,500+' : String(txns.length));
    setText('foot', `synced ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(async () => {
  const thisYear = new Date().getFullYear();
  const years = await api('/transactions/years').catch(() => [thisYear]);

  $('ov-year').innerHTML = (years.length ? years : [thisYear])
    .map((y) => `<option value="${y}">${y}</option>`)
    .join('');
  $('ov-year').value = years.includes(thisYear) ? thisYear : years[0];

  $('ov-month').innerHTML =
    '<option value="">Whole year</option>' +
    Array.from({ length: 12 }, (_, i) => i + 1)
      .map((m) => `<option value="${m}">${new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })}</option>`)
      .join('');

  $('ov-year').addEventListener('change', load);
  $('ov-month').addEventListener('change', load);
  load();
});
