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

/** Fixed sentences by status, so the page says what to do. */
function sentenceFor(status) {
  if (status === 403) return 'the service account is not a Full user on the Search Console property';
  if (status === 401) return 'Google did not accept the access token';
  if (status === 429) return 'Google\'s Search Console quota was used up';
  if (status === 404) return 'Google has no such property or resource';
  if (status === 400) return 'Google refused the request as malformed';
  if (Number.isInteger(status) && status >= 500) return 'Google\'s Search Console service failed';
  return 'Search Console could not be reached';
}

/**
 * A failed Search Console call. `kind` names the call ('inspect',
 * 'searchAnalytics', 'sitemaps'); `status` the HTTP status, or undefined when
 * the request never got an answer.
 */
export class SearchConsoleError extends AuthoredError {
  constructor(kind, status) {
    const suffix = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    super(`Search Console ${kind} failed: ${sentenceFor(status)}${suffix}.`, {
      code: Number.isInteger(status) ? `GSC_HTTP_${status}` : 'GSC_UNREACHABLE',
      ...(Number.isInteger(status) ? { status } : {}),
    });
    this.kind = kind;
  }
}

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

  /** One call with the retry rule; returns the parsed JSON body. */
  async function call(kind, url, { method = 'GET', body } = {}) {
    let refreshedOnce = false;
    for (let attempt = 1; ; attempt += 1) {
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
        if (attempt >= maxAttempts) throw new SearchConsoleError(kind);
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          return {};
        }
      }
      const status = response.status;
      // A token Google issued and then refused: sign in again, once.
      if (status === 401 && !refreshedOnce && typeof auth.reset === 'function') {
        refreshedOnce = true;
        auth.reset();
        continue;
      }
      if (!RETRYABLE.has(status) || attempt >= maxAttempts) throw new SearchConsoleError(kind, status);
      const wait = retryAfterMs(response) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
      if (wait > MAX_BACKOFF_MS) throw new SearchConsoleError(kind, status);
      await sleep(wait);
    }
  }

  return {
    siteUrl,

    /** Google's UrlInspectionResult for one page, or {} when it sent none. */
    async inspect(inspectionUrl) {
      const answer = await call('inspect', INSPECT_URL, {
        method: 'POST',
        body: { inspectionUrl, siteUrl, languageCode: 'en-US' },
      });
      return answer?.inspectionResult ?? {};
    },

    /** The rows of one Search Analytics query, [] when there are none. */
    async searchAnalytics(body) {
      const answer = await call('searchAnalytics', `${siteBase}/searchAnalytics/query`, { method: 'POST', body });
      return Array.isArray(answer?.rows) ? answer.rows : [];
    },

    /** The sitemaps submitted for the property, [] when there are none. */
    async listSitemaps() {
      const answer = await call('sitemaps', `${siteBase}/sitemaps`);
      return Array.isArray(answer?.sitemap) ? answer.sitemap : [];
    },
  };
}
