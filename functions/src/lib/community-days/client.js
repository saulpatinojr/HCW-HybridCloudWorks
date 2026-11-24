/**
 * community-days/client.js — the two calls this site makes to the Community
 * Days API (#1823, ADR 0045).
 *
 * Community Days is an outside directory of community conferences. Its API
 * (a set of web addresses a program can call) is described at
 * https://api.communitydays.org/v1/openapi-events.json and
 * https://api.communitydays.org/v1/fields.md.
 *
 *   listOpenCalls()   GET /published-events?call_for_speakers=true
 *                     every published event whose call for speakers (the
 *                     period when an event accepts talk proposals) is open
 *   listTalks()       GET /profile/talks
 *                     the key owner's own talks, as Community Days lists them
 *
 * THE KEY CAN DO FAR MORE THAN THIS FILE DOES. The same key can create,
 * change and delete the owner's events, speaker profile and organization, and
 * the vendor offers no read-only key. So the rule is kept here, in code:
 *
 *   - every request goes through `call()`, which sends GET and nothing else
 *     and refuses a path that is not in ALLOWED_PATHS before anything is sent;
 *   - `only-read-calls.test.js` reads this file and every other source file
 *     and fails if another method, another path, or another file that names
 *     the API's host appears.
 *
 * WHAT NEVER LEAVES THIS FILE. The key goes in the Authorization header and
 * nowhere else: not in a URL, an error, a log line or an answer. The API's
 * response body is parsed here and never copied into an error or a log line;
 * a failure is a CommunityDaysError whose sentence this file wrote, with the
 * HTTP status as a field.
 *
 * HOW A REQUEST IS SENT. Through guardedFetch (http/guarded-fetch.js), which
 * gives one deadline for the whole request, a size limit on the answer and
 * https only. Redirects are refused (`maxRedirects: 0`): the key must never be
 * sent on to another address. Nothing is retried: a refresh is started by a
 * person or by the cache going stale (cache.js), and a "too many requests"
 * answer (HTTP 429) is recorded with its Retry-After so the next call waits.
 */
import { AuthoredError, withUpstreamStatus } from '../http/error-response.js';
import { guardedFetch } from '../http/guarded-fetch.js';
import { readSetting } from '../http/read-setting.js';
import { ALLOWED_PATHS, API_BASE, API_KEY_SETTING, EVENTS_PATH, TALKS_PATH, sentenceForStatus } from './api.js';

// Nothing from api.js is passed on from here. A module that needs a name or
// the address imports it from api.js itself, where only-read-calls.test.js
// counts who does; passing the address on from this file would let another
// module take it without being counted.

/** One request may take this long, answer included. */
export const CALL_TIMEOUT_MS = 8_000;
/** The largest answer read: a page of 50 events with their page text. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** Events asked for per page (the API allows 100; 50 keeps one answer small). */
export const PER_PAGE = 50;
/** Pages read in one refresh, so one refresh is at most this many calls for events. */
export const MAX_PAGES = 6;
/** A Retry-After longer than this is recorded as this (one day). */
export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/**
 * A failed Community Days call. `kind` is 'events' or 'talks'. `upstreamStatus`
 * is the API's HTTP status when it answered; `retryAfterSeconds` is set for a
 * 429 that said how long to wait. `code` is one of CDAYS_HTTP_<status>,
 * CDAYS_UNREADABLE (a 2xx whose body was not the documented JSON),
 * CDAYS_UNREACHABLE (no answer) and CDAYS_PATH_REFUSED.
 */
export class CommunityDaysError extends AuthoredError {
  /**
   * @param {string} kind
   * @param {number} [status]
   * @param {{ reason?: 'unreadable'|'refused', retryAfterSeconds?: number|null }} [options]
   */
  constructor(kind, status, { reason, retryAfterSeconds = null } = {}) {
    const answered = Number.isInteger(status);
    let sentence = sentenceForStatus(status);
    let code = answered ? `CDAYS_HTTP_${status}` : 'CDAYS_UNREACHABLE';
    if (reason === 'unreadable') {
      sentence = 'The answer from Community Days could not be read';
      code = 'CDAYS_UNREADABLE';
    } else if (reason === 'refused') {
      sentence = 'This site only reads the list of events and the list of talks from Community Days';
      code = 'CDAYS_PATH_REFUSED';
    }
    super(`${sentence}${answered && !reason ? ` (HTTP ${status})` : ''}.`, { code });
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    if (answered) withUpstreamStatus(this, status);
  }
}

