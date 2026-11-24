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
 * until. One refresh is at most MAX_PAGES + 1 calls (client.js).
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
import { normalizeEvents, talkTitles } from './events.js';

export const CONTAINER = 'admin_config';
export const CACHE_DOC_ID = 'community_days_cache';
export const CACHE_DOC_TYPE = 'community_days_cache';
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MIN_REFRESH_MS = 60 * 1000;
/** After a 429 with no Retry-After, wait this long before asking again. */
export const DEFAULT_RETRY_WAIT_MS = 15 * 60 * 1000;
/** After a refresh that failed, opening the page does not try again for this long (Refresh still may, after a minute). */
export const FAILED_RETRY_MS = 5 * 60 * 1000;

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
    if (decision.reason === 'rate_limited') {
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
    try {
      talks = talkTitles(await client.listTalks());
    } catch (error) {
      log?.warn?.(`communityDays: the talks could not be read (${errorCode(error)})`);
    }
    const { events, skipped } = normalizeEvents(listed.events);
    const next = {
      events,
      talks,
      fetchedAt: at.toISOString(),
      total: listed.total,
      truncated: listed.truncated,
      skipped,
      retryAt: null,
      lastError: null,
      attemptedAt: at.toISOString(),
    };
    if (!(await writeCache(store, stored, next))) {
      // Another request refreshed at the same moment; answer its copy.
      const winner = readCacheState(await store.readDoc(CONTAINER, CACHE_DOC_ID, ADMIN_CONFIG_PARTITION));
      return { status: 'ok', ...winner, refreshed: true, error: null, notice: null };
    }
    return { status: 'ok', ...next, refreshed: true, error: null, notice: null };
  } catch (error) {
    if (!(error instanceof CommunityDaysError)) throw error;
    log?.warn?.(`communityDays: the list could not be refreshed (${errorCode(error)})`);
    const sentence = authoredMessage(error, 'Community Days could not be read.');
    let { retryAt } = state;
    if (error.upstreamStatus === 429) {
      const waitMs = Number.isInteger(error.retryAfterSeconds) ? error.retryAfterSeconds * 1000 : DEFAULT_RETRY_WAIT_MS;
      retryAt = new Date(at.getTime() + Math.max(waitMs, MIN_REFRESH_MS)).toISOString();
    }
    // Remember the wait (and the sentence) beside the last good copy. A lost
    // race here is harmless: the other writer's document is newer.
    const next = { ...state, retryAt, lastError: sentence, attemptedAt: at.toISOString() };
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
}
