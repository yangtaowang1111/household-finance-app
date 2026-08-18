/* Rules and imports.
 *
 * The rules half exists because a bad rule is worse than a bad transaction: it
 * runs ahead of the categoriser on every future import, so it is silent and it
 * repeats. Until this page there was no way to see one, let alone remove it.
 *
 * The import half replaces scp-then-ssh with a file picker. */

let rules = [];
let categories = [];

// Below this a pattern matches on very little, and is worth a second look
// before it quietly files something it should not. Length is only a proxy —
// plenty of real merchants have short names — so a rule can be accepted, and
// then it stops being flagged. A warning that cannot be cleared gets ignored.
const SHORT_PATTERN = 8;

const needsLook = (r) => r.merchant_pattern.length < SHORT_PATTERN && !r.reviewed;

function categoryOptions(selectedId) {
  const groups = {};
  for (const c of categories) (groups[c.group_name || c.name] ||= []).push(c);
  return Object.entries(groups)
    .map(
      ([g, list]) =>
        `<optgroup label="${escapeHtml(g)}">` +
        list.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('') +
        '</optgroup>'
    )
    .join('');
}

function renderRules() {
  const term = $('rule-search').value.trim().toLowerCase();
  const shown = term
    ? rules.filter((r) => r.merchant_pattern.toLowerCase().includes(term))
    : rules;

  const risky = rules.filter(needsLook).length;
  $('rule-count').textContent =
    `${shown.length} of ${rules.length}` + (risky ? ` · ${risky} short and unreviewed` : ' · all reviewed');

  if (!shown.length) {
    $('rules').innerHTML = '<div class="skeleton">No rules match.</div>';
    return;
  }

  $('rules').innerHTML = `
    <table>
      <thead><tr>
        <th>Pattern</th><th>Files as</th><th>Review</th><th></th>
      </tr></thead>
      <tbody>${shown.map(renderRule).join('')}</tbody>
    </table>`;

  $('rules').querySelectorAll('[data-cat]').forEach((el) =>
    el.addEventListener('change', () => update(Number(el.dataset.cat), { category_id: Number(el.value) }))
  );
  $('rules').querySelectorAll('[data-review]').forEach((el) =>
    el.addEventListener('change', () => update(Number(el.dataset.review), { always_review: el.checked }))
  );
  $('rules').querySelectorAll('[data-show]').forEach((el) =>
    el.addEventListener('click', () => showMatches(Number(el.dataset.show)))
  );
  $('rules').querySelectorAll('[data-ok]').forEach((el) =>
    el.addEventListener('click', () => update(Number(el.dataset.ok), { reviewed: true }))
  );
  $('rules').querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', () => remove(Number(el.dataset.del)))
  );
}

function renderRule(r) {
  const flagged = needsLook(r);
  return `<tr class="${flagged ? 'warn' : ''}">
    <td class="desc">
      <span class="mono" style="font-size:12px;color:var(--text)">${escapeHtml(r.merchant_pattern)}</span>
      ${flagged ? `<span class="tag unbudgeted" title="Only ${r.merchant_pattern.length} characters — it may catch more than intended. Check &quot;matches&quot;, then accept it.">short</span>` : ''}
      ${r.reviewed ? '<span class="tag" title="You have accepted this rule">✓</span>' : ''}
    </td>
    <td><select data-cat="${r.id}" style="max-width:200px">${categoryOptions(r.category_id)}</select></td>
    <td><input type="checkbox" data-review="${r.id}" ${r.always_review ? 'checked' : ''}
        title="Categorise, but still flag for review"></td>
    <td class="amt">
      <button class="confirm" data-show="${r.id}">matches</button>
      ${flagged ? `<button class="confirm" data-ok="${r.id}" title="Accept this rule and stop flagging it">looks right</button>` : ''}
      <button class="confirm" data-del="${r.id}">delete</button>
    </td>
  </tr>`;
}

async function update(id, body) {
  try {
    await api(`/rules/${id}`, { method: 'PATCH', body });
    toast('Rule updated.');
    await load();
  } catch (err) {
    toast(`Couldn't update: ${err.message}`);
  }
}

