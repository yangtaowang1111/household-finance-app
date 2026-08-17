/* Shared by every screen: the API client, the key gate, and formatting.
   Loaded before each page's own script. */

const KEY_STORE = 'ledger.apiKey';

const $ = (id) => document.getElementById(id);

const money = (n, opts = {}) => {
  if (n === null || n === undefined) return '—';
  const sign = n < 0 ? '-' : opts.showPlus && n > 0 ? '+' : '';
  const abs = Math.abs(n);
  const digits = opts.cents ? 2 : 0;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

/** "2026-02-10" -> "Feb 10". Fixed to UTC noon so the date never shifts a day. */
const shortDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: {
      'x-api-key': localStorage.getItem(KEY_STORE) || '',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch {
      // Not JSON — the status alone is the whole story.
    }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* The API is key-protected and a browser cannot put a header on a document
   request, so the key is asked for once and kept in localStorage. Enough for
   one household behind Tailscale; real session auth is still open. */
function showGate(rejected) {
  $('gate').hidden = false;
  $('app').hidden = true;
  const err = $('gate-err');
  if (err) err.hidden = !rejected;
  $('gate-key').focus();
}

function startPage(load) {
  const submit = () => {
    const key = $('gate-key').value.trim();
    if (!key) return;
    localStorage.setItem(KEY_STORE, key);
    $('gate').hidden = true;
    $('app').hidden = false;
    load();
  };
  $('gate-go').addEventListener('click', submit);
  $('gate-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  if (localStorage.getItem(KEY_STORE)) {
    $('app').hidden = false;
    load();
  } else {
    showGate(false);
  }
}

function showError(message) {
  const box = $('errors');
  if (box) box.innerHTML = `<div class="error"><strong>Couldn't load.</strong> ${escapeHtml(message)}</div>`;
}
