/**
 * client.js — the three Google Search Console calls the sync makes (#1612).
 *
 *   inspect(url)          URL Inspection: Google's indexed copy of one page
 *                         https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
 *   searchAnalytics(body) Performance: clicks, impressions, CTR, position
 *                         https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 *   listSitemaps()        The sitemaps submitted for the property
 *                         https://developers.google.com/webmaster-tools/v1/sitemaps/list
 *
 * Every call carries the access token from google-auth.js and gives up after
 * 30 seconds without an answer (http/fetch-with-timeout.js). A 429 (too many
 * requests), a 5xx (Google's side) or no answer at all is retried a few times
 * with a growing pause; anything else fails at once. A failure is a SearchConsoleError whose
 * sentence this file wrote, with the HTTP status: Google's response body is
 * never read into an error, a log or a document.
 *
 * A 2xx answer counts only if it is JSON in the shape Google documents for
 * that call: `inspectionResult` for an inspection; `rows` for Search Analytics
 * and `sitemap` for the sitemaps list, both of which Google leaves out when
 * there is nothing to list, so `{}` is a good empty answer for those two.
 * Anything else is an error for that call, so the run keeps the last good
 * figures instead of saving empty ones.
 *
 * An inspection may be given `beforeSend`, which is asked before every
 * request goes out, retries included. When it answers false the request is
 * not sent (sync.js uses this to keep every request inside the daily budget).
 *
 * Every call may be given `signal`, the run's cancel switch (an AbortSignal).
 * When it fires, a request waiting for Google's answer is cut off, a pause
 * before a retry ends at once, and no further try is made: the call fails as
 * "could not be reached", and sync.js knows from the same signal that the run
 * was stopped rather than that Google failed.
 *
 * Quota (https://developers.google.com/webmaster-tools/limits): URL
 * inspection allows 2,000 calls a day and 600 a minute per property. The
 * sync keeps to four calls at a time and paces their starts (sync.js).
 */
import { AuthoredError } from '../http/error-response.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';

export const API_BASE = 'https://searchconsole.googleapis.com';
export const INSPECT_URL = `${API_BASE}/v1/urlInspection/index:inspect`;
/** Tries per call, the first included. */
export const MAX_ATTEMPTS = 3;
/** The pause before the second try; doubled for each try after it. */
export const BASE_BACKOFF_MS = 1000;
/** A Retry-After longer than this is not waited for. */
export const MAX_BACKOFF_MS = 30_000;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/** Reasons that are not an HTTP status: a 2xx whose body was not what Google documents, and a request held back by `beforeSend`. */
const UNREADABLE = 'unreadable';
const NOT_SENT = 'not_sent';

/** Fixed sentences by status (or by reason), so the page says what to do. */
const SENTENCES = new Map([
  [403, 'the service account is not a Full user on the Search Console property'],
  [401, 'Google did not accept the access token'],
  [429, 'Google\'s Search Console quota was used up'],
  [404, 'Google has no such property or resource'],
  [UNREADABLE, 'Google\'s answer could not be read'],
  [NOT_SENT, 'the daily allowance of inspections is used up, so it was not sent'],
  [400, 'Google refused the request as malformed'],
]);

function sentenceFor(status) {
  if (SENTENCES.has(status)) return SENTENCES.get(status);
  if (Number.isInteger(status) && status >= 500) return 'Google\'s Search Console service failed';
  return 'Search Console could not be reached';
}

/** The error's code: the reason when there is one, else the HTTP status, else unreachable. */
const REASON_CODES = { [UNREADABLE]: 'GSC_UNREADABLE', [NOT_SENT]: 'GSC_NOT_SENT' };
function errorCode(reason, status) {
  if (reason === UNREADABLE || reason === NOT_SENT) return REASON_CODES[reason];
  return Number.isInteger(status) ? `GSC_HTTP_${status}` : 'GSC_UNREACHABLE';
}

/**
 * A failed Search Console call. `kind` names the call ('inspect',
 * 'searchAnalytics', 'sitemaps'); `status` the HTTP status, or undefined when
 * the request never got an answer. `reason` is set instead of a status for
 * the two failures that are not one: 'unreadable' (a 2xx whose body was not
 * the JSON Google documents) and 'not_sent' (held back by `beforeSend`).
 */
