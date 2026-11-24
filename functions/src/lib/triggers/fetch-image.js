/**
 * fetch-image.js — download an external image safely.
 *
 * Ported from Site-Main `fetchImage` / `validateUrl` / `isExternalUrlString`
 * (index.js, 088f458). The SSRF guard is the point: http(s) only, no
 * localhost, the hostname resolved to IPv4 and refused if private — and
 * re-checked on every redirect hop (redirects are followed manually, up to
 * five), so a public host cannot bounce the fetch onto the private network.
 *
 * The second guard is the media type (issue #415). Until then the fetcher
 * returned whatever bytes came back and let the caller name the blob, and the
 * only mapping from type to extension defaulted to `png` — so a `video/mp4`
 * hotlinked from an `<img src>` in an article body would have been stored as
 * a `.png`, and nothing downstream would have noticed: the blob exists, the
 * rewrite succeeds, and the page renders an `<img>` at a file that will never
 * paint. #413 closed the same hole on the frontend, where only the URL can be
 * tested; here the response itself is in hand, so the gate is on the measured
 * `Content-Type`, which is strictly stronger than an extension guess.
 */
import { isPrivateIp, pinnedDispatcher, validateFetchUrl } from '../http/guarded-fetch.js';
import { withUpstreamStatus } from '../http/error-response.js';

// The SSRF guard lives in lib/http/guarded-fetch.js since the 2026-10-06
// review (AP-B2) so the scraper and the document fetch share it; re-exported
// here so existing importers and tests keep their names.
export { isPrivateIp, validateFetchUrl };

/**
 * The image types this site stores, and the extension each is stored under.
 *
 * This map is the gate as well as the naming table: a type that is not a key
 * here is refused, whether it is a video, an octet-stream, or an image format
 * (`image/tiff`, `image/heic`) no browser paints into an `<img>`. Refusing an
 * unmapped image type rather than defaulting its extension is deliberate —
 * a default is precisely the silent mislabel #415 is about, and a refusal is
 * visible (it lands in `inlineImages.failed` and in the log), so the day a
 * real format shows up we add a line here instead of finding a broken image.
 */
export const MIME_TO_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/avif': 'avif',
});

/**
 * A response's media type without its parameters and lower-cased, so
 * `IMAGE/PNG; charset=binary` and `image/png` are the same key. `''` when the
 * header was absent or empty.
 */
export function normalizeMediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** The extension this media type is stored under, or null when it must not be stored. */
export function imageExtensionFor(contentType) {
  return MIME_TO_EXT[normalizeMediaType(contentType)] ?? null;
}

/**
 * The extension for a media type that has already passed the gate.
 *
 * Throws rather than defaulting. Every caller of this reaches it with a type
 * `fetchImage` measured and accepted, so a null here is a bug in this module,
 * not a bad upstream — and a thrown error is caught per-image by every caller,
 * where a defaulted `.png` would have been written to storage.
 */
export function requireImageExtension(contentType) {
  const ext = imageExtensionFor(contentType);
  if (ext) return ext;
  throw new Error(
    `No stored extension for media type ${normalizeMediaType(contentType) || '(none)'}`
  );
}

/**
 * Why a response with this media type must not be stored, or null when it may
 * be. The `code` is what a caller branches on; `reason` is the sentence that
 * goes in a log line or a failure record, and it never contains a URL.
 *
 * @returns {{ code: string, reason: string } | null}
 */
function mediaTypeRefusal(contentType) {
  const type = normalizeMediaType(contentType);
  if (!type) return { code: 'no-media-type', reason: 'the response declared no Content-Type' };
  if (imageExtensionFor(type)) return null;
  return type.startsWith('image/')
    ? { code: 'unsupported-image-type', reason: `image type ${type} is not one this site stores` }
    : { code: 'not-an-image', reason: `Content-Type ${type} is not an image` };
}

