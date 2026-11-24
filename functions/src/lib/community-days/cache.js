/**
 * community-days/cache.js — this site's own copy of the Community Days list,
 * so the page does not call the outside API every time it is opened (#1823,
 * ADR 0045).
 *
 * ONE DOCUMENT, `admin_config/community_days_cache`, in the container and the
 * constant partition every other admin setting uses (no new container, so no
 * Terraform for storage). It holds the events with an open call for speakers
 * as events.js reduces them, the titles of the owner's talks, when the copy
 * was made, and, after a "too many requests" answer, the time before which
 * the API must not be asked again.
 *
 * WHEN THE API IS CALLED. Only here, and only when:
 *
 *   - the page is opened and the copy is older than CACHE_TTL_MS (six hours),
 *     or there is no copy yet; or
 *   - the owner presses Refresh, at most once every MIN_REFRESH_MS (a minute).
 *
 * After a refresh that failed (a wrong key, say), opening the page does not
 * try again for FAILED_RETRY_MS (five minutes), so a broken key is not sent
 * on every page view. It is never called before `retryAt`, the time a 429 answer asked this site to wait
 * until, whether that answer came from the list of events or from the list of
 * talks. One refresh is at most MAX_PAGES + 1 calls (client.js).
 *
 * WHEN THE LIST WAS READ BUT THE COPY COULD NOT BE SAVED. That is a failed
 * refresh too, and it is recorded like one (the time of the try and a
 * sentence, written beside the last good copy), so the five-minute wait
 * applies. Without that record every page view would read the outside
 * service again (up to seven calls) and fail to save again.
 *
 * THE COPY HAS A SIZE LIMIT. The database refuses a document over 2 MB,
 * counted in bytes. Each event's page text is already cut by bytes
 * (events.js); `fitEvents` here also holds the whole list to
 * CACHE_EVENTS_MAX_BYTES, first by shortening the page texts and then, if it
 * must, by keeping only the soonest events and saying so (`truncated`).
 *
 * WHY THE WHOLE LIST IS READ AGAIN, NOT ONLY WHAT CHANGED. The API offers
 * `updated_since`, which answers only the events edited since a given time.
 * This list is "events whose call for speakers is open NOW", and an event
 * leaves that list when its closing day passes, without anyone editing it. A
 * "what changed" answer cannot say which events dropped out, so a copy kept
 * that way would go on showing closed calls. Reading the filtered list whole
 * is one to six calls, a few times a day at most.
 *
 * WHEN A REFRESH FAILS, the last good copy is kept and answered with
 * `stale: true` and the failure's sentence, so a bad hour at the API does not
 * empty the page. Without a key nothing is called at all (`status: 'no_key'`).
 *
 * The write is guarded: the document is replaced under the ETag (the version
 * stamp Cosmos gives each document) it was read at. Losing that race means
 * another request refreshed at the same moment, and its copy is as good as
 * this one, so the loser reads the winner's document instead of writing.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { authoredMessage, errorCode } from '../http/error-response.js';
import { CommunityDaysError, createCommunityDaysClient, readApiKey } from './client.js';
import { cutToBytes, normalizeEvents, PAGE_TEXT_MAX_BYTES, talkTitles } from './events.js';

export const CONTAINER = 'admin_config';
export const CACHE_DOC_ID = 'community_days_cache';
export const CACHE_DOC_TYPE = 'community_days_cache';
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MIN_REFRESH_MS = 60 * 1000;
/** After a 429 with no Retry-After, wait this long before asking again. */
export const DEFAULT_RETRY_WAIT_MS = 15 * 60 * 1000;
/** After a refresh that failed, opening the page does not try again for this long (Refresh still may, after a minute). */
export const FAILED_RETRY_MS = 5 * 60 * 1000;
/**
 * The most bytes the stored events may take together. The database's limit
 * for one document is 2 MB; this leaves room for the talks, the other fields
 * and the fields the database adds.
 */
export const CACHE_EVENTS_MAX_BYTES = 1_500_000;
/** What the page is told when the list was read but this site's copy of it could not be saved. */
export const SAVE_FAILED_SENTENCE =
  'The list was read from Community Days, but this site could not save its copy of it. Try Refresh again in a few minutes.';
export const SAVE_FAILED_CODE = 'CDAYS_COPY_NOT_SAVED';

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The events that fit in `maxBytes` once stored. Page texts are shortened
 * first (halved until the list fits, down to nothing); if the list is still
 * too large, events are dropped from the end, which keeps the soonest.
 *
 * @param {object[]} events - as events.js reduces them, soonest first
 * @param {number} [maxBytes]
 * @returns {{ events: object[], dropped: number }}
 */
