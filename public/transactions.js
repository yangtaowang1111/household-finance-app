/* Transactions. The one screen where things get changed, so most of the work
   here is about making a correction cheap and its consequences visible. */

let categories = [];   // flat, with group names attached
let accounts = [];
let rows = [];
let editing = null;    // the transaction open in the editor
const selected = new Set();

/* --- filters, held in the URL --------------------------------------------- */

/* Kept in the query string rather than in memory so the Overview can link
   straight to a filtered view, the back button works, and a filtered list can
   be bookmarked or sent to someone. */
const FILTERS = ['search', 'group', 'account_id', 'month', 'min_amount', 'needs_review', 'uncategorized', 'possible_duplicates'];

function readFilters() {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(FILTERS.filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
}

function writeFilters(next) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function currentFilters() {
  const f = {};
  if ($('f-search').value.trim()) f.search = $('f-search').value.trim();
  if ($('f-group').value) f.group = $('f-group').value;
  if ($('f-account').value) f.account_id = $('f-account').value;
  if ($('f-month').value) f.month = $('f-month').value;
  if ($('f-min').value) f.min_amount = $('f-min').value;
  if ($('f-review').checked) f.needs_review = '1';
  if ($('f-uncat').checked) f.uncategorized = '1';
  if ($('f-dupes').checked) f.possible_duplicates = '1';
  return f;
}

function applyFiltersToControls(f) {
  $('f-search').value = f.search || '';
  $('f-group').value = f.group || '';
  $('f-account').value = f.account_id || '';
  $('f-month').value = f.month || '';
  $('f-min').value = f.min_amount || '';
  $('f-review').checked = Boolean(f.needs_review);
  $('f-uncat').checked = Boolean(f.uncategorized);
  $('f-dupes').checked = Boolean(f.possible_duplicates);
}

function describe(f) {
  if (f.group) return `${f.group} transactions`;
  if (f.needs_review) return 'Needs review';
  if (f.uncategorized) return 'Uncategorised';
  if (f.possible_duplicates) return 'Possible duplicates';
  if (f.account_id) {
    const a = accounts.find((x) => String(x.id) === String(f.account_id));
    return a ? (a.nickname || a.name) : 'Account';
  }
  return 'All transactions';
}

/* --- rendering ------------------------------------------------------------ */

const PROVENANCE = {
  rule: ['rule', 'Set by a learned rule — fixing the rule fixes every future one'],
  ai: ['ai', 'Guessed by the categoriser'],
  manual: ['you', 'You set this'],
  import: ['import', 'Came in already categorised from the 2025 spreadsheet'],
};

function render() {
  $('result-count').textContent = `${rows.length.toLocaleString('en-US')}${rows.length === 2000 ? '+ (showing first 2000)' : ''}`;

  if (!rows.length) {
    $('list').innerHTML = '<div class="skeleton">Nothing matches those filters.</div>';
    return;
  }

  $('list').innerHTML = `
    <table>
      <thead>
        <tr>
          <th class="pick"><input type="checkbox" id="pick-all" aria-label="Select all"></th>
          <th>Date</th><th>Description</th><th>Category</th><th>Account</th>
          <th style="text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(renderRow).join('')}
      </tbody>
    </table>`;

  $('pick-all').addEventListener('change', (e) => {
    selected.clear();
    if (e.target.checked) rows.forEach((t) => selected.add(t.id));
    render();
    updateBulkBar();
  });

  $('list').querySelectorAll('[data-pick]').forEach((box) => {
    box.addEventListener('change', () => {
      const id = Number(box.dataset.pick);
      if (box.checked) selected.add(id); else selected.delete(id);
      updateBulkBar();
    });
  });

  $('list').querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(Number(btn.dataset.edit)));
  });
}

function renderRow(t) {
  const prov = t.categorized_by && PROVENANCE[t.categorized_by];
  const flagged = t.possible_duplicate_of || /^AI confidence: low/.test(t.notes || '');
  const note = t.notes && !/^AI confidence: low/.test(t.notes) ? t.notes : null;

  return `<tr class="${flagged ? 'flagged' : ''}">
    <td class="pick"><input type="checkbox" data-pick="${t.id}" ${selected.has(t.id) ? 'checked' : ''} aria-label="Select"></td>
    <td class="mono">${shortDate(t.date)}</td>
    <td class="desc">
      ${escapeHtml((t.payee || t.merchant_raw || '').slice(0, 64))}
      ${note ? `<div class="sub">${escapeHtml(note)}</div>` : ''}
      ${t.possible_duplicate_of ? '<div class="sub" style="color:var(--attn)">Possible duplicate of #' + t.possible_duplicate_of + '</div>' : ''}
    </td>
    <td>
      <button class="cat-btn ${t.category_name ? '' : 'none'}" data-edit="${t.id}">
        ${t.category_name ? escapeHtml(t.category_name) : 'Uncategorised'}
      </button>
      ${prov ? `<span class="prov ${t.categorized_by}" title="${escapeHtml(prov[1])}">${prov[0]}</span>` : ''}
    </td>
    <td class="mono">${escapeHtml(t.account_nickname || t.account_name || '')}</td>
    <td class="amt num ${t.amount > 0 ? 'in' : ''}">${money(t.amount, { showPlus: true, cents: true })}</td>
  </tr>`;
}

function updateBulkBar() {
  const bar = $('bulkbar');
  bar.hidden = selected.size === 0;
  $('bulk-count').textContent = `${selected.size} selected`;
}

/* --- the editor ----------------------------------------------------------- */

