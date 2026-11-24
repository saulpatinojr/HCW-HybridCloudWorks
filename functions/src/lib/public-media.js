/**
 * Anonymous media delivery — `GET|HEAD public/media/{container}/{*blobPath}`.
 *
 * The delivery model this implements, and why (T-105):
 *
 * The storage account sets `allow_nested_items_to_be_public = false` and
 * `network_rules { default_action = "Deny" }`. The first is a master override,
 * not a default: with it false, a container declared `container_access_type =
 * "blob"` still answers 409 to an anonymous reader. The second blocks the
 * internet from the account outright. So the three containers marked public in
 * Terraform never served a byte, and `uploadBlob`'s returned URL — persisted
 * into Cosmos as `imageUrl` — was dead on arrival.
 *
 * Two ways out. Open the account and front it with a CDN, which means reversing
 * both settings, exposing the account to the internet, and adding a service
 * with a monthly floor against a USD 150 design ceiling. Or keep the account
 * closed and read through the Function App's managed identity, which already
 * holds Storage Blob Data Contributor and already reaches the account over the
 * integrated subnet.
 *
 * This is the second. It adds no Azure resource, reverses no security setting,
 * and leaves a CDN free to be layered in front of the site origin later without
 * touching application code — cache headers here are written so that it can be.
 * The first option is not planned. It is a possible future alternative, and
 * choosing it would be a spend decision for the owner rather than an
 * engineering one.
 *
 * Cost note: this puts image bytes through Function invocations. `immutable`
 * cache headers plus conditional-request support keep repeat views off the
 * function entirely, which is what makes the arithmetic work for a content
 * site. Blob paths carry a timestamp already ({docId}/images/badge-{ts}.png),
 * so content is genuinely immutable per URL.
 *
 * Byte ranges (issue #349, ADR 0029). Listen & Learn episodes are served from
 * this route too, and an `<audio>` element seeks by sending `Range:
 * bytes=start-end`. Until 2026-09-07 the route ignored the header and answered
 * every seek with the whole file, so scrubbing to minute eight downloaded
 * minutes one to seven first. The route now honours a single byte range with
 * `206 Partial Content`, refuses one that starts past the end with `416`, and
 * advertises `Accept-Ranges: bytes` on every success — which is also what a
 * podcast directory requires of an enclosure host, so a self-hosted feed
 * (option 3 on #349) is no longer blocked here. Multiple ranges in one request
 * are ignored and answered with the full 200, which RFC 9110 permits and every
 * browser accepts; `If-Range` is not evaluated, which is safe only because a
 * URL here never changes content — the path carries the timestamp.
 */

import { isValidBlobPath, PUBLIC_MEDIA_CONTAINERS } from './blob-paths.js';
import { errorFacts } from './http/error-response.js';

/** One year. The path is content-addressed by timestamp, so this is safe. */
const MAX_AGE_SECONDS = 31536000;

const CACHE_CONTROL = `public, max-age=${MAX_AGE_SECONDS}, immutable`;

/**
 * Five minutes, for a path that is NOT content-addressed. Listen & Learn
 * audio written before ADR 0033 §4 lives at `{provider}/{exam}/{slug}.mp3`
 * with no stamp, and a regeneration rewrote the same path — so a browser that
 * had cached the old take under the immutable header above kept playing it
 * for a year. Paths written since carry `-{yyyymmddHHMMSS}` before the
 * extension and never change content, so they keep the immutable header.
 */
const REVALIDATE_SECONDS = 300;

const STAMPED_AUDIO_PATH = /-\d{14}\.[a-z0-9]+$/i;

/**
 * The cache header for one blob: immutable for every content-addressed path,
 * a short revalidating cache for an unstamped Listen & Learn path.
 *
 * @param {string} container
 * @param {string} blobPath
 * @returns {string}
 */
export function cacheControlFor(container, blobPath) {
  if (container === 'listenandlearn' && !STAMPED_AUDIO_PATH.test(String(blobPath || ''))) {
    return `public, max-age=${REVALIDATE_SECONDS}`;
  }
  return CACHE_CONTROL;
}

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Parse a `Range` request header.
 *
 * Returns `null` for anything the route should ignore and answer in full: no
 * header, a unit other than `bytes`, more than one range, or a range that does
 * not parse (RFC 9110 §14.2: a server MAY ignore the header). The distinction
 * that matters is between *ignore* and *refuse*: `bytes=abc` is a malformed
 * header and gets the whole file; `bytes=999999-` is a well-formed request for
 * bytes that do not exist and gets a 416 — that decision needs the size, so it
 * belongs to `resolveRange`.
 *
 * @param {string|null|undefined} value
 * @returns {{start: number, end: number|null}|{suffix: number}|null}
 */
export function parseRangeHeader(value) {
  const spec = singleByteRangeSpec(value);
  if (spec === null) return null;

  const suffix = /^-(\d+)$/.exec(spec);
  if (suffix) return { suffix: Number(suffix[1]) };

  const pair = /^(\d+)-(\d*)$/.exec(spec);
  if (!pair) return null;
  const start = Number(pair[1]);
  const end = pair[2] === '' ? null : Number(pair[2]);
  return end !== null && end < start ? null : { start, end };
}

