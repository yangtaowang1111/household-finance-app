/* Setting a budget from what actually happened.
 *
 * Two controls per category, kept in sync: a slider in percent of last year,
 * and a box in dollars. The slider is for "spend about 10% less on dining out",
 * which is how people actually think about a number they do not yet know; the
 * box is for when they do know. Neither is sufficient alone, so both write to
 * the same underlying annual figure.
 *
 * Nothing is written until Save. The whole point is to try numbers on. */

let data = null;
const chosen = new Map(); // category id -> annual amount

const MAX_PERCENT = 200;

/** Replays the reference year against a proposed budget. */
function monthsOver(category, annual) {
  const shape = category.shape;
  return category.reference_year.monthly.reduce(
    (n, spent, i) => n + (spent > annual * shape[i] ? 1 : 0),
    0
  );
}

/** Twelve bars of last year, with this year overlaid where it exists. */
function sparkline(category) {
  const ref = category.reference_year.monthly;
  const cur = category.current_year.monthly;
  const peak = Math.max(...ref, ...cur, 1);
  return `<span class="spark" title="${category.reference_year.year} by month">${ref
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / peak) * 22));
      const ch = cur[i] ? Math.max(2, Math.round((cur[i] / peak) * 22)) : 0;
      return `<span class="spark-col"><i style="height:${h}px"></i>${
        ch ? `<b style="height:${ch}px"></b>` : ''
      }</span>`;
    })
    .join('')}</span>`;
}

function baseFor(category) {
  // Percent is relative to last year where there is a last year, and to the
  // suggestion otherwise — a slider needs something to be a percentage OF.
  return category.reference_year.total || category.suggested_annual || 0;
}

function renderRow(category) {
  const annual = chosen.get(category.id) ?? 0;
  const base = baseFor(category);
  const percent = base ? Math.round((annual / base) * 100) : 0;
  const over = base ? monthsOver(category, annual) : 0;

  return `
  <div class="brow" data-row="${category.id}">
    <div class="brow-name">
      <div class="label">${escapeHtml(category.name)}</div>
      <div class="sub">${category.group ? escapeHtml(category.group) : 'group'}${
        category.seasonal ? ' · seasonal' : ''
      }</div>
    </div>

    <div class="brow-hist">
      ${sparkline(category)}
      <div class="sub">
        ${category.reference_year.year}: <span class="num">${money(category.reference_year.total)}</span>
        · now <span class="num">${money(category.current_year.run_rate)}</span>/mo
      </div>
    </div>

    <div class="brow-set">
      <input type="range" min="0" max="${MAX_PERCENT}" step="5" value="${Math.min(percent, MAX_PERCENT)}"
             data-slider="${category.id}" aria-label="Percent of last year">
      <div class="brow-inputs">
        <span class="pctbox num" data-pct="${category.id}">${percent}%</span>
        <input type="number" min="0" step="50" value="${Math.round(annual)}"
               data-amount="${category.id}" aria-label="Annual budget in dollars">
        <span class="sub">/yr</span>
      </div>
      <div class="sub" data-hint="${category.id}">
        ${annual ? `${money(annual / 12)}/mo · ${over ? `over in ${over} of 12 months last year` : 'covers every month last year'}` : 'no budget'}
      </div>
    </div>
  </div>`;
}

function visibleCategories() {
  const hideEmpty = $('hide-empty').checked;
  return data.categories
    .filter((c) => !c.is_group) // children only; groups roll up from these
    .filter((c) => c.counts_as_spending)
    .filter((c) => !hideEmpty || c.reference_year.total > 0 || c.current_year.total > 0 || chosen.get(c.id))
    // Largest first, so the twenty decisions that matter come before the
    // thirty-nine that do not.
    .sort((a, b) => (chosen.get(b.id) ?? b.suggested_annual) - (chosen.get(a.id) ?? a.suggested_annual));
}