/** True for a plain external http(s) URL string — not Firebase/GCS storage, not a Rowy object. */
export function isExternalUrlString(value) {
  if (!value || typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  // Still excluded, and now for a second reason (#518). These were excluded as
  // "already ours" during the migration; the bucket is gone, so a fetch would
  // 404 and there is nothing to re-host either way. Removing the check would
  // only trade a skip for a failed download.
  if (
    parsed.hostname === 'firebasestorage.googleapis.com' ||
    parsed.hostname === 'storage.googleapis.com'
  )
    return false;
  return true;
}

/**
 * Ceiling on a fetched image, in bytes (T-734). Generous for a cover or an
 * in-article picture, and small enough that a hostile or broken origin cannot
 * make the host buffer an arbitrary amount of memory.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Fetch an external image, or say why it will not be stored.
 *
 * TWO RESULTS, ONE OF THEM NOT AN EXCEPTION. A media-type refusal is returned,
 * not thrown, because it is not a failure of the fetch: the request succeeded
 * and the response was read, it simply is not an image this site can serve.
 * That distinction matters to the inline re-hoster, which leaves the original
 * URL in place and carries on with the article's other images — a decision it
 * can now make from a field rather than from an error message. `refused` is
 * absent on success, so `if (result.refused)` is the whole test.
 *
 * Everything else still throws: a bad protocol, a private address, a non-2xx,
 * a redirect loop, a timeout, an oversized body. Those are fetch failures and
 * every call site already catches them.
 *
 * The gate runs on the headers, before `arrayBuffer()`, so a refused response
 * is never buffered at all.
 *
 * @param {string} url
 * @param {{ fetch?: typeof fetch, resolve?: Function, maxRedirects?: number, timeoutMs?: number, maxBytes?: number }} [deps]
 * @returns {Promise<
 *   { buffer: Buffer, contentType: string } |
 *   { refused: 'no-media-type'|'not-an-image'|'unsupported-image-type', contentType: string, reason: string }
 * >}
 */
export async function fetchImage(
  url,
  {
    fetch: fetchImpl = globalThis.fetch,
    resolve,
    maxRedirects = 5,
    timeoutMs = 15000,
    maxBytes = MAX_IMAGE_BYTES,
  } = {}
) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // The connection is pinned to the address the guard validated (PR #889
    // review): a rebinding host cannot answer the check with a public
    // address and the connect with a private one.
    const { address } = await validateFetchUrl(current, resolve ? { resolve } : {});
    const dispatcher = pinnedDispatcher(address);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
        headers: { 'User-Agent': 'Mozilla/5.0 HybridCloudWorks-Bot/1.0' },
      });
    } catch (error) {
      clearTimeout(timer);
      dispatcher.close().catch(() => {});
      throw error?.name === 'AbortError'
        ? new Error(`Request timed out fetching ${current}`)
        : error;
    }
    try {
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || hop === maxRedirects)
          throw withUpstreamStatus(new Error(`HTTP ${response.status} fetching ${current}`), response.status);
        current = /^https?:\/\//i.test(location) ? location : new URL(location, current).href;
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw withUpstreamStatus(new Error(`HTTP ${response.status} fetching ${current}`), response.status);
      const contentType = normalizeMediaType(response.headers.get('content-type'));
      // Before the bytes: a type this site will not store is refused here, so
      // a video or an octet-stream is never buffered, never named and never
      // uploaded. Note there is no `|| 'image/png'` fallback any more — a
      // missing Content-Type means nothing was measured, and inventing one is
      // the same mislabel as accepting the wrong one.
      const refusal = mediaTypeRefusal(contentType);
      if (refusal) return { refused: refusal.code, contentType, reason: refusal.reason };
      // Refuse before buffering when the server declares an oversized body
      // (T-734). Content-Length is a hint, not a guarantee, so the buffered
      // length is re-checked below — but honouring it avoids pulling the bytes
      // at all in the common case.
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Image at ${current} declares ${declared} bytes (max ${maxBytes})`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new Error(`Image at ${current} is ${buffer.length} bytes (max ${maxBytes})`);
      }
      return { buffer, contentType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects fetching ${url}`);
}
