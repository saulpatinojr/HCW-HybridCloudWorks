/**
 * labs/coder-api.js — how the site reaches the lab's Coder (coder-status.js
 * has the header that explains the reads): the settings, the one guarded GET
 * every call makes, and what a status token must look like and may do.
 * coder-status.js re-exports what callers use.
 */
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { readSetting } from '../http/read-setting.js';
import { MINUTE_CACHE_SECONDS } from './minute-cache.js';

export const CODER_STATUS_CACHE_ID = 'labs:coder-status';
/** Coder's last answers to the status token (#1009): admin_config, read by the health pulse. */
export const TOKEN_STATE_DOC_ID = 'coder_status_token';
export const TOKEN_STATE_DOC_TYPE = 'coder_status_token';
/**
 * What the token was used for, each with its own answers: the labs status
 * read (and the scheduled check, which makes the same two calls), and the
 * Integrations card's read of the token's own key record.
 */
export const TOKEN_OPERATIONS = Object.freeze(['status', 'expiry']);
/**
 * An unchanged answer is written again at most this often, so the record's
 * age says how fresh the evidence is without a write for every minute's read.
 */
export const TOKEN_STATE_REFRESH_MS = 60 * 60 * 1000;
/**
 * The start of the warning a 401 for the status token writes, fixed so a log
 * alert can match it (`message startswith`). Content-free: a setting's name
 * and a status.
 */
export const TOKEN_REFUSED_401_LOG = 'coder-status: Coder refused CODER_STATUS_TOKEN (401)';
export const CODER_STATUS_CACHE_SECONDS = MINUTE_CACHE_SECONDS;
/** A Coder that has not answered in five seconds is reported unreachable, not waited for. */
export const CODER_TIMEOUT_MS = 5_000;
/** Community edition's concurrency cap (ADR 0032 §4), when CODER_MAX_WORKSPACES says nothing. */
export const DEFAULT_CODER_MAX_WORKSPACES = 5;
/** Templates shown, and therefore version lookups made, per refresh. */
export const MAX_TEMPLATES = 10;

/** The Integrations card turns red this many days before the status token expires (#763). */
export const TOKEN_RENEW_WARNING_DAYS = 30;

/**
 * The Coder scope that lets a token read its own record (`GET
 * /api/v2/users/me/keys/{id}`), documented by Coder as "View API keys". A
 * token scoped to `template:read` and `workspace:read` alone is refused that
 * read, so the card can only say "unknown" until the token is re-issued
 * with this scope added (lab-host/README.md, "The status token for the site").
 *
 * THE REFUSAL IS A 404, NOT A 403. Coder v2.38.0's `apiKeyByID` answers
 * through `httpapi.Is404Error`, which counts an authorization failure as not
 * found ("Both actual 404s and unauthorized errors should return 404s"), so
 * a token without this scope reads its own record as missing. Until #1009
 * only 403 meant "scope", and the expiry check could never say what to do.
 * A 404 for the token's own id cannot mean the record is absent: Coder has
 * just authenticated the request with that very key.
 */
export const TOKEN_SCOPE_FOR_EXPIRY = 'api_key:read';

/** The statuses Coder refuses an unscoped own-record read with: 403, and 404 since v2.38. */
export const SCOPE_REFUSAL_STATUSES = Object.freeze([403, 404]);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An app setting that is actually set. Lives in lib/http/read-setting.js
 * since ADR 0035, so the AddOn status proxy reads settings the same way
 * without importing this module; re-exported here for its callers.
 */
export { readSetting };

/** CODER_MAX_WORKSPACES as a positive integer, or the Community cap. */
export function readMaxWorkspaces(env) {
  const parsed = Number.parseInt(readSetting(env, 'CODER_MAX_WORKSPACES'), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CODER_MAX_WORKSPACES;
}

/**
 * The proxy's configuration, or null when it has none. Only the address
 * decides: `token` is '' when CODER_STATUS_TOKEN is absent or unresolved,
 * and the read then reports reachability without the detail.
 *
 * `CODER_URL` must be an `https:` URL: the token travels in a header, and a
 * plain-http address would send it in the clear to whatever answers. A URL
 * that fails that test is reported as unconfigured (and logged by the caller),
 * not used.
 *
 * @returns {{ base: string, token: string, max: number } | null}
 */
export function readCoderConfig(env = process.env) {
  const rawUrl = readSetting(env, 'CODER_URL');
  if (!rawUrl) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    token: readSetting(env, 'CODER_STATUS_TOKEN'),
    max: readMaxWorkspaces(env),
  };
}

/** The address is set but unusable — worth one warning line. */
export const hasCoderUrl = (env) => Boolean(readSetting(env, 'CODER_URL'));

/**
 * An authenticated answer no cache may keep: `private, no-store`, so a
 * browser does not show last month's expiry after a renewal. (`jsonResponse`
 * with 0 seconds only omits the header, which leaves the default heuristics.)
 */
export const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/**
 * Coder API keys are `<id>-<secret>`; the id, before the dash, is what the
 * key record is read by. '' for anything that is not that shape.
 */
export function tokenKeyId(token) {
  const match = /^([A-Za-z0-9]{6,})-[A-Za-z0-9]+$/.exec(String(token || '').trim());
  return match ? match[1] : '';
}

