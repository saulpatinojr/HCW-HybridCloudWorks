/**
 * publer-client.js — the Publer API client the social calendar reconcile
 * (publer-sync.js) and the social_posts change-feed handlers use. The header
 * of publer-sync.js says what the API really looks like, and why a 401
 * blames the workspace id and a 403 the key; publer-sync.js exports
 * everything here again.
 */
import { readKey } from '../ai/router.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { createKeyVerdictReporter, isCredentialRejected } from '../key-verdict.js';
import { describeUpstreamFailure, readUpstreamError } from '../integrations/upstream-error.js';
import { extractPublerList, normalizePublerPost } from './publer-posts.js';

// Outbound deadline (T-712): Node's fetch has none, and these calls are
// reached from change-feed handlers where a hung socket holds the lease.
const PUBLER_TIMEOUT_MS = 20_000;

export const PUBLER_API_BASE_URL = 'https://app.publer.com/api/v1';

// The three states the calendar reconciles against, sent as one `state[]`
// array rather than looped over. `GET /posts` documents `state[]` for exactly
// this, and the three separate passes it replaces cost three times the
// requests against a limit of 100 per two minutes, shared across every key on
// the account (#463 item 5).
const SYNC_STATES = ['scheduled', 'published', 'failed'];
const MAX_PAGES = 10;

// Publer's page size is its own; `per_page` is a field of the RESPONSE and not
// a parameter of the request, so the `per_page=100` this used to send was
// ignored on the way out and misread the account's real paging on the way
// back. Pages are followed with `total_pages`, which is documented.
//
// Stop paging with this much of the window left. `X-RateLimit-Remaining`
// counts down from 100 per two minutes PER USER ACCOUNT across all of its API
// keys — so the budget is shared with the owner's browser, the Social Hub and
// anything else holding a key. A five-minute reconcile that drains it would
// take the admin pages down with it, and a partial reconcile is corrected on
// the next run five minutes later.
const RATE_LIMIT_FLOOR = 10;

/**
 * Which setting a rejection actually blames, from the status.
 *
 * Measured, not documented -- see the header. 401 is the workspace id, 403 is
 * the key. Anything else that reaches here is treated as the key, which is the
 * conservative default: `isCredentialRejected` only admits 401 and 403 today,
 * so the fallback is unreachable rather than wrong.
 *
 * @param {number|string} status
 * @returns {'PUBLER_WORKSPACE_ID'|'PUBLER_API_KEY'}
 */
export function publerSettingForStatus(status) {
  return Number(status) === 401 ? 'PUBLER_WORKSPACE_ID' : 'PUBLER_API_KEY';
}

/**
 * Text first, then parse. `response.json().catch(() => ({}))` discarded
 * every body that was not JSON — and an HTML error page from a gateway in
 * front of Publer is exactly the failure where the body says more than the
 * status. `rest-proxy.js` has always read it this way and parks the
 * remains under `raw`, which `readUpstreamError` knows how to read; this
 * client did not, so that branch was unreachable from here.
 */