export function fitEvents(events, maxBytes = CACHE_EVENTS_MAX_BYTES) {
  let kept = events;
  let cap = PAGE_TEXT_MAX_BYTES;
  while (bytesOf(kept) > maxBytes && cap > 0) {
    cap = cap > 150 ? Math.floor(cap / 2) : 0;
    const limit = cap;
    kept = kept.map((event) => ({ ...event, pageText: cutToBytes(event.pageText ?? '', limit) }));
  }
  if (bytesOf(kept) <= maxBytes) return { events: kept, dropped: 0 };
  // Still too large with no page text at all: count each event once and keep
  // the ones from the front that fit (2 bytes for the list's brackets, 1 per comma).
  const fitting = [];
  let used = 2;
  for (const event of kept) {
    const size = bytesOf(event) + 1;
    if (used + size > maxBytes) break;
    used += size;
    fitting.push(event);
  }
  return { events: fitting, dropped: kept.length - fitting.length };
}

const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

const EMPTY = Object.freeze({ events: [], talks: [], fetchedAt: null, total: null, truncated: false, skipped: 0, retryAt: null, lastError: null, attemptedAt: null });

/** The stored document as plain state, whatever shape it is in. */
export function readCacheState(doc) {
  if (!doc || typeof doc !== 'object') return { ...EMPTY };
  return {
    events: Array.isArray(doc.events) ? doc.events.filter((event) => event && typeof event === 'object') : [],
    talks: Array.isArray(doc.talks) ? doc.talks.filter((title) => typeof title === 'string') : [],
    fetchedAt: typeof doc.fetchedAt === 'string' && Number.isFinite(Date.parse(doc.fetchedAt)) ? doc.fetchedAt : null,
    total: Number.isInteger(doc.total) ? doc.total : null,
    truncated: doc.truncated === true,
    skipped: Number.isInteger(doc.skipped) ? doc.skipped : 0,
    retryAt: typeof doc.retryAt === 'string' && Number.isFinite(Date.parse(doc.retryAt)) ? doc.retryAt : null,
    lastError: typeof doc.lastError === 'string' ? doc.lastError : null,
    attemptedAt: typeof doc.attemptedAt === 'string' && Number.isFinite(Date.parse(doc.attemptedAt)) ? doc.attemptedAt : null,
  };
}

/** Whether the API may be asked now, and if not, why. */
export function refreshDecision(state, { now, force }) {
  const at = now.getTime();
  if (state.retryAt && Date.parse(state.retryAt) > at) return { call: false, reason: 'rate_limited' };
  const age = state.fetchedAt ? at - Date.parse(state.fetchedAt) : Infinity;
  // The last try, good or failed: a failed one leaves `fetchedAt` alone.
  const sinceTry = Math.min(age, state.attemptedAt ? at - Date.parse(state.attemptedAt) : Infinity);
  if (force) return sinceTry < MIN_REFRESH_MS ? { call: false, reason: 'just_tried' } : { call: true };
  if (age < CACHE_TTL_MS) return { call: false };
  return sinceTry < FAILED_RETRY_MS ? { call: false, reason: 'recent_failure' } : { call: true };
}