/** The key as set, or '' when the setting is empty or its Key Vault secret does not exist yet. */
export function readApiKey(env = process.env) {
  return readSetting(env, API_KEY_SETTING);
}

/** Seconds from a Retry-After header in its number form, or null. */
export function retryAfterSeconds(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()), MAX_RETRY_AFTER_SECONDS);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} deps
 * @param {string} deps.apiKey - the key; never logged, never put in a URL
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {Function} [deps.resolve] - DNS lookup, for tests (guardedFetch)
 * @param {Function} [deps.dispatcherFor] - connection pinning, for tests (guardedFetch)
 * @param {number} [deps.timeoutMs]
 */
export function createCommunityDaysClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  resolve,
  dispatcherFor,
  timeoutMs = CALL_TIMEOUT_MS,
}) {
  /**
   * One read. `path` must be one of ALLOWED_PATHS; `query` is a plain map of
   * values this file chose (never a caller's text). Answers the parsed JSON
   * object once `valid` accepts it.
   */
  async function call(kind, path, { query = {}, valid, signal } = {}) {
    if (!ALLOWED_PATHS.includes(path)) throw new CommunityDaysError(kind, undefined, { reason: 'refused' });
    const target = new URL(`${API_BASE}${path}`);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, String(value));

    let fetched;
    try {
      fetched = await guardedFetch(target.toString(), {
        fetch: fetchImpl,
        ...(resolve ? { resolve } : {}),
        ...(dispatcherFor ? { dispatcherFor } : {}),
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        httpsOnly: true,
        maxRedirects: 0,
        timeoutMs,
        maxBytes: MAX_ANSWER_BYTES,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // A redirect is an answer, and it is refused on purpose (see the header).
      const status = Number.isInteger(error?.status) ? error.status : undefined;
      throw new CommunityDaysError(kind, status);
    }

    const { response } = fetched;
    if (!response.ok) {
      throw new CommunityDaysError(kind, response.status, {
        retryAfterSeconds: response.status === 429 ? retryAfterSeconds(response) : null,
      });
    }
    let answer;
    try {
      answer = JSON.parse(fetched.text());
    } catch {
      throw new CommunityDaysError(kind, response.status, { reason: 'unreadable' });
    }
    if (!isObject(answer) || (valid && !valid(answer))) {
      throw new CommunityDaysError(kind, response.status, { reason: 'unreadable' });
    }
    return answer;
  }

  return {
    /**
     * Every published event whose call for speakers is open now, as the API
     * sends them, soonest first. Reads page after page until the API says
     * there is no next page or MAX_PAGES is reached; `truncated` is true when
     * it stopped early, and `total` is the API's own count.
     *
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<{ events: object[], total: number|null, truncated: boolean, calls: number }>}
     */
    async listOpenCalls({ signal } = {}) {
      const events = [];
      let total = null;
      let page = 1;
      let calls = 0;
      let next = null;
      do {
        const answer = await call('events', EVENTS_PATH, {
          query: { call_for_speakers: 'true', per_page: PER_PAGE, page },
          valid: (json) => Array.isArray(json.events),
          signal,
        });
        calls += 1;
        events.push(...answer.events.filter(isObject));
        if (Number.isInteger(answer.total)) total = answer.total;
        // The next page must move forward; anything else ends the read, so a
        // wrong answer can never make this loop.
        next = Number.isInteger(answer.next_page) && answer.next_page > page ? answer.next_page : null;
        if (next) page = next;
      } while (next && calls < MAX_PAGES);
      return { events, total, truncated: Boolean(next), calls };
    },

    /**
     * The key owner's talks, as the API sends them (newest first).
     *
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<object[]>}
     */
    async listTalks({ signal } = {}) {
      const answer = await call('talks', TALKS_PATH, {
        valid: (json) => json.talks === undefined || Array.isArray(json.talks),
        signal,
      });
      return (answer.talks ?? []).filter(isObject);
    },
  };
}