async function readBody(response) {
  const text = await response.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/**
 * The rate-limit budget the response reported. Absent on a mocked response
 * and on any answer Publer serves without it; `null` means "unknown", which
 * the caller must not read as "exhausted".
 */
function rateLimitRemainingOf(response) {
  const remainingHeader = response.headers?.get?.('X-RateLimit-Remaining');
  if (remainingHeader === null || remainingHeader === undefined || remainingHeader === '') return null;
  const remaining = Number(remainingHeader);
  return Number.isFinite(remaining) ? remaining : null;
}

/** Report a refused call's verdict when it is one, and throw the error that says why. */
async function refuse(c, response, data, method, path) {
  // Publer's own sentence, not just the number. `{"errors":[...]}` is
  // what separates "Missing or invalid Authorization header" — our
  // request is malformed — from a key that is revoked or on an account
  // without API entitlement. #358 spent two days on that distinction with
  // only `HTTP 401` to go on, because this line threw the status alone.
  const detail = readUpstreamError(data);
  // Only a 401/403 is a verdict on the pair. A 404 is a wrong path, a 429
  // a busy account, a 5xx Publer's problem — none of them says a
  // credential is bad, and the lights stay as they were.
  //
  // WHICH light, though, is the whole point: 401 blames the workspace id
  // and 403 blames the key, measured rather than read off the docs, which
  // have it the other way round. See the header.
  if (isCredentialRejected(response.status)) {
    await c.reportVerdict(publerSettingForStatus(response.status), {
      ok: false,
      status: response.status,
      detail,
    });
  }
  const error = new Error(
    `Publer ${method} ${path} failed with ${describeUpstreamFailure(response.status, data)}`
  );
  error.status = response.status;
  error.detail = detail;
  throw error;
}

/**
 * One call, with the rate-limit budget the response reported.
 *
 * `request` below is the same thing with the metadata dropped; it is what
 * the change-feed handlers have always called and its signature does not
 * move. Only the paging loop needs the header, and only the paging loop
 * takes this.
 */
async function requestWithMeta(c, path, method = 'GET', body) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer-API ${c.apiKey}`,
      'Publer-Workspace-Id': c.workspaceId,
      'Content-Type': 'application/json',
    },
  };
  if (body && !['GET', 'HEAD'].includes(method)) options.body = JSON.stringify(body);
  // Reached from the social_posts change-feed handler as well as this
  // timer, so an unbounded call holds a lease (T-712).
  const response = await fetchWithTimeout(c.fetchImpl, `${PUBLER_API_BASE_URL}${path}`, {
    ...options,
    timeoutMs: PUBLER_TIMEOUT_MS,
  });
  const data = await readBody(response);
  const rateLimitRemaining = rateLimitRemainingOf(response);
  if (!response.ok) await refuse(c, response, data, method, path);
  // A success clears BOTH lights: the call proved the key and the workspace
  // id together, and leaving the other red would strand whichever one a
  // previous rejection had blamed.
  await c.reportVerdict('PUBLER_API_KEY', { ok: true });
  await c.reportVerdict('PUBLER_WORKSPACE_ID', { ok: true });
  return { data, rateLimitRemaining };
}

async function request(c, path, method = 'GET', body) {
  const { data } = await requestWithMeta(c, path, method, body);
  return data;
}

/**
 * Every post in the three reconciled states, in one paged pass.
 *
 * Was three passes of up to ten pages each — thirty requests against a
 * hundred-per-two-minutes budget shared with the admin pages — because
 * `state` was sent singular in a loop. `state[]` takes all three at once
 * (#463 item 5).
 */
async function listPostsForSync(c) {
  const states = SYNC_STATES.map((state) => `state[]=${encodeURIComponent(state)}`).join('&');
  const results = [];
  let page = 0;
  // Assigned from the first response before the while condition reads it;
  // the do-while guarantees one pass, so there is no initial value to seed.
  let totalPages;
  do {
    const response = await requestWithMeta(c, `/posts?${states}&page=${page}`);
    results.push(...extractPublerList(response.data));
    totalPages = Number(response.data?.total_pages || 1);
    page += 1;
    // A null reading is unknown, not exhausted: an upstream that stops
    // sending the header must not stop the reconcile at page one.
    const remaining = response.rateLimitRemaining;
    if (remaining !== null && remaining <= RATE_LIMIT_FLOOR) {
      c.log.warn?.(
        `[syncSocialCalendar] stopping after page ${page} of ${totalPages}: ` +
          `${remaining} Publer requests left in the window`
      );
      break;
    }
  } while (page < Math.min(totalPages, MAX_PAGES));
  return results.map(normalizePublerPost).filter((post) => post.id);
}

/**
 * Delete posts by id, in the one form Publer documents.
 *
 * `DELETE /posts/{id}` was invented; the API takes `DELETE /posts` with a
 * `post_ids[]` query array and answers `{ deleted_ids }`. The undocumented
 * per-id path is not merely wrong, it is wrong in a dangerous direction —
 * **omitting `post_ids` deletes every non-published post in the workspace**,
 * so a call built by dropping an id from the path is a workspace wipe. This
 * function refuses an empty list for that reason, and refuses it before the
 * request rather than after (#463 item 2).
 *
 * An id absent from `deleted_ids` was NOT deleted. Publer reports that in a
 * 200, so a caller that only checks for a thrown error records a post as
 * removed while it is still scheduled to publish.
 *
 * @param {Array<string|number>} ids
 * @returns {Promise<{ deletedIds: string[], missingIds: string[] }>}
 */
async function deletePosts(c, ids) {
  // Nullish is dropped BEFORE stringifying: `String(null)` is the truthy
  // string 'null', so filtering after the map would send `post_ids[]=null`
  // — a request Publer would answer, for a post that does not exist, from a
  // caller that meant to send nothing.
  const wanted = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((id) => id !== null && id !== undefined)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];
  if (!wanted.length) {
    // Not a silent return: the caller believed it had something to delete,
    // and the alternative reading of an empty list is the bulk wipe above.
    throw new Error('Publer deletePosts called with no post ids — refusing to delete');
  }
  const query = wanted.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
  const data = await request(c, `/posts?${query}`, 'DELETE');
  const deletedIds = (Array.isArray(data?.deleted_ids) ? data.deleted_ids : []).map(String);
  return { deletedIds, missingIds: wanted.filter((id) => !deletedIds.includes(id)) };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {Function|null} [deps.onKeyVerdict] The API-keys page's verdict
 *   writer, in the shape `createAiRouter` takes it. `null` — every unit test —
 *   reports nothing.
 * @param {{ warn?: Function }} [deps.log]
 * @returns {{
 *   configured: boolean,
 *   request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
 *   listPostsForSync: () => Promise<object[]>,
 *   deletePosts: (ids: Array<string|number>) => Promise<{ deletedIds: string[], missingIds: string[] }>,
 * }} `deletePosts` is the only documented way to delete — see its own note on
 *    why an empty list is refused rather than sent.
 */
export function createPublerClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  onKeyVerdict = null,
  log = console,
} = {}) {
  const apiKey = readKey(env, 'PUBLER_API_KEY');
  const workspaceId = readKey(env, 'PUBLER_WORKSPACE_ID');
  // The verdict is recorded against the key, not the workspace id: the id is
  // an identifier rather than a credential, and the catalogue maps one setting
  // to one secret. The warning in `createPublerReconcile` names both, because
  // a key valid for a different workspace answers 401 exactly like a stale one.
  const reportVerdict = createKeyVerdictReporter({ onKeyVerdict, log, source: 'publer' });
  const c = { apiKey, workspaceId, fetchImpl, log, reportVerdict };

  return {
    configured: Boolean(apiKey && workspaceId),
    request: (path, method, body) => request(c, path, method, body),
    listPostsForSync: () => listPostsForSync(c),
    deletePosts: (ids) => deletePosts(c, ids),
  };
}
