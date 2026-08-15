// Thin HTTP client for the SimpleFIN Bridge API.
//
// The access URL embeds credentials as basic-auth userinfo
// (https://user:pass@host/simplefin). We strip them out of the URL and send an
// explicit Authorization header instead, so the credential never ends up in a
// logged URL, an error message, or a redirect target.

const ACCESS_URL_ENV = 'SIMPLEFIN_ACCESS_URL';

// Generous, because SimpleFIN fans out to several banks behind one request and
// a 13-account pull genuinely takes a few seconds.
const REQUEST_TIMEOUT_MS = 60_000;

function parseAccessUrl(accessUrl) {
  const parsed = new URL(accessUrl);
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

/**
 * Fetches accounts (and optionally transactions) from SimpleFIN.
 *
 * @param {object} [options]
 * @param {boolean} [options.balancesOnly] Skip transaction bodies entirely.
 * @param {Date}    [options.startDate]    Earliest transaction to return.
 * @param {boolean} [options.pending]      Include not-yet-posted transactions.
 * @returns {Promise<{accounts: object[], errors: string[]}>}
 */
async function fetchAccounts(options = {}) {
  const accessUrl = process.env[ACCESS_URL_ENV];
  if (!accessUrl) {
    throw new Error(`${ACCESS_URL_ENV} is not set. Redeem a SimpleFIN setup token first.`);
  }

  const { baseUrl, authHeader } = parseAccessUrl(accessUrl);
  const url = new URL(`${baseUrl}/accounts`);
  if (options.balancesOnly) url.searchParams.set('balances-only', '1');
  if (options.startDate) {
    url.searchParams.set('start-date', String(Math.floor(options.startDate.getTime() / 1000)));
  }
  if (options.pending) url.searchParams.set('pending', '1');

  // Node's fetch has no default timeout, and this runs unattended from cron. A
  // stalled request would otherwise hang forever without writing a sync_runs
  // row — indistinguishable from cron never firing — while the next night's job
  // starts a second run against the same database. The timeout turns a hang
  // into an ordinary failure the caller already knows how to record.
  const response = await fetch(url, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Deliberately does not include the URL — it would leak the credential.
    throw new Error(`SimpleFIN request failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    // SimpleFIN reports per-institution problems here (e.g. a bank needing
    // re-authentication) while still returning whatever else it could fetch.
    // A partial success must not look like a clean sync.
    errors: Array.isArray(data.errors) ? data.errors : [],
  };
}

module.exports = { fetchAccounts, parseAccessUrl };