function categoryOptions(selectedId) {
  const groups = {};
  for (const c of categories) {
    const key = c.group_name || c.name;
    (groups[key] ||= []).push(c);
  }
  return Object.entries(groups)
    .map(
      ([g, list]) =>
        `<optgroup label="${escapeHtml(g)}">` +
        list
          .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
          .join('') +
        '</optgroup>'
    )
    .join('');
}

function openEditor(id) {
  editing = rows.find((t) => t.id === id);
  if (!editing) return;

  $('ed-what').textContent = editing.payee || editing.merchant_raw || `Transaction #${editing.id}`;
  $('ed-meta').textContent = `${shortDate(editing.date)} · ${money(editing.amount, { cents: true, showPlus: true })} · ${editing.account_nickname || editing.account_name}`;
  $('ed-cat').innerHTML = categoryOptions(editing.category_id);
  $('ed-note').value = editing.notes && !/^AI confidence: low/.test(editing.notes) ? editing.notes : '';
  $('ed-learn').checked = false;
  updateLearnHint();
  $('editor').hidden = false;
  $('ed-cat').focus();
}

/* Says out loud what the rule would catch. A rule is applied ahead of the
   categoriser on every future import, so "12 other transactions match this"
   is the difference between a useful shortcut and a silent mistake. */
async function updateLearnHint() {
  const hint = $('ed-learn-hint');
  if (!$('ed-learn').checked) {
    hint.textContent = 'Off: only this transaction changes.';
    return;
  }
  const pattern = editing.payee || editing.merchant_raw || '';
  hint.textContent = 'Checking what else this would match…';
  try {
    const matches = await api(`/transactions/matching?pattern=${encodeURIComponent(pattern.slice(0, 40))}`);
    const others = matches.filter((m) => m.id !== editing.id).length;
    hint.textContent = others
      ? `Will also catch ${others} existing transaction${others > 1 ? 's' : ''} matching "${pattern.slice(0, 30)}" in future imports.`
      : `Future transactions matching "${pattern.slice(0, 30)}" will use this category.`;
  } catch {
    hint.textContent = 'Future transactions from this merchant will use this category.';
  }
}

async function saveEdit() {
  const categoryId = Number($('ed-cat').value);
  const learn = $('ed-learn').checked;
  const note = $('ed-note').value.trim();

  try {
    const updated = await api(`/transactions/${editing.id}/category`, {
      method: 'PATCH',
      body: { category_id: categoryId, learn_rule: learn, notes: note || null },
    });
    $('editor').hidden = true;
    toast(
      updated.rule_learned
        ? `Recategorised, and future ones will follow.`
        : 'Recategorised.'
    );
    await load();
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

async function applyBulk() {
  const categoryId = Number($('bulk-cat').value);
  if (!categoryId) return toast('Pick a category first.');
  try {
    const r = await api('/transactions/bulk/category', {
      method: 'PATCH',
      body: { ids: [...selected], category_id: categoryId },
    });
    toast(`${r.updated} transactions recategorised.`);
    selected.clear();
    updateBulkBar();
    await load();
  } catch (err) {
    toast(`Couldn't apply: ${err.message}`);
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

/* --- load ----------------------------------------------------------------- */

function monthOptions() {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 20; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push(`<option value="${iso}">${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</option>`);
  }
  return months.join('');
}

async function loadReferenceData() {
  const [cats, accts] = await Promise.all([api('/categories'), api('/accounts')]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  categories = cats
    .map((c) => ({ ...c, group_name: c.parent_category_id ? (byId.get(c.parent_category_id) || {}).name : null }))
    // Groups themselves are selectable, but children come first in each list.
    .sort((a, b) => (a.group_name || a.name).localeCompare(b.group_name || b.name) || a.name.localeCompare(b.name));
  accounts = accts;

  $('f-group').innerHTML =
    '<option value="">All groups</option>' +
    cats
      .filter((c) => !c.parent_category_id)
      .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
      .join('');

  $('f-account').innerHTML =
    '<option value="">All accounts</option>' +
    accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.nickname || a.name)}</option>`).join('');

  $('f-month').innerHTML = '<option value="">All months</option>' + monthOptions();
  $('bulk-cat').innerHTML = '<option value="">Move to category…</option>' + categoryOptions(null);
}

async function load() {
  const filters = currentFilters();
  writeFilters(filters);
  $('heading').textContent = describe(filters);

  const params = new URLSearchParams({ ...filters, limit: '2000' });
  try {
    rows = await api(`/transactions?${params}`);
    // Selections that are no longer on screen would otherwise be applied
    // invisibly by the next bulk action.
    const visible = new Set(rows.map((t) => t.id));
    for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
    render();
    updateBulkBar();
    $('nav-txns').textContent = rows.length >= 2000 ? '2000+' : String(rows.length);
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

function wire() {
  let debounce;
  $('f-search').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  });
  ['f-group', 'f-account', 'f-month', 'f-min', 'f-review', 'f-uncat', 'f-dupes'].forEach((id) =>
    $(id).addEventListener('change', load)
  );
  $('f-clear').addEventListener('click', () => {
    applyFiltersToControls({});
    load();
  });

  $('ed-cancel').addEventListener('click', () => { $('editor').hidden = true; });
  $('ed-save').addEventListener('click', saveEdit);
  $('ed-learn').addEventListener('change', updateLearnHint);
  $('editor').addEventListener('click', (e) => { if (e.target.id === 'editor') $('editor').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('editor').hidden = true; });

  $('bulk-go').addEventListener('click', applyBulk);
  $('bulk-cancel').addEventListener('click', () => { selected.clear(); render(); updateBulkBar(); });
}

startPage(async () => {
  try {
    await loadReferenceData();
    applyFiltersToControls(readFilters());
    wire();
    await load();
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
});
