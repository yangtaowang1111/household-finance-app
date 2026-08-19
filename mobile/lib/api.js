/* Talking to the NAS.
 *
 * Two things have to be configured before anything works, and both are stored
 * on the device rather than compiled in: where the API lives, and the key.
 * Compiling either in would mean rebuilding the app to change the address, and
 * would put the key in the repository.
 *
 * The address is a Tailscale IP. The phone reaches the NAS only while on the
 * tailnet — there is no public port, by design — so a connection failure here
 * usually means Tailscale is off rather than the server being down. The error
 * text says so, because "Network request failed" sends you to the wrong place.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_BASE = 'ledger.baseUrl';
const KEY_API = 'ledger.apiKey';

// The NAS on the tailnet. Overridable in Settings, because it is the one thing
// that differs between a phone at home and a phone anywhere else.
export const DEFAULT_BASE_URL = 'http://100.99.152.23:3000';

let cache = { baseUrl: null, apiKey: null };

export async function loadConfig() {
  const [baseUrl, apiKey] = await Promise.all([
    AsyncStorage.getItem(KEY_BASE),
    AsyncStorage.getItem(KEY_API),
  ]);
  cache = { baseUrl: baseUrl || DEFAULT_BASE_URL, apiKey: apiKey || null };
  return cache;
}

export async function saveConfig({ baseUrl, apiKey }) {
  if (baseUrl !== undefined) await AsyncStorage.setItem(KEY_BASE, baseUrl || DEFAULT_BASE_URL);
  if (apiKey !== undefined) {
    if (apiKey) await AsyncStorage.setItem(KEY_API, apiKey);
    else await AsyncStorage.removeItem(KEY_API);
  }
  return loadConfig();
}

export function isConfigured() {
  return Boolean(cache.apiKey);
}

export async function api(path, options = {}) {
  if (!cache.apiKey) await loadConfig();
  if (!cache.apiKey) {
    const err = new Error('No API key set yet.');
    err.needsSetup = true;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${cache.baseUrl}/api${path}`, {
      method: options.method || 'GET',
      headers: {
        'x-api-key': cache.apiKey,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    // Almost always Tailscale rather than the server. Saying so saves a
    // pointless trip to the NAS to check something that is running fine.
    throw new Error(
      `Could not reach ${cache.baseUrl}. Check Tailscale is connected on this device.`
    );
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error('That API key was rejected.');
    err.needsSetup = true;
    throw err;
  }
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch {
      // Not JSON; the status is the whole story.
    }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* --- formatting, matched to the web app ----------------------------------- */

export const money = (n, opts = {}) => {
  if (n === null || n === undefined) return '—';
  const sign = n < 0 ? '-' : opts.showPlus && n > 0 ? '+' : '';
  const digits = opts.cents ? 2 : 0;
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

/** Fixed to UTC noon so a date never shifts a day on the way to the screen. */
export const shortDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
