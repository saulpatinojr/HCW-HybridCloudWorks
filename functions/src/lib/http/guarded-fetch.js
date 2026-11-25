/**
 * guarded-fetch.js — the one outbound fetch for a URL a caller did not choose.
 *
 * An editor's "forge this page", a KB document URL, a scraped `<img src>`: all
 * of these are attacker-influenced strings that this Function App — which sits
 * inside the integration subnet and holds a managed identity — is asked to
 * fetch. A bare `fetch` on such a string is a server-side request forgery
 * primitive: `http://10.0.0.5/`, `http://169.254.169.254/`, or a public host
 * whose redirect lands on either, and the response body comes back to the
 * caller through whatever the feature renders.
 *
 * The guard here is the one `triggers/fetch-image.js` has carried since T-734
 * for images, lifted out so every URL-taking feature uses the same primitive
 * instead of its own `fetch` (the 2026-10-06 estate review found the article
 * scraper and the supporting-document fetch doing exactly that, AP-B2), and
 * tightened on PR #889's review:
 *
 *   - http(s) only; `localhost` and every IPv6 literal refused by name, and a
 *     name that does not resolve is a refusal too (fail closed: a host the
 *     guard cannot classify is not fetched and not handed to a fallback);
 *   - the hostname resolved to IPv4 before the request, and refused when the
 *     address is loopback, link-local (the cloud metadata range), RFC 1918,
 *     carrier-grade NAT, multicast/reserved, or Azure's platform address
 *     168.63.129.16 (WireServer, which answers plain HTTP);
 *   - the connection is PINNED to the address that passed: the request is
 *     dispatched through an undici Agent whose DNS lookup returns that one
 *     answer, so a rebinding host (public A record for the check, private
 *     one for the connect) gets the address the guard saw, while Host and
 *     TLS SNI stay the original hostname;
 *   - redirects followed manually, up to `maxRedirects`, every hop
 *     re-validated and re-pinned — and, with `httpsOnly`, refused on any hop
 *     that is not https, so an https request cannot be redirected down to
 *     plain http (the MCP OAuth flow, lib/ai/mcp-oauth.js, sets it);
 *   - one deadline over the whole exchange, body included, and a byte cap on
 *     the body, so a server that sends headers and then stalls, or streams
 *     without end, is cut off rather than held open.
 *
 * Because the body must be read under the deadline, this helper returns the
 * bytes, not a live Response: `{ response, buffer, text() }`. Resolution and
 * the dispatcher factory are injectable for tests and nothing else.
 *
 * `guardedFetchStream` (ADR 0040 D2, the interview audio URL) is the same
 * guard for a body too large to hold: it returns a counting Readable instead
 * of a buffer, with the cap and the deadline enforced on the stream.
 */
import { pinnedDispatcher } from './url-guard.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  abortPromise,
  armDeadline,
  asTimeout,
  requestWithRedirects,
  tooLarge,
} from './fetch-hops.js';

export { DEFAULT_MAX_BODY_BYTES } from './fetch-hops.js';

export { FetchRefusedError, isPrivateIp, pinnedDispatcher, pinnedLookup, validateFetchUrl } from './url-guard.js';
export { guardedFetchStream, responseMediaType, urlPathExtension } from './guarded-fetch-stream.js';


/**
 * The response body as a Buffer, read under `signal` and capped at `maxBytes`.
 * Streams are read chunk by chunk so the cap holds before the bytes exist;
 * a response without a stream (a test double) is read whole and then measured.
 */
async function readBody(response, { maxBytes, signal }) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);

  const stream = response.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    // One listener for the whole read, not one per chunk: a 500 MiB body is
    // tens of thousands of chunks, and a listener per chunk is a leak and a
    // MaxListenersExceededWarning. The catch keeps a late abort from being
    // an unhandled rejection once the read has returned.
    const aborted = abortPromise(signal);
    aborted.catch(() => {});
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw tooLarge(maxBytes);
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
      if (total > maxBytes) stream.cancel?.().catch(() => {});
    }
    return Buffer.concat(chunks);
  }

  const whole = await Promise.race([
    typeof response.arrayBuffer === 'function'
      ? response.arrayBuffer().then((ab) => Buffer.from(ab))
      : response.text().then((t) => Buffer.from(String(t), 'utf8')),
    abortPromise(signal),
  ]);
  if (whole.byteLength > maxBytes) throw tooLarge(maxBytes);
  return whole;
}

/**
 * Fetch an untrusted URL: validated and pinned before the request and again
 * on every redirect hop, the body read under one deadline and one byte cap.
 * Returns `{ response, buffer, text }` (the response may still be non-2xx —
 * status handling stays with the caller). Throws on a refused or unresolvable
 * address (`refused: true`), a redirect with no Location, more than
 * `maxRedirects` hops, an oversized body (`BODY_TOO_LARGE`), or the deadline
 * (`FETCH_TIMEOUT`).
 *
 * @param {string} url
 * @param {{ fetch?: typeof fetch, resolve?: Function, dispatcherFor?: Function,
 *   maxRedirects?: number, timeoutMs?: number, maxBytes?: number,
 *   headers?: Record<string,string>, method?: string, body?: any,
 *   httpsOnly?: boolean }} [deps]
 * @returns {Promise<{ response: Response, buffer: Buffer, text: () => string }>}
 */
export async function guardedFetch(
  url,
  {
    fetch: fetchImpl = globalThis.fetch,
    resolve,
    dispatcherFor = pinnedDispatcher,
    maxRedirects = 5,
    timeoutMs = 30000,
    maxBytes = DEFAULT_MAX_BODY_BYTES,
    headers,
    method = 'GET',
    body,
    httpsOnly = false,
    signal: parentSignal,
  } = {}
) {
  const { signal, timer } = armDeadline(timeoutMs, parentSignal);
  if (signal.aborted) {
    clearTimeout(timer);
    throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  try {
    const { response, dispatcher } = await requestWithRedirects(url, {
      fetchImpl,
      resolve,
      dispatcherFor,
      maxRedirects,
      httpsOnly,
      headers,
      method,
      body,
      signal,
    });
    try {
      const buffer = await readBody(response, { maxBytes, signal });
      return { response, buffer, text: () => buffer.toString('utf8') };
    } finally {
      dispatcher?.close?.().catch?.(() => {});
    }
  } catch (error) {
    throw asTimeout(error, { parentSignal, timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}