/**
 * A GET to Coder, with the token only when one is given. Throws on anything
 * but 2xx, a redirect included: Coder's API does not redirect, and fetch
 * following one to another origin would carry `Coder-Session-Token` along,
 * because it drops only Authorization, Cookie and Proxy-Authorization.
 * `exactly200` narrows that to 200 alone, for the reads that decide whether
 * a token may be stored (verifyStatusToken): every one of them is documented
 * as 200, and a 201 or a 204 there is not the answer the check was written
 * against.
 */
export async function coderGet(fetchImpl, config, path, token, { exactly200 = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['Coder-Session-Token'] = token;
  const response = await fetchWithTimeout(fetchImpl, `${config.base}${path}`, {
    method: 'GET',
    headers,
    redirect: 'error',
    timeoutMs: CODER_TIMEOUT_MS,
  });
  if (!response.ok || (exactly200 && response.status !== 200)) {
    throw Object.assign(new Error(`Coder answered ${response.status} for ${path}`), {
      status: response.status,
    });
  }
  return response.json();
}

/**
 * The exact shape of a Coder API key: a 10-character key id, a dash, and a
 * 22-character secret, both drawn from letters and digits. From Coder
 * v2.38.0's source, read 2026-10-08: `apikey.Generate` makes the id with
 * `cryptorand.String(10)` and the secret with `GenerateSecret(22)`, joined
 * by `fmt.Sprintf("%s-%s", keyID, keySecret)`; `cryptorand.String` draws
 * from `Default`, which is `Numeric + Alpha`. Stricter than `tokenKeyId`,
 * which only has to find the id in something already stored; this one
 * decides what may be stored at all (lib/labs/coder-automation.js).
 */
export const CODER_API_KEY_PATTERN = /^[A-Za-z0-9]{10}-[A-Za-z0-9]{22}$/;

/** The Coder user a status token must belong to, when CODER_STATUS_USER says nothing (lab-host/README.md). */
export const DEFAULT_CODER_STATUS_USER = 'hcw-status';

/**
 * The scopes a status token must carry, every one of them: the card's three
 * reads, and its own record for the expiry (TOKEN_SCOPE_FOR_EXPIRY).
 */
export const STATUS_TOKEN_SCOPES = Object.freeze(['template:read', 'workspace:read', 'api_key:read']);

/**
 * The one more it may carry: `user:read`. Coder v2.38 answers both identity
 * reads below (`/users/me` and `/users/me/keys/{id}`) through
 * `httpmw.ExtractUserParam`, which loads the caller's own user through the
 * authorizing store, and a low-level scope grants exactly its own
 * resource:action (`rbac.expandLowLevel`). So without `user:read` both reads
 * answer 404 however right the token is (source read 2026-10-08; not yet
 * measured against the lab's Coder). It reads users, and nothing else.
 */
export const STATUS_TOKEN_EXTRA_SCOPES = Object.freeze(['user:read']);

/**
 * Scope names that mean "whatever the user can do": `coder:all` and
 * `coder:application_connect` as Coder v2.38 stores them, and `all` and
 * `application_connect`, which its deprecated `scope` field still reports
 * for them (`convertAPIKey`).
 */
export const UNSCOPED_SCOPES = Object.freeze([
  'all',
  'coder:all',
  'application_connect',
  'coder:application_connect',
]);

/** CODER_STATUS_USER, or the default. A name, not a secret. */
export function readStatusUser(env = process.env) {
  return readSetting(env, 'CODER_STATUS_USER') || DEFAULT_CODER_STATUS_USER;
}

/** A scope name as Coder spells one, fit to repeat in a sentence; anything else is not repeated. */
const SCOPE_NAME = /^[a-z_]{1,40}(:[a-z_*]{1,40})?$/;

/**
 * What is wrong with a key record's scopes for a status token, or null.
 * Reads `scopes`, Coder v2.38's list, and refuses outright when it or the
 * deprecated `scope` names an unscoped key; a record with no list at all is
 * refused too, because what such a token can do cannot be checked.
 */
export function statusScopeProblem(record) {
  const scopes = Array.isArray(record?.scopes)
    ? record.scopes.filter((scope) => typeof scope === 'string')
    : null;
  const legacy = typeof record?.scope === 'string' ? record.scope : '';
  if (UNSCOPED_SCOPES.includes(legacy) || scopes?.some((scope) => UNSCOPED_SCOPES.includes(scope))) {
    return 'the token is unscoped, so it can do whatever its user can; a status token must be scoped to reading';
  }
  if (!scopes || scopes.length === 0) {
    return "Coder's record of the token lists no scopes, so what it can do could not be checked";
  }
  const permitted = new Set([...STATUS_TOKEN_SCOPES, ...STATUS_TOKEN_EXTRA_SCOPES]);
  const beyond = [...new Set(scopes.filter((scope) => !permitted.has(scope)))];
  if (beyond.length) {
    const named = beyond.filter((scope) => SCOPE_NAME.test(scope));
    const unnamed = beyond.length - named.length;
    const list = [...named, ...(unnamed ? [`${unnamed} unrecognised`] : [])].join(', ');
    return `the token carries scopes beyond reading: ${list}`;
  }
  const missing = STATUS_TOKEN_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) return `the token lacks ${missing.join(', ')}`;
  return null;
}