/** Write `next` over the document read as `stored`; false when another request wrote first. */
async function writeCache(store, stored, next) {
  const document = { ...next, id: CACHE_DOC_ID, configScope: ADMIN_CONFIG_PARTITION, docType: CACHE_DOC_TYPE };
  try {
    if (stored) {
      await store.replaceDocIfMatch(CONTAINER, { ...document, _etag: stored._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
    } else {
      await store.createDoc(CONTAINER, document);
    }
    return true;
  } catch (error) {
    if (isWriteConflict(error)) return false;
    throw error;
  }
}

/**
 * The list the page shows, refreshed from the API when the rules in the
 * header allow it.
 *
 * `status` is one of:
 *   no_key   the key is not set; nothing was called, `events` is what an
 *            earlier copy holds (normally nothing)
 *   ok       `events` is a copy no older than CACHE_TTL_MS, or just read
 *   stale    the copy is older and could not be refreshed; `error` says why
 *   error    there is no copy and the read failed; `error` says why
 *
 * `refreshed` is true when this call read the API. `notice` is a sentence
 * for a Refresh that was not allowed yet.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {boolean} [deps.force] - the owner pressed Refresh
 * @param {object} [deps.log] - `{ warn }`, for one content-free line on a failed refresh
 * @param {Function} [deps.makeClient] - test seam for the API client
 */
export async function loadEvents({
  store,
  env = process.env,
  now = () => new Date(),
  force = false,
  log = null,
  makeClient = createCommunityDaysClient,
}) {
  const stored = await store.readDoc(CONTAINER, CACHE_DOC_ID, ADMIN_CONFIG_PARTITION);
  const state = readCacheState(stored);
  const apiKey = readApiKey(env);
  if (!apiKey) return { status: 'no_key', ...state, refreshed: false, error: null, notice: null };

  const at = now();
  const decision = refreshDecision(state, { now: at, force });
  const fresh = state.fetchedAt !== null && at.getTime() - Date.parse(state.fetchedAt) < CACHE_TTL_MS;
  if (!decision.call) {
    let notice = null;
    if (decision.reason === 'just_tried') notice = 'The list was read less than a minute ago. Try again in a minute.';
    // The wait is said when it is why the page shows an old copy, or when
    // Refresh was pressed; a fresh copy opened as usual needs no sentence.
    if (decision.reason === 'rate_limited' && (force || !fresh)) {
      notice = 'Community Days asked this site to wait before asking again. The list will refresh after that time.';
    }
    // Not fresh and not asked: the copy is old (or missing) and the last
    // try failed or was told to wait, so the page says so with that sentence.
    let status = 'ok';
    if (!fresh) status = state.fetchedAt === null ? 'error' : 'stale';
    return { status, ...state, refreshed: false, error: fresh ? null : state.lastError, notice };
  }

  const client = makeClient({ apiKey });
  try {
    const listed = await client.listOpenCalls();
    // The talks are a help for the estimate, not the page: when that one call
    // fails, the events just read are still kept, with the talks from before.
    let talks = state.talks;
    // The events were read, so no wait is owed for them. The talks call can
    // still be told to wait, and that wait is kept for the next refresh.
    let retryAt = null;
    try {
      talks = talkTitles(await client.listTalks());
    } catch (error) {
      log?.warn?.(`communityDays: the talks could not be read (${errorCode(error)})`);
      if (error instanceof CommunityDaysError) retryAt = waitUntil(error, at);
    }
    const normalized = normalizeEvents(listed.events);
    const { events, dropped } = fitEvents(normalized.events);
    const next = {
      events,
      talks,
      fetchedAt: at.toISOString(),
      total: listed.total,
      truncated: listed.truncated || dropped > 0,
      skipped: normalized.skipped + dropped,
      retryAt,
      lastError: null,
      attemptedAt: at.toISOString(),
    };
    let written;
    try {
      written = await writeCache(store, stored, next);
    } catch (error) {
      return await saveFailed(error);
    }
    if (!written) {
      // Another request refreshed at the same moment; answer its copy.
      const winner = readCacheState(await store.readDoc(CONTAINER, CACHE_DOC_ID, ADMIN_CONFIG_PARTITION));
      return { status: 'ok', ...winner, refreshed: true, error: null, notice: null };
    }
    return { status: 'ok', ...next, refreshed: true, error: null, notice: null };
  } catch (error) {
    if (!(error instanceof CommunityDaysError)) throw error;
    log?.warn?.(`communityDays: the list could not be refreshed (${errorCode(error)})`);
    const sentence = authoredMessage(error, 'Community Days could not be read.');
    // Remember the wait (and the sentence) beside the last good copy. A lost
    // race here is harmless: the other writer's document is newer.
    const next = { ...state, retryAt: waitUntil(error, at) ?? state.retryAt, lastError: sentence, attemptedAt: at.toISOString() };
    await writeCache(store, stored, next);
    return {
      status: state.fetchedAt === null ? 'error' : 'stale',
      ...next,
      refreshed: false,
      error: sentence,
      notice: null,
      code: errorCode(error),
    };
  }

  /**
   * The list was read, but writing this site's copy failed for a reason that
   * is not a lost race. Record the try beside the last good copy, so the
   * failure wait applies and the next page views do not read the outside
   * service again. That record is a small document (the copy as it was, plus
   * a time and a sentence), so it can be saved even when the new copy could
   * not. If it cannot be saved either, the store is not accepting writes at
   * all; that is logged and the same answer is given.
   */
  async function saveFailed(error) {
    log?.warn?.(`communityDays: the copy of the list could not be saved (${errorCode(error)})`);
    const next = { ...state, lastError: SAVE_FAILED_SENTENCE, attemptedAt: at.toISOString() };
    try {
      await writeCache(store, stored, next);
    } catch (again) {
      log?.warn?.(`communityDays: the failed save could not be recorded (${errorCode(again)})`);
    }
    return {
      status: state.fetchedAt === null ? 'error' : 'stale',
      ...next,
      refreshed: false,
      error: SAVE_FAILED_SENTENCE,
      notice: null,
      code: SAVE_FAILED_CODE,
    };
  }
}

/**
 * The time before which the API must not be asked again, from a "too many
 * requests" answer (HTTP 429); null for any other failure. The answer's
 * Retry-After is used when it gave one, and never less than a minute.
 */
function waitUntil(error, at) {
  if (error?.upstreamStatus !== 429) return null;
  const waitMs = Number.isInteger(error.retryAfterSeconds) ? error.retryAfterSeconds * 1000 : DEFAULT_RETRY_WAIT_MS;
  return new Date(at.getTime() + Math.max(waitMs, MIN_REFRESH_MS)).toISOString();
}
