/* Accounts. Mostly a list, but it owns the two things only a person can supply:
   what an account should be called, and what a property is worth. */

let accounts = [];
let networth = null;
let editing = null;

const TYPE_LABEL = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit cards',
  investment: 'Investments',
  mortgage: 'Mortgages',
  loan: 'Loans',
  property: 'Property',
};

// Assets first, then what is owed. Within that, the order a person thinks in.
const TYPE_ORDER = ['checking', 'savings', 'investment', 'property', 'credit', 'loan', 'mortgage'];

const isAsset = (type) => ['checking', 'savings', 'investment', 'property'].includes(type);

function renderTotals() {
  if (!networth) return;
  const stat = (label, value, sub, tone) =>
    `<div><div class="eyebrow">${label}</div><div class="v num ${tone || ''}">${value}</div>` +
    `<div class="sub">${sub || ''}</div></div>`;

  const stale = accounts.filter((a) => a.type === 'property').length;
  $('totals').innerHTML = [
    stat('Net worth', money(networth.net_worth), `${accounts.length} accounts`),
    stat('Assets', money(networth.assets), ''),
    stat('Liabilities', money(networth.liabilities), ''),
    stale ? stat('Valued by hand', String(stale), 'properties — update when they move') : '',
  ].join('');
}

function renderGroups() {
  const byType = new Map();
  for (const a of accounts) {
    if (!byType.has(a.type)) byType.set(a.type, []);
    byType.get(a.type).push(a);
  }

  const order = TYPE_ORDER.filter((t) => byType.has(t));
  $('groups').innerHTML = order
    .map((type) => {
      const list = byType.get(type).sort((a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance));
      const total = list.reduce((s, a) => s + a.current_balance, 0);

      return `
      <section class="card" style="margin-bottom:14px" ${type === 'property' ? 'id="property"' : ''}>
        <div class="card-head">
          <span class="eyebrow">${TYPE_LABEL[type]} · ${list.length}</span>
          <span class="v num" style="font-weight:600">${money(total)}</span>
        </div>
        ${list.map((a) => renderAccount(a, type)).join('')}
      </section>`;
    })
    .join('');

  $('groups').querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(Number(btn.dataset.edit)));
  });
}

function renderAccount(a, type) {
  // A property's linked loan, so equity reads on the same line as the value.
  const property = networth && networth.properties.find((p) => p.id === a.id);
  const equity =
    property && property.equity !== null
      ? `<div class="sub">Mortgage ${money(property.mortgage)} · equity <strong class="num">${money(property.equity)}</strong></div>`
      : property
        ? '<div class="sub" style="color:var(--attn)">No mortgage linked — equity unknown</div>'
        : '';

  const badges = [
    a.source === 'manual' ? '<span class="tag">manual</span>' : '',
    !a.type_confirmed && a.source === 'simplefin' ? '<span class="tag unbudgeted">type unconfirmed</span>' : '',
    a.owner ? `<span class="tag">${escapeHtml(a.owner)}</span>` : '',
  ].join('');

  return `
  <div class="row">
    <div>
      <div class="label">${escapeHtml(a.nickname || a.name)}${badges}</div>
      ${a.nickname ? `<div class="sub">${escapeHtml(a.name)}</div>` : ''}
      ${equity}
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span class="v num ${isAsset(type) ? '' : 'bad'}">${money(a.current_balance)}</span>
      <button class="confirm" data-edit="${a.id}" title="Edit">edit</button>
    </div>
  </div>`;
}

/* --- editing -------------------------------------------------------------- */

function openEditor(id) {
  editing = accounts.find((a) => a.id === id);
  if (!editing) return;

  $('ed-what').textContent = editing.name;
  $('ed-nickname').value = editing.nickname || '';
  $('ed-owner').value = editing.owner || '';
  $('ed-type').value = editing.type;

  // A loan can name the property securing it; only a person knows which.
  const isLoan = ['mortgage', 'loan'].includes(editing.type);
  $('ed-secured-wrap').hidden = !isLoan;
  $('ed-secured').innerHTML =
    '<option value="">Not linked to a property</option>' +
    accounts
      .filter((a) => a.type === 'property')
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === editing.secured_by_account_id ? 'selected' : ''}>${escapeHtml(
            p.nickname || p.name
          )}</option>`
      )
      .join('');

  // Balance is editable only where no bank supplies it. Overwriting a synced
  // balance would last until the next sync and confuse everything in between.
  const manual = editing.source === 'manual' || editing.type === 'property';
  $('ed-balance-wrap').hidden = !manual;
  $('ed-balance').value = editing.current_balance;

  $('editor').hidden = false;
}

function closeEditor() {
  $('editor').hidden = true;
  editing = null;
}

async function saveEdit() {
  if (!editing) return closeEditor();
  const id = editing.id;

  const meta = {
    nickname: $('ed-nickname').value.trim() || null,
    owner: $('ed-owner').value.trim() || null,
    type: $('ed-type').value,
  };
  if (!$('ed-secured-wrap').hidden) {
    meta.secured_by_account_id = $('ed-secured').value ? Number($('ed-secured').value) : null;
  }

  try {
    await api(`/accounts/${id}`, { method: 'PATCH', body: meta });

    // Separate call, because a balance change also writes a snapshot — that is
    // the whole reason it is not just another field.
    if (!$('ed-balance-wrap').hidden) {
      const next = Number($('ed-balance').value);
      if (Number.isFinite(next) && next !== editing.current_balance) {
        await api(`/accounts/${id}/balance`, { method: 'PATCH', body: { current_balance: next } });
      }
    }

    closeEditor();
    toast('Saved.');
    await load();
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

async function load() {
  try {
    const [list, nw] = await Promise.all([api('/accounts'), api('/networth')]);
    accounts = list;
    networth = nw;
    renderTotals();
    renderGroups();
    $('foot').textContent = `${accounts.length} accounts`;
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(() => {
  $('ed-cancel').addEventListener('click', closeEditor);
  $('ed-save').addEventListener('click', saveEdit);
  $('editor').addEventListener('click', (e) => { if (e.target.id === 'editor') closeEditor(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEditor(); });
  $('ed-type').addEventListener('change', () => {
    $('ed-secured-wrap').hidden = !['mortgage', 'loan'].includes($('ed-type').value);
  });
  load();
});
