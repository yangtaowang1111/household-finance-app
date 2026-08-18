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
let settings = {};
let context = null; // income, emergency fund balance — things the budget is measured against
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

const num = (key) => {
  const v = Number(settings[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * The numbers the budget is actually for.
 *
 * Income is projected from what has been earned so far, scaled by the share of
 * the year elapsed — deliberately crude, and stated as an assumption rather
 * than hidden, because a mid-year job change makes anything cleverer a
 * pretence at precision.
 *
 * 401(k) deferrals come from the assumptions rather than the ledger. Payroll
 * takes them from gross pay before anything reaches a bank, so they are absent
 * from both income and spending: without them the savings rate is understated
 * by exactly the amount being saved hardest.
 */
function renderGoals() {
  const budgeted = data.categories
    .filter((c) => !c.is_group && c.counts_as_spending)
    .reduce((s, c) => s + (chosen.get(c.id) ?? 0), 0);

  const deferrals =
    (num('gross_tony') * num('defer_tony')) / 100 + (num('gross_sophia') * num('defer_sophia')) / 100;

  const netIncome = context ? context.projected_income : 0;
  // Gross where it is known, because a deferral is part of what was earned.
  const grossIncome = netIncome + deferrals;

  const surplus = netIncome - budgeted;
  const rate = grossIncome > 0 ? ((surplus + deferrals) / grossIncome) * 100 : null;

  $('g-income').textContent = netIncome ? money(netIncome) : '—';
  $('g-income-note').textContent = netIncome
    ? deferrals
      ? `${money(grossIncome)} gross, incl. ${money(deferrals)} deferred`
      : `projected from ${context.months_elapsed} months`
    : 'no income recorded yet';

  $('g-spend').textContent = money(budgeted);

  $('g-surplus').textContent = money(surplus);
  $('g-surplus').className = `v num ${surplus < 0 ? 'bad' : 'good'}`;
  $('g-surplus-note').textContent = surplus < 0 ? 'budget exceeds income' : 'income less budget';

  const rateTarget = num('rate_target');
  $('g-rate').textContent = rate === null ? '—' : `${rate.toFixed(1)}%`;
  $('g-rate').className = `v num ${rate === null ? '' : rate < 0 ? 'bad' : rateTarget && rate >= rateTarget ? 'good' : ''}`;

  // Months of the budget the emergency fund would cover. A more motivating
  // framing than a percentage: cutting spending lengthens the runway.
  const monthly = budgeted / 12;
  const efMonths = context && monthly > 0 ? context.emergency_fund / monthly : null;
  const efTarget = num('ef_target') || 6;
  $('g-ef').textContent = efMonths === null ? '—' : `${efMonths.toFixed(1)} mo`;
  $('g-ef').className = `v num ${efMonths === null ? '' : efMonths >= efTarget ? 'good' : efMonths < 3 ? 'bad' : ''}`;
  $('g-ef-note').textContent = context
    ? `${money(context.emergency_fund)} · target ${efTarget} months`
    : 'months of budgeted spending';

  // Contributions the ledger can see, plus deferrals it cannot.
  const contributions = context ? context.contributions : 0;
  const retirement = contributions + deferrals;
  const retirementPct = grossIncome > 0 ? (retirement / grossIncome) * 100 : null;
  $('g-ret').textContent = retirementPct === null ? '—' : `${retirementPct.toFixed(1)}%`;
  $('g-ret-note').textContent = deferrals
    ? `${money(contributions)} contributed + ${money(deferrals)} deferred`
    : contributions
      ? `${money(contributions)} contributed · add deferrals below`
      : 'add salary and deferral % below';
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
  renderGoals();
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
  renderGoals();
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
    const [baseline, cashflow, accounts, loaded] = await Promise.all([
      api(`/budgets/baseline?year=${year}`),
      api(`/cashflow?from=${year}-01-01&to=${year + 1}-01-01`),
      api('/accounts'),
      api('/settings'),
    ]);
    data = baseline;
    settings = loaded || {};

    // Projected from the year so far. Crude on purpose — a mid-year job change
    // makes anything more elaborate a pretence at precision, and the assumption
    // is stated rather than buried.
    const elapsed = baseline.months_elapsed || 12;
    context = {
      months_elapsed: elapsed,
      projected_income: cashflow.income > 0 ? (cashflow.income / elapsed) * 12 : 0,
      contributions: cashflow.saved > 0 ? (cashflow.saved / elapsed) * 12 : 0,
      // Matched by nickname, which is how the Ally accounts got readable names
      // from the statement filenames in the first place.
      emergency_fund: accounts
        .filter((a) => /emergency/i.test(a.nickname || a.name))
        .reduce((s, a) => s + a.current_balance, 0),
    };

    for (const [key, id] of Object.entries(SETTING_FIELDS)) {
      if (settings[key] !== undefined) $(id).value = settings[key];
    }
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

const SETTING_FIELDS = {
  gross_tony: 's-gross-tony',
  defer_tony: 's-defer-tony',
  gross_sophia: 's-gross-sophia',
  defer_sophia: 's-defer-sophia',
  ef_target: 's-ef-target',
  rate_target: 's-rate-target',
};

async function saveSettings() {
  const body = {};
  for (const [key, id] of Object.entries(SETTING_FIELDS)) body[key] = $(id).value.trim() || null;
  try {
    settings = await api('/settings', { method: 'PUT', body });
    renderGoals();
    toast('Assumptions saved.');
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
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
  $('save-settings').addEventListener('click', saveSettings);
  // Live, so the goals move while the assumptions are being typed.
  for (const id of Object.values(SETTING_FIELDS)) {
    $(id).addEventListener('input', () => {
      const key = Object.keys(SETTING_FIELDS).find((k) => SETTING_FIELDS[k] === id);
      settings[key] = $(id).value;
      renderGoals();
    });
  }
  $('accept-all').addEventListener('click', () => {
    for (const c of data.categories) chosen.set(c.id, Math.round(c.suggested_annual));
    render();
    toast('Suggestions applied — review, then Save.');
  });

  load(thisYear);
});