function renderTotals() {
  const cats = data.categories.filter((c) => !c.is_group && c.counts_as_spending);
  const reference = cats.reduce((s, c) => s + c.reference_year.total, 0);
  const runRate = cats.reduce((s, c) => s + c.current_year.run_rate * 12, 0);
  const budget = cats.reduce((s, c) => s + (chosen.get(c.id) ?? 0), 0);

  $('ref-label').textContent = `${data.reference_year} actual`;
  $('t-reference').textContent = money(reference);
  $('t-runrate').textContent = `${money(runRate)}/yr`;
  $('t-budget').textContent = money(budget);

  const delta = reference ? ((budget - reference) / reference) * 100 : 0;
  $('t-delta').textContent = reference
    ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs ${data.reference_year}`
    : '';
  $('t-delta').className = `sub ${delta > 0 ? 'over' : ''}`;
}

function render() {
  const cats = visibleCategories();
  $('rows').innerHTML = cats.length
    ? cats.map(renderRow).join('')
    : '<div class="skeleton">Nothing to show.</div>';
  renderTotals();
  wireRows();
}

/** Updates one row in place — re-rendering the list would lose slider focus. */
function setAmount(id, annual, source) {
  const category = data.categories.find((c) => c.id === id);
  const value = Math.max(0, Math.round(annual || 0));
  chosen.set(id, value);

  const base = baseFor(category);
  const percent = base ? Math.round((value / base) * 100) : 0;

  const slider = document.querySelector(`[data-slider="${id}"]`);
  const amount = document.querySelector(`[data-amount="${id}"]`);
  if (slider && source !== 'slider') slider.value = Math.min(percent, MAX_PERCENT);
  if (amount && source !== 'amount') amount.value = value;

  const pct = document.querySelector(`[data-pct="${id}"]`);
  if (pct) pct.textContent = `${percent}%`;

  const hint = document.querySelector(`[data-hint="${id}"]`);
  if (hint) {
    const over = base ? monthsOver(category, value) : 0;
    hint.textContent = value
      ? `${money(value / 12)}/mo · ${over ? `over in ${over} of 12 months last year` : 'covers every month last year'}`
      : 'no budget';
  }

  renderTotals();
}

function wireRows() {
  document.querySelectorAll('[data-slider]').forEach((el) => {
    el.addEventListener('input', () => {
      const id = Number(el.dataset.slider);
      const category = data.categories.find((c) => c.id === id);
      setAmount(id, (baseFor(category) * Number(el.value)) / 100, 'slider');
    });
  });

  document.querySelectorAll('[data-amount]').forEach((el) => {
    el.addEventListener('input', () => setAmount(Number(el.dataset.amount), Number(el.value), 'amount'));
  });
}

async function save() {
  const plans = data.categories
    .filter((c) => !c.is_group)
    .map((c) => ({
      category_id: c.id,
      annual_amount: chosen.get(c.id) ?? 0,
      // Seasonal categories carry their own distribution, so an annual figure
      // lands in the months the spending lands in.
      shape: c.seasonal ? c.shape : undefined,
    }));

  try {
    const r = await api('/budgets/plan', { method: 'POST', body: { year: data.year, plans } });
    toast(`Saved — ${r.written} monthly budgets written${r.cleared ? `, ${r.cleared} cleared` : ''}.`);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
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

async function load(year) {
  try {
    data = await api(`/budgets/baseline?year=${year}`);
    chosen.clear();
    for (const c of data.categories) {
      // An existing budget wins over a suggestion — a number already chosen is
      // a decision, and reopening the page should not quietly undo it.
      chosen.set(c.id, c.budgeted_annual ?? 0);
    }
    $('heading').textContent = `Budget for ${data.year}`;
    render();
    $('foot').textContent = `${data.months_elapsed} of 12 months elapsed`;
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(() => {
  const thisYear = new Date().getFullYear();
  $('year').innerHTML = [thisYear, thisYear + 1]
    .map((y) => `<option value="${y}">${y}</option>`)
    .join('');

  $('year').addEventListener('change', () => load(Number($('year').value)));
  $('hide-empty').addEventListener('change', render);
  $('save').addEventListener('click', save);
  $('accept-all').addEventListener('click', () => {
    for (const c of data.categories) chosen.set(c.id, Math.round(c.suggested_annual));
    render();
    toast('Suggestions applied — review, then Save.');
  });

  load(thisYear);
});
