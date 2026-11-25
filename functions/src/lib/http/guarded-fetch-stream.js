/**
 * http/guarded-fetch-stream.js — `guardedFetchStream` (ADR 0040 D2, the
 * interview audio URL): the same guard as guardedFetch (guarded-fetch.js,
 * whose header explains it) for a body too large to hold, returned as a
 * counting Readable with the cap and the deadline enforced on the stream.
 * guarded-fetch.js re-exports it, so callers keep one import.
 */
import { Readable } from 'node:stream';
import { pinnedDispatcher } from './url-guard.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  abortPromise,
  armDeadline,
  asTimeout,
  requestWithRedirects,
  tooLarge,
} from './fetch-hops.js';

/** The media type of a response, lower-cased, without parameters; '' when absent. */
export function responseMediaType(response) {
  return String(response?.headers?.get?.('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** The lower-cased extension of a URL's path, or '' when it has none. */
export function urlPathExtension(urlString) {
  let pathname = '';
  try {
    pathname = new URL(urlString).pathname;
  } catch {
    return '';
  }
  const last = pathname.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * Fetch an untrusted URL as a STREAM, for a body too large to hold (an
 * interview recording, ADR 0040 D2). Every check `guardedFetch` makes is
 * made here: the same validation and pinning, the same manual redirects
 * re-checked on every hop, `httpsOnly` (on by default here), one deadline
 * over the whole exchange, and the byte cap — counted on the stream instead
 * of a buffer, so the stream destroys itself with `BODY_TOO_LARGE` the
 * moment the cap is crossed, and with `FETCH_TIMEOUT` when the deadline
 * passes mid-body. A declared `Content-Length` over the cap is refused
 * before a byte is read.
 *
 * Three checks the buffered fetch does not make, because its callers judge
 * the body themselves: with `allowHost`, a function of the hostname, every
 * hop's host must be allowed (HOST_NOT_ALLOWED, a refusal), so an allowed
 * host cannot redirect past the rule; with `allowedTypes`, the response's media type must
 * be one of them, or `application/octet-stream` with an `allowedExtensions`
 * extension on the final URL's path (a file host that does not know what it
 * serves); and a non-2xx status is refused (`FETCH_STATUS`), since nothing
 * streams an error page into storage.
 *
 * Returns `{ response, stream, bytesRead, url }`: `stream` is a Node
 * `Readable` of the body, `bytesRead()` the count so far, `url` the final
 * URL after redirects. The dispatcher and the deadline timer are released
 * when the stream ends or is destroyed; a caller that does not consume the
 * stream destroys it.
 *
 * @param {string} url
 * @param {{ fetch?: typeof fetch, resolve?: Function, dispatcherFor?: Function,
 *   maxRedirects?: number, timeoutMs?: number, maxBytes?: number,
 *   headers?: Record<string,string>, httpsOnly?: boolean, allowHost?: (hostname: string) => boolean,
 *   allowedTypes?: string[], allowedExtensions?: string[], signal?: AbortSignal }} [deps]
 * @returns {Promise<{ response: Response, stream: Readable, bytesRead: () => number, url: string }>}
 */
export async function guardedFetchStream(
  url,
  {
    fetch: fetchImpl = globalThis.fetch,
    resolve,
    dispatcherFor = pinnedDispatcher,
    maxRedirects = 5,
    timeoutMs = 30000,
    maxBytes = DEFAULT_MAX_BODY_BYTES,
    headers,
    httpsOnly = true,
    allowHost = null,
    allowedTypes = null,
    allowedExtensions = null,
    signal: parentSignal,
  } = {}
) {
  const { signal, timer } = armDeadline(timeoutMs, parentSignal);
  if (signal.aborted) {
    clearTimeout(timer);
    throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  let dispatcher;
  try {
    const hop = await requestWithRedirects(url, {
      fetchImpl,
      resolve,
      dispatcherFor,
      maxRedirects,
      httpsOnly,
      headers,
      method: 'GET',
      body: undefined,
      signal,
      allowHost,
    });
    ({ dispatcher } = hop);
    const { response } = hop;
    // A body refused before it is streamed is cancelled, so the socket is
    // not left draining an error page or a file of the wrong kind.
    const refuse = (error) => {
      response.body?.cancel?.().catch?.(() => {});
      return error;
    };
    if (response.status < 200 || response.status >= 300) {
      throw refuse(
        Object.assign(new Error(`HTTP ${response.status} fetching the URL`), {
          code: 'FETCH_STATUS',
          status: response.status,
        })
      );
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw refuse(tooLarge(maxBytes));
    if (Array.isArray(allowedTypes)) {
      const type = responseMediaType(response);
      const extension = urlPathExtension(hop.url);
      const typeOk = allowedTypes.includes(type);
      const octetOk =
        type === 'application/octet-stream' &&
        Array.isArray(allowedExtensions) &&
        allowedExtensions.includes(extension);
      if (!typeOk && !octetOk) {
        throw refuse(
          Object.assign(new Error(`Unsupported content type: ${type || '(none)'}`), {
            code: 'UNSUPPORTED_TYPE',
          })
        );
      }
    }
    const stream = countingStream(response, { maxBytes, signal, parentSignal, timeoutMs });
    const release = () => {
      clearTimeout(timer);
      dispatcher?.close?.().catch?.(() => {});
    };
    stream.once('close', release);
    return { response, stream, bytesRead: () => stream.bytesRead, url: hop.url };
  } catch (error) {
    clearTimeout(timer);
    dispatcher?.close?.().catch?.(() => {});
    throw asTimeout(error, { parentSignal, timeoutMs });
  }
}

/**
 * The response body as a Node Readable that counts its bytes, destroys
 * itself past `maxBytes` (BODY_TOO_LARGE) and ends with FETCH_TIMEOUT when
 * the deadline fires mid-body. A response without a web stream (a test
 * double) is read whole and measured.
 */
function countingStream(response, { maxBytes, signal, parentSignal, timeoutMs }) {
  const web = response.body;
  const reader = web && typeof web.getReader === 'function' ? web.getReader() : null;
  let total = 0;
  let whole = null;
  // One abort listener for the whole stream (see readBody).
  const aborted = abortPromise(signal);
  aborted.catch(() => {});
  const stream = new Readable({
    async read() {
      try {
        if (reader) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) {
            this.push(null);
            return;
          }
          total += value.byteLength;
          if (total > maxBytes) throw tooLarge(maxBytes);
          this.push(Buffer.from(value));
          return;
        }
        if (whole === null) {
          whole = await Promise.race([
            typeof response.arrayBuffer === 'function'
              ? response.arrayBuffer().then((ab) => Buffer.from(ab))
              : response.text().then((t) => Buffer.from(String(t), 'utf8')),
            aborted,
          ]);
          total = whole.byteLength;
          if (total > maxBytes) throw tooLarge(maxBytes);
          this.push(whole);
          return;
        }
        this.push(null);
      } catch (error) {
        this.destroy(asTimeout(error, { parentSignal, timeoutMs }));
      }
    },
    destroy(error, callback) {
      reader?.releaseLock?.();
      web?.cancel?.().catch?.(() => {});
      callback(error);
    },
  });
  Object.defineProperty(stream, 'bytesRead', { get: () => total });
  return stream;
}
