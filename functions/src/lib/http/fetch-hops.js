/**
 * http/fetch-hops.js — the request half both guarded fetches share
 * (guarded-fetch.js, whose header explains the guard): one deadline over the
 * whole exchange, and the hop loop that validates, pins and re-validates
 * every redirect. Also the body-size and abort errors both readers throw.
 */
import { refusal, validateFetchUrl } from './url-guard.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default body cap: enough for any article page, far below the host's memory. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Reject when `signal` aborts, so a stalled body read can be raced against the deadline. */
export function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export const tooLarge = (limit) =>
  Object.assign(new Error(`Response body exceeds ${limit} bytes`), { code: 'BODY_TOO_LARGE' });

/**
 * The deadline and the caller's signal as one signal, armed now. The timer
 * is the caller's to clear: with a buffer, when the body is read; with a
 * stream, when the stream ends.
 */
export function armDeadline(timeoutMs, parentSignal) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;
  return { signal, timer };
}

/** An abort that was the deadline's, as the FETCH_TIMEOUT error; anything else as it was. */
export function asTimeout(error, { parentSignal, timeoutMs }) {
  if (error?.name === 'AbortError' && !parentSignal?.aborted) {
    return Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'FETCH_TIMEOUT' });
  }
  return error;
}

/**
 * The hop loop both fetches share: validate and pin, request with manual
 * redirects, re-validate every hop. Returns the final response with the
 * dispatcher it came through still open — the caller reads the body and
 * closes it. A redirect hop's dispatcher is closed here.
 */
export async function requestWithRedirects(
  url,
  { fetchImpl, resolve, dispatcherFor, maxRedirects, httpsOnly, headers, method, body, signal, allowHost = null }
) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    checkHop(current, { httpsOnly, allowHost });
    const { address } = await validateFetchUrl(current, resolve ? { resolve } : {});
    const dispatcher = dispatcherFor(address);
    const response = await sendHop(fetchImpl, current, { method, headers, body, signal, dispatcher });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, dispatcher, url: current };
    closeQuietly(dispatcher);
    current = nextHop(response, current, hop === maxRedirects);
  }
  /* istanbul ignore next -- the loop returns or throws on its last hop */
  throw new Error(`Too many redirects fetching ${url}`);
}

/** Close a dispatcher without waiting, and without a failure to close becoming one. */
const closeQuietly = (dispatcher) => dispatcher?.close?.().catch?.(() => {});

/** The checks every hop makes before it is resolved: https when asked, and the caller's host rule. */
function checkHop(current, { httpsOnly, allowHost }) {
  if (httpsOnly && !/^https:\/\//i.test(current)) {
    throw refusal(`Only https is fetched here: ${current.split('?')[0]}`);
  }
  // The caller's host rule, on EVERY hop: an allowed host that redirects
  // to another host does not carry its permission with it.
  if (typeof allowHost !== 'function') return;
  let hostname = '';
  try {
    ({ hostname } = new URL(current));
  } catch {
    throw refusal(`Invalid URL: ${current}`);
  }
  if (!allowHost(hostname)) {
    throw refusal(`Host is not on the allowed list: ${hostname}`, { code: 'HOST_NOT_ALLOWED' });
  }
}

/** One request, redirects not followed; the dispatcher is closed when the request itself fails. */
async function sendHop(fetchImpl, current, { method, headers, body, signal, dispatcher }) {
  try {
    return await fetchImpl(current, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal,
      dispatcher,
    });
  } catch (error) {
    closeQuietly(dispatcher);
    throw error;
  }
}

/** Where a redirect points; a redirect with no Location, or one past the last hop, is an error. */
function nextHop(response, current, lastHop) {
  const location = response.headers?.get?.('location');
  if (!location || lastHop) {
    throw Object.assign(new Error(`HTTP ${response.status} fetching ${current}`), {
      code: location ? 'REDIRECT_LIMIT' : 'REDIRECT_NO_LOCATION',
      status: response.status,
    });
  }
  return /^https?:\/\//i.test(location) ? location : new URL(location, current).href;
}