async function remove(id) {
  const rule = rules.find((r) => r.id === id);
  // Worth stating: deleting a rule does not unfile what it already categorised.
  if (!confirm(`Delete the rule for "${rule.merchant_pattern}"?\n\nTransactions it already filed keep their categories — only future ones change.`)) return;
  try {
    await api(`/rules/${id}`, { method: 'DELETE' });
    toast('Rule deleted.');
    await load();
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`);
  }
}

async function showMatches(id) {
  const rule = rules.find((r) => r.id === id);
  $('m-pattern').textContent = rule.merchant_pattern;
  $('m-rows').innerHTML = '<div class="skeleton">Checking…</div>';
  $('matches').hidden = false;
  try {
    const rows = await api(`/transactions/matching?pattern=${encodeURIComponent(rule.merchant_pattern)}`);
    $('m-rows').innerHTML = rows.length
      ? `<table><tbody>${rows
          .map(
            (t) => `<tr>
              <td class="mono">${shortDate(t.date)}</td>
              <td class="desc">${escapeHtml((t.payee || t.merchant_raw || '').slice(0, 48))}</td>
              <td class="amt num">${money(t.amount, { cents: true })}</td>
            </tr>`
          )
          .join('')}</tbody></table>`
      : '<div class="skeleton">Nothing in the ledger matches this pattern.</div>';
  } catch (err) {
    $('m-rows').innerHTML = `<div class="skeleton">${escapeHtml(err.message)}</div>`;
  }
}

/* --- imports -------------------------------------------------------------- */

async function runImport(dryRun) {
  const files = $('files').files;
  if (!files.length) return toast('Choose at least one file.');

  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('dry_run', String(dryRun));
  if ($('imp-from').value) form.append('from', $('imp-from').value);
  if ($('imp-before').value) form.append('before', $('imp-before').value);

  $('import-result').innerHTML = '<div class="skeleton">Reading…</div>';

  try {
    // FormData sets its own multipart boundary, so this bypasses the shared
    // api() helper, which assumes JSON.
    const res = await fetch('/api/import/statements', {
      method: 'POST',
      headers: { 'x-api-key': localStorage.getItem('ledger.apiKey') || '' },
      body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    renderImport(body);
  } catch (err) {
    $('import-result').innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function renderImport(r) {
  const rows = r.reports
    .map((rep) => {
      if (rep.error) {
        return `<div class="attn-item warn"><span class="dot"></span><div>
          <div class="t">${escapeHtml(rep.file)}</div>
          <div class="d">${escapeHtml(rep.error)}</div></div></div>`;
      }
      const bits = [
        `${rep.imported} imported`,
        rep.skippedOutsideWindow ? `${rep.skippedOutsideWindow} outside window` : '',
        rep.skippedDuplicate ? `${rep.skippedDuplicate} already present` : '',
        rep.signAnomalies.length ? `⚠ ${rep.signAnomalies.length} sign anomalies` : '',
      ].filter(Boolean);
      return `<div class="attn-item"><span class="dot"></span><div>
        <div class="t">${escapeHtml(rep.file)} → ${escapeHtml(rep.account || '')}</div>
        <div class="d">${rep.format} · ${bits.join(' · ')}</div></div></div>`;
    })
    .join('');

  $('import-result').innerHTML = `
    <div style="margin-top:14px">
      <div class="v num" style="font-size:19px;font-weight:600">
        ${r.dry_run ? 'Would import' : 'Imported'} ${r.imported.toLocaleString('en-US')} transactions
      </div>
      <div class="sub" style="margin-bottom:10px">
        ${r.files} files${r.skipped ? `, ${r.skipped} could not be matched to an account` : ''}
        ${r.dry_run ? ' · nothing was written' : ` · ${r.uncategorized} transactions now need categorising`}
      </div>
      ${rows}
    </div>`;
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
    const [ruleList, cats] = await Promise.all([api('/rules'), api('/categories')]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    categories = cats.map((c) => ({
      ...c,
      group_name: c.parent_category_id ? (byId.get(c.parent_category_id) || {}).name : null,
    }));
    rules = ruleList;
    renderRules();
    $('foot').textContent = `${rules.length} rules`;
  } catch (err) {
    if (err.unauthorized) return showGate(true);
    showError(err.message);
  }
}

startPage(() => {
  $('rule-search').addEventListener('input', renderRules);
  $('dry-run').addEventListener('click', () => runImport(true));
  $('do-import').addEventListener('click', () => runImport(false));
  $('m-close').addEventListener('click', () => { $('matches').hidden = true; });
  $('matches').addEventListener('click', (e) => { if (e.target.id === 'matches') $('matches').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('matches').hidden = true; });
  load();
});
