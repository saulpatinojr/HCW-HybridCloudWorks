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

/** Fixed sentences by status, so the page says what to do. */
function sentenceFor(status) {
  if (status === 403) return 'the service account is not a Full user on the Search Console property';
  if (status === 401) return 'Google did not accept the access token';
  if (status === 429) return 'Google\'s Search Console quota was used up';
  if (status === 404) return 'Google has no such property or resource';
  if (status === UNREADABLE) return 'Google\'s answer could not be read';
  if (status === NOT_SENT) return 'the daily allowance of inspections is used up, so it was not sent';
  if (status === 400) return 'Google refused the request as malformed';
  if (Number.isInteger(status) && status >= 500) return 'Google\'s Search Console service failed';
  return 'Search Console could not be reached';
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
    const code = reason === UNREADABLE ? 'GSC_UNREADABLE' : reason === NOT_SENT ? 'GSC_NOT_SENT' : Number.isInteger(status) ? `GSC_HTTP_${status}` : 'GSC_UNREACHABLE';
    super(`Search Console ${kind} failed: ${sentenceFor(reason ?? status)}${reason ? '' : suffix}.`, {
      code,
      ...(Number.isInteger(status) ? { status } : {}),
    });
    this.kind = kind;
    this.reason = reason ?? null;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds from a Retry-After header, or null. Only the number form is read. */
function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
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

  /**
   * One call with the retry rule; returns the parsed JSON body once `valid`
   * accepts it. `beforeSend` (optional) is asked before every request,
   * retries and the re-send after a refused token included; false means do
   * not send. A first request held back fails as 'not_sent'; a retry held
   * back fails with the failure it was going to retry.
   */
  async function call(kind, url, { method = 'GET', body, valid, beforeSend } = {}) {
    let refreshedOnce = false;
    let lastFailure = null;
    for (let attempt = 1; ; attempt += 1) {
      if (typeof beforeSend === 'function' && !(await beforeSend())) {
        throw lastFailure ?? new SearchConsoleError(kind, undefined, { reason: NOT_SENT });
      }
      const token = await auth.getAccessToken();
      let response;
      try {
        // A call that hangs past the helper's 30 seconds throws like a
        // dropped connection, so it is retried the same way.
        response = await fetchWithTimeout(fetchImpl, url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        lastFailure = new SearchConsoleError(kind);
        if (attempt >= maxAttempts) throw lastFailure;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        // Not retried: Google answered, and asking again would spend quota on
        // the same answer. The caller keeps its last good figures instead.
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
      const status = response.status;
      lastFailure = new SearchConsoleError(kind, status);
      // A token Google issued and then refused: sign in again, once.
      if (status === 401 && !refreshedOnce && typeof auth.reset === 'function') {
        refreshedOnce = true;
        auth.reset();
        continue;
      }
      if (!RETRYABLE.has(status) || attempt >= maxAttempts) throw lastFailure;
      const wait = retryAfterMs(response) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
      if (wait > MAX_BACKOFF_MS) throw lastFailure;
      await sleep(wait);
    }
  }

  return {
    siteUrl,

    /**
     * Google's UrlInspectionResult for one page. `options.beforeSend` is
     * asked before each request goes out (see `call`).
     */
    async inspect(inspectionUrl, { beforeSend } = {}) {
      const answer = await call('inspect', INSPECT_URL, {
        method: 'POST',
        body: { inspectionUrl, siteUrl, languageCode: 'en-US' },
        valid: (json) => isObject(json.inspectionResult),
        beforeSend,
      });
      return answer.inspectionResult;
    },

    /** The rows of one Search Analytics query, [] when there are none. */
    async searchAnalytics(body) {
      const answer = await call('searchAnalytics', `${siteBase}/searchAnalytics/query`, {
        method: 'POST',
        body,
        valid: (json) => json.rows === undefined || Array.isArray(json.rows),
      });
      return answer.rows ?? [];
    },

    /** The sitemaps submitted for the property, [] when there are none. */
    async listSitemaps() {
      const answer = await call('sitemaps', `${siteBase}/sitemaps`, {
        valid: (json) => json.sitemap === undefined || Array.isArray(json.sitemap),
      });
      return answer.sitemap ?? [];
    },
  };
}
