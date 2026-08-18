/* Property. Value, what is owed, and what the rental actually earns.
 *
 * The escrow point runs through the whole page: property tax and homeowner's
 * insurance are paid inside the mortgage payment and appear nowhere in the
 * ledger. Rather than draw an empty tax chart — which would read as zero rather
 * than as invisible — the page charts the payment itself, because escrow is
 * re-analysed annually and a step in the payment IS the tax or insurance
 * change. */

let data = null;

/** Monthly payments as bars, so a step in escrow is visible as a step. */
function paymentChart(history) {
  if (!history || history.length < 2) {
    return '<div class="sub">not enough payment history yet</div>';
  }
  const amounts = history.map((h) => h.amount);
  const peak = Math.max(...amounts);
  const first = amounts[0];
  const last = amounts[amounts.length - 1];
  const change = last - first;

  const bars = history
    .map((h) => {
      const height = Math.max(3, Math.round((h.amount / peak) * 40));
      const raised = h.amount > first * 1.01;
      return `<span class="pbar" title="${h.month}: ${money(h.amount)}"
        style="height:${height}px;background:var(--${raised ? 'attn' : 'accent'})"></span>`;
    })
    .join('');

  return `
    <div class="pbars">${bars}</div>
    <div class="sub">
      ${history[0].month} ${money(first)} → ${history[history.length - 1].month} ${money(last)}
      ${Math.abs(change) > 1 ? `· <strong class="${change > 0 ? 'bad' : 'good'}">${money(change, { showPlus: true })}/mo</strong>` : '· unchanged'}
    </div>`;
}

function render() {
  const stat = (label, value, sub, tone) =>
    `<div><div class="eyebrow">${label}</div><div class="v num ${tone || ''}">${value}</div>` +
    `<div class="sub">${sub || ''}</div></div>`;

  $('totals').innerHTML = [
    stat('Total value', money(data.total_value), `${data.properties.length} properties`),
    stat('Owed', money(data.total_debt), ''),
    stat('Equity', money(data.total_equity), '', 'good'),
  ].join('');

  $('properties').innerHTML = data.properties.length
    ? data.properties
        .map(
          (p) => `
      <section class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="eyebrow">${escapeHtml(p.name)}${p.is_rental ? ' · rental' : ' · primary'}</span>
          <a href="accounts.html" style="font-size:12px">Update value →</a>
        </div>
        <div class="goals-grid">
          ${stat('Value', money(p.value), 'entered by hand')}
          ${stat('Mortgage', p.mortgage === null ? '—' : money(p.mortgage), p.loan_accounts.join(', ') || 'none linked')}
          ${stat('Equity', p.equity === null ? '—' : money(p.equity), '', 'good')}
        </div>
        <div style="margin-top:16px">
          <div class="eyebrow" style="margin-bottom:6px">Monthly payment · tax and insurance escrowed within</div>
          ${paymentChart(p.payment_history)}
        </div>
      </section>`
        )
        .join('') +
      `<p class="note">${escapeHtml(data.escrowed.note)}</p>`
    : '<section class="card"><div class="skeleton">No properties recorded. Add one from Accounts.</div></section>';

  const rental = data.rental;
  const hasRental = rental.income_ytd || rental.expenses_ytd;
  $('rental-card').hidden = !hasRental;
  if (!hasRental) return;

  $('rental-net').textContent = `${money(rental.income_ytd)} in · ${money(rental.expenses_ytd)} out · ${money(
    rental.net_ytd,
    { showPlus: true }
  )} net`;

  const thisYear = rental.income_by_month.filter((m) => m.month.startsWith(String(data.year)));
  $('rental-income').innerHTML = thisYear.length
    ? thisYear
        .map(
          (m) => `<div class="row" style="padding:6px 0">
            <span class="sub">${m.month}</span>
            <span class="v num">${money(m.amount)}</span>
          </div>`
        )
        .join('')
    : '<div class="skeleton">No rental income recorded this year.</div>';

  const expenses = rental.expenses_by_category.filter((e) => e.year === data.year);
  $('rental-expenses').innerHTML = expenses.length
    ? expenses
        .map(
          (e) => `<div class="row" style="padding:6px 0">
            <div><span class="label">${escapeHtml(e.category)}</span>
              <div class="sub">${e.n} transaction${e.n === 1 ? '' : 's'}</div></div>
            <span class="v num">${money(e.amount)}</span>
          </div>`
        )
        .join('')
    : '<div class="skeleton">No rental expenses recorded this year.</div>';

  // The honest caveat about that net figure.
  $('rental-note').textContent =
    'Expenses include the whole mortgage payment. Principal repayment is not really a cost — it builds equity — and only the interest is deductible, but the split is not in the transaction data. So the true return is better than the net figure above, by whatever share of the payment is principal.';
}

async function load() {
  try {
    data = await api(`/properties?year=${$('year').value}`);
    $('heading').textContent = `Property · ${data.year}`;
    render();
    $('foot').textContent = `${data.properties.length} properties`;
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(() => {
  const thisYear = new Date().getFullYear();
  $('year').innerHTML = [thisYear, thisYear - 1, thisYear - 2]
    .map((y) => `<option value="${y}">${y}</option>`)
    .join('');
  $('year').addEventListener('change', load);
  load();
});
