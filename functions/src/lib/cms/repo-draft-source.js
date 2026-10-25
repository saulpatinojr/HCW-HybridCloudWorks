/**
 * repo-draft-source.js — the pinned GitHub fetch that the lab-host drift check
 * (../labs/drift.js) and the delivery monitor (../timers/delivery-monitor-watch.js)
 * read the repository's public API through, plus the size cap the Drafts page
 * uses for a draft body.
 *
 * It used to be the source for the Drafts page's "Import from docs/content"
 * button as well. That import was removed (2026-10-25: pre-publish drafts do not
 * live in this public repository), and with it the directory listing and
 * the raw-file reads. The file keeps its name because the callers above and
 * their tests import it by that name.
 *
 * TWO HOSTS, FIXED HERE AND NOWHERE ELSE. `raw.githubusercontent.com` for the
 * file at `<REPO_OWNER>/<REPO_NAME>/main/<path>`, and `api.github.com` under
 * `repos/<REPO_OWNER>/<REPO_NAME>/` for the API reads (both names in
 * ./repo-draft.js; the owner is saulpatinojr since the repository moved on
 * 2026-10-07). The repository is public, so no token is sent. Every URL is
 * built from constants and is checked again by isPinnedUrl immediately before
 * the request, so a caller chooses which path is read and never which host
 * or repository.
 *
 * NO REDIRECTS. `redirect: 'error'` makes a 3xx fail rather than follow to
 * wherever it points; a 3xx that reaches us anyway, or a response reporting
 * another URL, is refused.
 *
 * ONE DEADLINE OVER HEADERS AND BODY, AND A BYTE CAP AS THE BODY STREAMS.
 * That is why this does not use lib/http/fetch-with-timeout.js: that helper
 * clears its timer when the headers arrive, so a body that trickles would be
 * bounded only by the runtime's own five-minute body timeout.
 */
import { AuthoredError } from '../http/error-response.js';
import {
  API_ORIGIN,
  API_PATH_PREFIX,
  RAW_ORIGIN,
  RAW_PATH_PREFIX,
  REPO_REF,
} from './repo-draft.js';

/** Per request, headers and body together. GitHub answers these in well under a second. */
export const GITHUB_FETCH_TIMEOUT_MS = 8000;
/** The most a draft body may hold (the Drafts routes enforce it). */
export const MAX_DRAFT_BYTES = 256 * 1024;
/** A commit list or a run list. */
export const MAX_API_BYTES = 512 * 1024;

const USER_AGENT = 'HybridCloudWorks-CMS-repo-import';
const GITHUB_JSON = 'application/vnd.github+json';

/**
 * A failure of the GitHub exchange, in a sentence written here (#945): the
 * callers store and show it, so it never carries a socket's or GitHub's own
 * words.
 */
export class RepoSourceError extends AuthoredError {}

/**
 * One coded failure.
 *
 * @param {string} code - machine-readable reason
 * @param {string} message - the authored sentence
 * @param {object} [extra] - fields such as `retryAfterSeconds`
 * @returns {RepoSourceError}
 */
function coded(code, message, extra = {}) {
  return Object.assign(new RepoSourceError(message, { code }), extra);
}

/**
 * Is this URL one of the two hosts this module may fetch from? Parsed, not
 * prefix-matched as a string, so `https://api.github.com.evil.test/` and
 * `https://raw.githubusercontent.com@evil.test/` are not mistaken for them.
 */
export function isPinnedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.port) return false;
  const prefix = { [RAW_ORIGIN]: RAW_PATH_PREFIX, [API_ORIGIN]: API_PATH_PREFIX }[url.origin];
  return Boolean(prefix) && url.pathname.startsWith(prefix);
}

function tooLarge(size, maxBytes) {
  return coded('TOO_LARGE', `The response is ${size} bytes (at most ${maxBytes}).`);
}

async function readStreamCapped(reader, maxBytes) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(`over ${maxBytes}`, maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared, maxBytes);
  const reader = response.body?.getReader?.();
  if (reader) return readStreamCapped(reader, maxBytes);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw tooLarge(buffer.length, maxBytes);
  return buffer;
}

/** GitHub's unauthenticated limit is 60 an hour per address; say when it resets. */
function rateLimitError(response) {
  const limited = [403, 429].includes(response.status);
  if (!limited || response.headers?.get?.('x-ratelimit-remaining') !== '0') return null;
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  const resetAt = reset > 0 ? new Date(reset * 1000).toISOString() : null;
  const when = resetAt ? `; it resets at ${resetAt}` : '';
  return coded('RATE_LIMITED', `GitHub's unauthenticated rate limit is used up${when}.`, {
    resetAt,
  });
}

function upstreamError(response, url) {
  const limited = rateLimitError(response);
  if (limited) return limited;
  if (response.status === 404) {
    return coded('NOT_FOUND', `${new URL(url).pathname} was not found on ${REPO_REF}.`);
  }
  return coded('UPSTREAM_STATUS', `GitHub answered HTTP ${response.status}.`, {
    upstreamStatus: response.status,
  });
}

/** Belt and braces for a fetch that does not honour `redirect: 'error'`. */
function assertServedFrom(response, url) {
  if (response.status >= 300 && response.status < 400) {
    throw coded(
      'REDIRECTED',
      `GitHub answered HTTP ${response.status}; redirects are not followed.`
    );
  }
  // Compared parsed, so a runtime that re-serialises the URL it was given is
  // not mistaken for one that went somewhere else.
  if (response.url && new URL(response.url).href !== new URL(url).href) {
    throw coded('REDIRECTED', 'The response came from a different URL; refusing it.');
  }
}

/**
 * Any failure from the exchange, as one coded error. A socket's own message
 * stays out of the sentence (#945); its code is the log line's.
 *
 * @param {unknown} error - what the fetch threw
 * @param {{ aborted: boolean, timeoutMs: number }} state - whether the timer fired
 * @returns {RepoSourceError}
 */
function toFetchError(error, { aborted, timeoutMs }) {
  if (error?.name === 'AbortError' || aborted) {
    return coded('TIMEOUT', `GitHub did not answer within ${timeoutMs} ms.`);
  }
  if (error instanceof RepoSourceError) return error;
  // undici rejects `redirect: 'error'` as TypeError('fetch failed') with the
  // reason on `cause`; name it, or a moved file reads as an outage.
  if (/redirect/i.test(String(error?.cause?.message || ''))) {
    return coded('REDIRECTED', 'GitHub answered with a redirect; redirects are not followed.');
  }
  return coded('FETCH_FAILED', 'Could not reach GitHub: the request failed before GitHub answered.');
}

function headersFor(accept) {
  return {
    Accept: accept,
    'User-Agent': USER_AGENT,
    ...(accept === GITHUB_JSON && { 'X-GitHub-Api-Version': '2022-11-28' }),
  };
}

/**
 * GET one pinned URL: the bytes, or a coded error. The deadline covers the
 * body read as well as the headers.
 */
export async function fetchPinned(fetchImpl, url, { accept, maxBytes, timeoutMs }) {
  if (!isPinnedUrl(url))
    throw coded('HOST_NOT_ALLOWED', 'Refusing to fetch outside the repository.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: headersFor(accept),
    });
    assertServedFrom(response, url);
    if (!response.ok) throw upstreamError(response, url);
    return await readCapped(response, maxBytes);
  } catch (error) {
    throw toFetchError(error, { aborted: controller.signal.aborted, timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}