/**
 * The one range-spec after `bytes=`, or null for a header the route ignores:
 * absent, another unit, empty, or more than one range.
 */
function singleByteRangeSpec(value) {
  const match = /^bytes=(.*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const spec = match[1].trim();
  return !spec || spec.includes(',') ? null : spec;
}

/**
 * Turn a parsed range into inclusive offsets against a known size, or `null`
 * when nothing in it can be satisfied: a start at or past the end, a suffix
 * of zero bytes, or an empty blob. An end past the last byte is clamped, not
 * refused — that is what `bytes=0-` and a browser's optimistic `bytes=0-1023`
 * on a smaller file both rely on.
 *
 * @param {{start: number, end: number|null}|{suffix: number}} range
 * @param {number} totalLength
 * @returns {{start: number, end: number}|null}
 */
export function resolveRange(range, totalLength) {
  if (!Number.isInteger(totalLength) || totalLength <= 0) return null;
  const last = totalLength - 1;
  if ('suffix' in range) {
    if (range.suffix <= 0) return null;
    return { start: Math.max(0, totalLength - range.suffix), end: last };
  }
  if (range.start > last) return null;
  return { start: range.start, end: range.end === null ? last : Math.min(range.end, last) };
}

/** The headers every successful answer carries, body or not. */
function deliveryHeaders({ contentType, etag }, cacheControl = CACHE_CONTROL) {
  return {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    ...(etag ? { ETag: etag } : {}),
    // The bytes are already public; this only stops a browser from sniffing
    // them into something executable.
    'X-Content-Type-Options': 'nosniff',
  };
}

const notModified = (etag, cacheControl = CACHE_CONTROL) => ({
  status: 304,
  headers: { ETag: etag, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' },
});

/**
 * Does an `If-None-Match` header match this ETag? RFC 9110 §13.1.2: the
 * header is `*` (matches any current representation) or a comma-separated
 * list of entity tags, any of which may be weak (`W/"…"`). Comparison for
 * `If-None-Match` is the weak one, so `W/` is stripped before comparing
 * quoted tags. Strict string equality missed a list or a weak tag and forced
 * a byte read the client would then discard.
 *
 * @param {string|null|undefined} header
 * @param {string} etag - the blob's ETag, quoted, as the SDK returns it
 * @returns {boolean}
 */
export function ifNoneMatchMatches(header, etag) {
  const value = String(header || '').trim();
  if (!value || !etag) return false;
  if (value === '*') return true;
  const normalise = (tag) => tag.trim().replace(/^W\//i, '');
  const wanted = normalise(etag);
  return value
    .split(',')
    .map(normalise)
    .some((tag) => tag && tag === wanted);
}

const etagMatches = (request, etag) =>
  ifNoneMatchMatches(request.headers?.get?.('if-none-match'), etag);

const notFound = () => json(404, { error: 'Not found' });

function unsatisfiable(totalLength) {
  return {
    status: 416,
    headers: {
      'Content-Range': `bytes */${totalLength}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  };
}

/**
 * HEAD: the 200's headers, sized for the whole blob, and no body. Without a
 * properties reader (`canHead`) the full read supplies them.
 */
async function head(storage, canHead, container, blobPath, request) {
  const cacheControl = cacheControlFor(container, blobPath);
  const blob = canHead
    ? await storage.headBlobForDelivery(container, blobPath)
    : await storage.readBlobForDelivery(container, blobPath);
  if (!blob) return notFound();
  if (etagMatches(request, blob.etag)) return notModified(blob.etag, cacheControl);
  return {
    status: 200,
    headers: {
      ...deliveryHeaders(blob, cacheControl),
      'Content-Length': String(blob.contentLength ?? blob.body?.length ?? 0),
    },
  };
}

/**
 * The inclusive offsets a ranged read is made with, or the answer that
 * pre-empts the read. A conditional request or a suffix needs the blob's
 * properties before any bytes are read: the first so a matching ETag answers
 * 304 without a ranged download it would then discard, the second because a
 * suffix is relative to a size this route does not know yet. One properties
 * read serves both; a plain absolute range needs none.
 *
 * @returns {Promise<{offsets: {start: number, end: number|null}} | {response: object}>}
 */
export async function resolveRangeOffsets(storage, { container, blobPath, request, range }) {
  const conditional = Boolean(request.headers?.get?.('if-none-match'));
  if (!conditional && !('suffix' in range)) return { offsets: range };

  const blob = await storage.headBlobForDelivery(container, blobPath);
  if (!blob) return { response: notFound() };
  if (etagMatches(request, blob.etag)) {
    return { response: notModified(blob.etag, cacheControlFor(container, blobPath)) };
  }
  if (!('suffix' in range)) return { offsets: range };
  const offsets = resolveRange(range, blob.contentLength);
  return offsets ? { offsets } : { response: unsatisfiable(blob.contentLength) };
}

/** A single satisfiable-or-not byte range: 206, 416, or 304. */
async function partial(storage, container, blobPath, request, range) {
  const cacheControl = cacheControlFor(container, blobPath);
  const resolved = await resolveRangeOffsets(storage, { container, blobPath, request, range });
  if (resolved.response) return resolved.response;

  const chunk = await storage.readBlobRangeForDelivery(container, blobPath, resolved.offsets);
  if (!chunk) return notFound();
  if (chunk.unsatisfiable) return unsatisfiable(chunk.totalLength);

  return {
    status: 206,
    headers: {
      ...deliveryHeaders(chunk, cacheControl),
      'Content-Range': `bytes ${chunk.start}-${chunk.end}/${chunk.totalLength}`,
      'Content-Length': String(chunk.body.length),
    },
    body: chunk.body,
  };
}

/** The whole blob, exactly as before ranges existed, plus `Accept-Ranges`. */
async function full(storage, container, blobPath, request) {
  const cacheControl = cacheControlFor(container, blobPath);
  const blob = await storage.readBlobForDelivery(container, blobPath);
  if (!blob) return notFound();
  if (etagMatches(request, blob.etag)) return notModified(blob.etag, cacheControl);
  return {
    status: 200,
    headers: deliveryHeaders(blob, cacheControl),
    body: blob.body,
  };
}

// ── the per-method responders ──────────────────────────────────────────────
// Each takes the one request as `{ media: { storage, canRange, canHead },
// container, blobPath, request, context, method, range }`.

function respondHead({ media, container, blobPath, request, context }) {
  if (!media.canHead) context.warn?.('getMedia: no headBlobForDelivery; HEAD via full read');
  return head(media.storage, media.canHead, container, blobPath, request);
}

function respondPartial({ media, container, blobPath, request, range }) {
  return partial(media.storage, container, blobPath, request, range);
}

/** A Range the storage cannot serve: warned, then the full answer (RFC 9110 permits ignoring it). */
function respondFullIgnoringRange(req) {
  req.context.warn?.('getMedia: ranged readers not wired; Range ignored, serving in full');
  return respondFull(req);
}

function respondFull({ media, container, blobPath, request }) {
  return full(media.storage, container, blobPath, request);
}

/**
 * Guard → responder, tried in order; the first guard that holds answers.
 * The ranged path needs both readers: bytes from one, and the size and ETag
 * a suffix or a conditional needs from the other.
 */
const RESPONDERS = [
  [(req) => req.method === 'HEAD', respondHead],
  [(req) => req.range !== null && req.media.canRange && req.media.canHead, respondPartial],
  [(req) => req.range !== null, respondFullIgnoringRange],
  [() => true, respondFull],
];

/** Every outcome for one request, body included where the method allows one. */
async function dispatch(media, request, context) {
  const container = String(request.params?.container || '').trim();
  const blobPath = String(request.params?.blobPath || '').trim();

  // Order matters: an unknown container must not be distinguishable from a
  // known-but-empty one by response shape, and neither reveals whether a
  // private container exists.
  if (!PUBLIC_MEDIA_CONTAINERS.has(container)) return notFound();
  if (!isValidBlobPath(blobPath)) return notFound();

  try {
    const req = {
      media,
      container,
      blobPath,
      request,
      context,
      method: String(request.method || '').toUpperCase(),
      range: parseRangeHeader(request.headers?.get?.('range')),
    };
    const [, respond] = RESPONDERS.find(([when]) => when(req));
    return await respond(req);
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === 'BlobNotFound') return notFound();
    context.error('getMedia failed:', errorFacts(error));
    return json(500, { error: 'Failed to read media' });
  }
}

/** GET|HEAD /api/public/media/{container}/{*blobPath} */
async function getMedia(media, request, context) {
  const result = await dispatch(media, request, context);
  // A HEAD response carries headers only, on every status: the 404s and
  // the 500 above are shaped for GET, and a body on a HEAD is a protocol
  // error the host would otherwise pass through.
  if (String(request.method || '').toUpperCase() === 'HEAD' && result && 'body' in result) {
    const { body: _dropped, ...headersOnly } = result;
    return headersOnly;
  }
  return result;
}

/**
 * All three readers are required: the route registers HEAD and honours
 * Range, and `functions/public-media.js` wires all three. A storage that
 * lacks one — an older test double, say — degrades to the behaviour the
 * route had before ranges existed rather than throwing: a Range request is
 * ignored and served in full (RFC 9110 permits ignoring the header), and a
 * HEAD is answered from the full read with the body dropped.
 *
 * @param {object} deps
 * @param {{
 *   readBlobForDelivery: Function,
 *   readBlobRangeForDelivery: Function,
 *   headBlobForDelivery: Function,
 * }} deps.storage
 */
export function createPublicMediaHandlers({ storage }) {
  const media = {
    storage,
    canRange: typeof storage.readBlobRangeForDelivery === 'function',
    canHead: typeof storage.headBlobForDelivery === 'function',
  };
  return {
    getMedia: (request, context) => getMedia(media, request, context),
  };
}