export class SearchConsoleError extends AuthoredError {
  constructor(kind, status, { reason } = {}) {
    const suffix = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    super(`Search Console ${kind} failed: ${sentenceFor(reason ?? status)}${reason ? '' : suffix}.`, {
      code: errorCode(reason, status),
      ...(Number.isInteger(status) ? { status } : {}),
    });
    this.kind = kind;
    this.reason = reason ?? null;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `sleep(ms)`, except that it ends as soon as `signal` fires (or at once if
 * it already has). It never rejects: the caller checks the signal afterwards.
 *
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleepUnlessAborted(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([sleep(ms), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Seconds from a Retry-After header, or null. Only the number form is read. */
function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** The pause before try `attempt + 1`: BASE_BACKOFF_MS, doubled for each try after the second. */
const backoff = (attempt) => BASE_BACKOFF_MS * 2 ** (attempt - 1);

/**
 * Before each try: stop when the run was stopped (no further try, not even
 * the first), or when `beforeSend` answers false.
 */
async function checkCanSend(kind, state, { beforeSend, signal }) {
  if (signal?.aborted) throw state.lastFailure ?? new SearchConsoleError(kind);
  if (typeof beforeSend === 'function' && !(await beforeSend())) {
    throw state.lastFailure ?? new SearchConsoleError(kind, undefined, { reason: NOT_SENT });
  }
}

/** One request; null when it got no answer at all. */
async function sendOnce(deps, url, token, { method, body, signal }) {
  try {
    // A call that hangs past the helper's 30 seconds throws like a
    // dropped connection, so it is retried the same way.
    return await fetchWithTimeout(deps.fetchImpl, url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * A 2xx answer's JSON, once `valid` accepts it. Not retried: Google
 * answered, and asking again would spend quota on the same answer. The
 * caller keeps its last good figures instead.
 */
async function readAnswer(kind, response, valid) {
  let answer;
  try {
    answer = await response.json();
  } catch {
    throw new SearchConsoleError(kind, response.status, { reason: UNREADABLE });
  }
  if (!isObject(answer) || (valid && !valid(answer))) {
    throw new SearchConsoleError(kind, response.status, { reason: UNREADABLE });
  }
  return answer;
}

/**
 * After an answer that is not a 2xx: the pause before the next try, null to
 * try again at once (a refused token, signed in again), or a thrown
 * SearchConsoleError when the call gives up.
 */
function afterRefusal(deps, state, kind, response, attempt) {
  const status = response.status;
  state.lastFailure = new SearchConsoleError(kind, status);
  // A token Google issued and then refused: sign in again, once.
  if (status === 401 && !state.refreshedOnce && typeof deps.auth.reset === 'function') {
    state.refreshedOnce = true;
    deps.auth.reset();
    return null;
  }
  if (!RETRYABLE.has(status) || attempt >= deps.maxAttempts) throw state.lastFailure;
  const wait = retryAfterMs(response) ?? backoff(attempt);
  if (wait > MAX_BACKOFF_MS) throw state.lastFailure;
  return wait;
}

/**
 * One call with the retry rule; returns the parsed JSON body once `valid`
 * accepts it. `beforeSend` (optional) is asked before every request,
 * retries and the re-send after a refused token included; false means do
 * not send. A first request held back fails as 'not_sent'; a retry held
 * back fails with the failure it was going to retry.
 */
async function call(deps, kind, url, { method = 'GET', body, valid, beforeSend, signal } = {}) {
  const state = { refreshedOnce: false, lastFailure: null };
  const pause = (ms) => sleepUnlessAborted(deps.sleep, ms, signal);
  for (let attempt = 1; ; attempt += 1) {
    await checkCanSend(kind, state, { beforeSend, signal });
    const token = await deps.auth.getAccessToken();
    const response = await sendOnce(deps, url, token, { method, body, signal });
    if (response === null) {
      state.lastFailure = new SearchConsoleError(kind);
      if (attempt >= deps.maxAttempts || signal?.aborted) throw state.lastFailure;
      await pause(backoff(attempt));
      continue;
    }
    if (response.ok) return readAnswer(kind, response, valid);
    const wait = afterRefusal(deps, state, kind, response, attempt);
    if (wait !== null) await pause(wait);
  }
}

/**
 * @param {object} deps
 * @param {string} deps.siteUrl - the property, e.g. `sc-domain:hybridcloudworks.com`
 * @param {{ getAccessToken: () => Promise<string>, reset?: () => void }} deps.auth
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.maxAttempts]
 */
export function createSearchConsoleClient({
  siteUrl,
  auth,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  maxAttempts = MAX_ATTEMPTS,
}) {
  const siteBase = `${API_BASE}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`;
  const deps = { auth, fetchImpl, sleep, maxAttempts };

  return {
    siteUrl,

    /**
     * Google's UrlInspectionResult for one page. `options.beforeSend` is
     * asked before each request goes out, and `options.signal` stops the
     * call (see `call`).
     */
    async inspect(inspectionUrl, { beforeSend, signal } = {}) {
      const answer = await call(deps, 'inspect', INSPECT_URL, {
        method: 'POST',
        body: { inspectionUrl, siteUrl, languageCode: 'en-US' },
        valid: (json) => isObject(json.inspectionResult),
        beforeSend,
        signal,
      });
      return answer.inspectionResult;
    },

    /** The rows of one Search Analytics query, [] when there are none. `options.signal` stops the call. */
    async searchAnalytics(body, { signal } = {}) {
      const answer = await call(deps, 'searchAnalytics', `${siteBase}/searchAnalytics/query`, {
        method: 'POST',
        body,
        valid: (json) => json.rows === undefined || Array.isArray(json.rows),
        signal,
      });
      return answer.rows ?? [];
    },

    /** The sitemaps submitted for the property, [] when there are none. `options.signal` stops the call. */
    async listSitemaps({ signal } = {}) {
      const answer = await call(deps, 'sitemaps', `${siteBase}/sitemaps`, {
        valid: (json) => json.sitemap === undefined || Array.isArray(json.sitemap),
        signal,
      });
      return answer.sitemap ?? [];
    },
  };
}
