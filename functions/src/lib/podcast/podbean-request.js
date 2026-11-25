/**
 * podbean-request.js — the two requests every Podbean API call is made of,
 * for the client in podbean.js: the access token (cached while it lives) and
 * one authenticated call. `c` is the client's state, built in
 * createPodbeanClient: its settings, its token cache, and the client's own
 * `scrub`, `errorDetail` and `transportError`, which keep every credential
 * out of what leaves the file. podbean.js exports the constants again.
 */
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { classify, codeNote, PodbeanError, statusAndCode } from './podbean-error.js';

export const PODBEAN_API_BASE_URL = 'https://api.podbean.com/v1';

/** JSON calls, the token exchange included. Generous because the create call may be slow. */
export const PODBEAN_TIMEOUT_MS = 30_000;

/**
 * How long before its stated expiry a cached token stops being used. A token
 * that expires between the check and the request costs the one re-auth above;
 * a minute's margin makes that the rare case rather than the boundary one.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** OAuth error codes on the token endpoint that mean "these credentials", not "try later". */
const CREDENTIAL_ERRORS = new Set(['invalid_client', 'invalid_grant', 'unauthorized_client']);

/** The body as JSON, or null when it is empty or not JSON; never throws. */
export function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Stop once the job's signal fired. */
export function stopIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
}

/** Throw NOT_CONFIGURED, with isConfigured's sentence, unless both settings are set. */
export function requireConfigured(c) {
  if (!c.configured.ok) {
    throw new PodbeanError(c.configured.reason, { status: null, code: 'NOT_CONFIGURED' });
  }
}

/** Whether a failure is the job being stopped, which is thrown on as it is. */
export const isAbort = (signal, error) => Boolean(signal?.aborted) || error?.name === 'AbortError';

/** One request to api.podbean.com; a failure with no response becomes the client's transport error. */
async function send(c, operation, url, init) {
  try {
    return await fetchWithTimeout(c.fetchImpl, url, { ...init, timeoutMs: PODBEAN_TIMEOUT_MS, signal: c.signal });
  } catch (error) {
    if (isAbort(c.signal, error)) throw error;
    throw c.transportError(operation, error);
  }
}

/** The error for a refused token request. */
function tokenRefusal(c, operation, response, data, text) {
  const detail = c.errorDetail(data, text);
  const suffix = ` (${statusAndCode(response.status, data)})`;
  const oauthError = typeof data?.error === 'string' ? data.error : '';
  if (CREDENTIAL_ERRORS.has(oauthError) || response.status === 401 || response.status === 403) {
    return new PodbeanError(
      `Podbean refused the client ID and secret while ${operation}${suffix}.`,
      { status: response.status, code: 'CREDENTIALS_REJECTED', detail, retryable: false }
    );
  }
  const { code, retryable } = classify(response.status);
  return new PodbeanError(
    `Podbean answered ${response.status} while ${operation}${codeNote(data)}.`,
    { status: response.status, code, detail, retryable }
  );
}

/**
 * POST /v1/oauth/token. Basic auth, form body, nothing in the URL. Cached
 * until `expires_in` less the margin; a response without a usable
 * `expires_in` is used for this call and not cached, rather than guessed at.
 */
export async function getToken(c) {
  stopIfAborted(c.signal);
  requireConfigured(c);
  if (c.cached && c.now() < c.cached.expiresAt) return c.cached.token;
  c.cached = null;

  const operation = 'requesting an access token';
  const response = await send(c, operation, `${PODBEAN_API_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${c.basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) throw tokenRefusal(c, operation, response, data, text);

  const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
  if (!token) {
    throw new PodbeanError('Podbean answered the token request without an access token.', {
      status: response.status,
      code: 'UPSTREAM',
      retryable: false,
    });
  }
  c.seenTokens.add(token);
  const lifetime = Number(data.expires_in);
  if (Number.isFinite(lifetime) && lifetime * 1000 > TOKEN_EXPIRY_MARGIN_MS) {
    c.cached = { token, expiresAt: c.now() + lifetime * 1000 - TOKEN_EXPIRY_MARGIN_MS };
  }
  return token;
}

/** The query values set on a GET's URL: an array repeated under its key, absent values left out. */
function setQuery(url, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
    } else if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
}

/** A POST's form body, with the token, absent values left out. */
function formBody(token, form) {
  const params = new URLSearchParams();
  params.set('access_token', token);
  for (const [key, value] of Object.entries(form || {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

/** The address and body of one call: the token on the URL for a GET, in the form for a POST. */
function buildRequest(token, method, path, { query, form }) {
  const url = new URL(`${PODBEAN_API_BASE_URL}${path}`);
  if (method !== 'GET') return { url, body: formBody(token, form) };
  url.searchParams.set('access_token', token);
  setQuery(url, query);
  return { url, body: undefined };
}

/** The error for a refused resource call (not `invalid_token`, which `call` handles). */
function callRefusal(operation, response, data, detail) {
  const oauthError = typeof data?.error === 'string' ? data.error : '';
  if (oauthError === 'storage_limit_reach') {
    return new PodbeanError(
      `Podbean refused the upload: the account's storage allowance is used up (${statusAndCode(response.status, data)}).`,
      { status: response.status, code: 'STORAGE_LIMIT', detail, retryable: false }
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new PodbeanError(
      `Podbean refused the app's access while ${operation} (${statusAndCode(response.status, data)}); ` +
        "check the app's permissions at developers.podbean.com.",
      { status: response.status, code: 'CREDENTIALS_REJECTED', detail, retryable: false }
    );
  }
  const { code, retryable } = classify(response.status);
  return new PodbeanError(
    `Podbean answered ${response.status} while ${operation}${codeNote(data)}.`,
    { status: response.status, code, detail, retryable }
  );
}

/**
 * One authenticated call. `query` goes on the URL for a GET, `form` is the
 * body of a POST; the token is added to whichever carries it. An array
 * value in `query` is repeated under its key, one entry per element (the
 * analytic report's `types[]`). Repeats once, with a fresh token, on
 * `invalid_token` — the only repeat in this file.
 */
export async function call(c, { operation, method, path, query, form }, { reauthed = false } = {}) {
  stopIfAborted(c.signal);
  const token = await getToken(c);
  const { url, body } = buildRequest(token, method, path, { query, form });
  const response = await send(c, operation, url.toString(), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const text = await response.text();
  const data = parseJson(text);
  if (response.ok) return data;

  const detail = c.errorDetail(data, text);
  if (data?.error !== 'invalid_token') throw callRefusal(operation, response, data, detail);
  c.cached = null;
  if (!reauthed) return call(c, { operation, method, path, query, form }, { reauthed: true });
  throw new PodbeanError(
    `Podbean refused a freshly issued access token while ${operation} (${statusAndCode(response.status, data)}).`,
    { status: response.status, code: 'TOKEN_REJECTED', detail, retryable: false }
  );
}
