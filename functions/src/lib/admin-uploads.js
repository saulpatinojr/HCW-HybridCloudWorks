/**
 * Admin file uploads — the replacement for the browser's direct
 * firebase/storage uploadBytes calls (CertificationsPage badge images today;
 * the gallery and cover flows migrate onto the same route later).
 *
 * The browser sends base64 JSON instead of raw bytes: payloads here are small
 * images (the pages already enforce a 5 MB picker limit), and a JSON body
 * rides through authedFetch and the role guard unchanged.
 *
 * Three things about the body are checked, in increasing order of cost, and
 * every one of them is enforcement rather than UX (T-306, T-307):
 *
 *   1. `Content-Length`, before the body is read at all. Cheapest and least
 *      trustworthy — the header is caller-supplied and absent on a chunked
 *      request — so it is an early reject, not the limit.
 *   2. `dataBase64.length`, before `Buffer.from`. This is the one that
 *      actually bounds memory: decoding first and measuring after meant a
 *      100 MB body peaked around 250 MB (JSON text + base64 string + decoded
 *      buffer) on a 2048 MB instance before the 413 was returned.
 *   3. The decoded byte count, which stays the final authority because base64
 *      tolerates whitespace and padding.
 *
 * `contentType` is likewise not taken on trust. It is caller-chosen, it is
 * stored as the blob's Content-Type, and the media delivery route serves it
 * verbatim: without an allowlist an editor could upload `evil.html` as
 * `text/html` and host arbitrary content on an org-owned domain. The declared
 * type must be in the allowlist AND agree with the path's extension.
 *
 * Containers are allowlisted to the five content stores (the same set
 * gallery-images.js parseStorageRef maps GCS paths onto). The blob path is
 * caller-chosen to preserve the existing naming scheme
 * ({docId}/images/badge-{ts}.png) but validated hard: one character class,
 * no dot-dot, no leading slash — this string becomes part of a URL and a
 * storage key.
 */

import {
  isValidBlobPath,
  mediaUrlFor,
  PUBLIC_MEDIA_CONTAINERS,
  UPLOAD_CONTAINERS,
} from './blob-paths.js';
import { normalizeBadgeImage, withExtension } from './badge-image.js';
import { randomUUID } from 'node:crypto';
import { recordMutationAudit } from './audit.js';

/**
 * Containers whose uploads are decoded and re-encoded before they are stored
 * (badge-image.js): every object written here is a BADGE_SIZE-square PNG,
 * whatever the browser sent. For these the public-container SVG refusal
 * below does not apply, because the SVG is rasterised and never stored; the
 * declared type still has to be an image type and agree with the extension,
 * and the stored path takes the PNG extension.
 */
export const NORMALIZED_UPLOAD_CONTAINERS = new Set(['certifications']);

// Re-exported: these moved to blob-paths.js so the delivery route could share
// them without a cycle, and call sites and tests still import them from here.
export { isValidBlobPath, UPLOAD_CONTAINERS };

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// 15 MB: gallery hero/cover images run larger than cert badges, and the
// gallery pages never had a client-side cap under Firebase Storage.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Base64 expands 3 bytes into 4 characters, rounded up to a 4-character group.
export const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

// The JSON envelope around the payload: two short string fields, a path capped
// at 300 characters, key names, and escaping. 8 KB is generous for all of it.
export const MAX_REQUEST_BYTES = MAX_BASE64_CHARS + 8 * 1024;

/**
 * Media types the upload route accepts, each mapped to the file extensions
 * that may declare it. Both halves matter: the type governs what the delivery
 * route will serve, and the extension is what a browser or an operator sees.
 * Letting them disagree is how `badge.png` ends up served as `text/html`.
 */
export const ALLOWED_UPLOAD_MEDIA_TYPES = new Map([
  ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/webp', ['webp']],
  ['image/gif', ['gif']],
  ['image/avif', ['avif']],
  ['image/svg+xml', ['svg']],
]);

/**
 * Types accepted into private containers but not into the ones the anonymous
 * media route serves.
 *
 * SVG is a scriptable document, not an image: served from a public URL it
 * executes in the storage origin, and `X-Content-Type-Options: nosniff` does
 * not change that — nosniff stops a browser guessing a type, and here the
 * declared type is the problem. SubmitUrlsPage's picker offers SVG and uploads
 * to `content`, which is private, so that flow is unaffected; putting one on
 * the public delivery route is a separate decision and is refused here.
 */
export const PUBLIC_DENIED_MEDIA_TYPES = new Set(['image/svg+xml']);

/**
 * Document types accepted ONLY into containers the anonymous media route
 * does not serve (owner request 2026-10-05: the Ambassador hub archives a
 * program's agreements, role descriptions and exports beside the
 * application, under `ambassador/{id}/` in the private `speakerevents`
 * container). Never into a public container: a PDF or an Office file served
 * from the media origin is a document a browser opens, not an image.
 */
export const PRIVATE_ONLY_MEDIA_TYPES = new Map([
  ['application/pdf', ['pdf']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['pptx']],
  ['text/csv', ['csv']],
  ['text/plain', ['txt', 'md']],
  ['text/markdown', ['md']],
]);

/**
 * Strip parameters and case from a media type: `Image/PNG; charset=x` →
 * `image/png`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * The lowercased extension of a blob path, or `''` when the final segment has
 * none. Only reached for paths that already passed `isValidBlobPath`, so the
 * character set is known-safe.
 *
 * @param {string} path
 * @returns {string}
 */
export function extensionOf(path) {
  const segment = String(path).split('/').pop() || '';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  return segment.slice(dot + 1).toLowerCase();
}

/**
 * Decide whether a declared content type may be stored at a path in a
 * container.
 *
 * @param {object} args
 * @param {string} args.container
 * @param {string} args.path
 * @param {string} args.contentType - already normalized
 * @returns {{ok: true}|{ok: false, reason: string}} `reason` is a sentence
 *   written here, never an error's message, so the route may answer with it.
 */
export function checkUploadMediaType({ container, path, contentType }) {
  const isPublic = PUBLIC_MEDIA_CONTAINERS.has(container);
  const extensions =
    ALLOWED_UPLOAD_MEDIA_TYPES.get(contentType) ||
    (isPublic ? undefined : PRIVATE_ONLY_MEDIA_TYPES.get(contentType));
  if (!extensions) {
    return { ok: false, reason: 'Unsupported content type' };
  }
  const storedAsIs = !NORMALIZED_UPLOAD_CONTAINERS.has(container);
  if (
    storedAsIs &&
    PUBLIC_DENIED_MEDIA_TYPES.has(contentType) &&
    PUBLIC_MEDIA_CONTAINERS.has(container)
  ) {
    return {
      ok: false,
      reason: 'This content type is not accepted in a publicly served container',
    };
  }
  if (!extensions.includes(extensionOf(path))) {
    return { ok: false, reason: 'File extension does not match the declared content type' };
  }
  return { ok: true };
}

/**
 * Read `Content-Length` without assuming the request exposes headers the way
 * the runtime does — the handler is called with plain fakes in tests, and a
 * missing header is a normal outcome on a chunked request either way.
 *
 * @param {object} request
 * @returns {number} Byte count, or 0 when absent or unparseable.
 */
function readContentLength(request) {
  const raw = request?.headers?.get?.('content-length');
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ uploadBlob: Function }} deps.storage - uploadBlob(container, blobName, content, contentType, metadata, options) → public URL
 * @param {object} [deps.store] - Cosmos store for audit recording (optional)
 * @param {Function} [deps.now]
 * @param {Function} [deps.uuid]
 * @param {Function} [deps.normalizeImage] - badge-image.js normalizeBadgeImage, injectable for tests
 */
export function createAdminUploadHandlers({
  guard,
  storage,
  store = null,
  now = () => new Date(),
  uuid = randomUUID,
  normalizeImage = normalizeBadgeImage,
}) {
  return {
    /** POST /api/cms/uploads/{container} — {path, contentType, dataBase64} → {url} */
    async uploadFile(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;

      const container = String(request.params.container || '').trim();
      if (!UPLOAD_CONTAINERS.has(container)) {
        return json(404, { error: 'Unknown container' });
      }

      // Before the body is read. The Functions host has no request-size knob of
      // its own — `extensions.http` in host.json exposes routePrefix,
      // concurrency, hsts and customHeaders, and nothing else — so this is the
      // only place an oversized body can be turned away early.
      if (readContentLength(request) > MAX_REQUEST_BYTES) {
        return json(413, { error: 'File exceeds the 15MB upload limit' });
      }

      try {
        const body = await request.json().catch(() => null);
        const path = String(body?.path || '').trim();
        const contentType = normalizeMediaType(body?.contentType);
        const dataBase64 = String(body?.dataBase64 || '');

        if (!isValidBlobPath(path)) {
          return json(400, { error: 'Invalid path' });
        }

        const mediaType = checkUploadMediaType({ container, path, contentType });
        if (!mediaType.ok) {
          return json(415, { error: mediaType.reason });
        }

        if (!dataBase64) {
          return json(400, { error: 'dataBase64 is required' });
        }
        // Before `Buffer.from`, so an oversized payload costs one comparison
        // rather than a second full-size allocation.
        if (dataBase64.length > MAX_BASE64_CHARS) {
          return json(413, { error: 'File exceeds the 15MB upload limit' });
        }

        let buffer = Buffer.from(dataBase64, 'base64');
        if (buffer.length === 0) {
          return json(400, { error: 'dataBase64 is not valid base64' });
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
          return json(413, { error: 'File exceeds the 15MB upload limit' });
        }

        // After the size checks, so an oversized body is refused before it is
        // decoded, and before the write, so nothing but the normalised PNG
        // ever reaches a normalised container (badge-image.js).
        let storedPath = path;
        let storedType = contentType;
        if (NORMALIZED_UPLOAD_CONTAINERS.has(container)) {
          const normalized = await normalizeImage(buffer, { contentType });
          if (normalized.error) {
            return json(415, { error: normalized.error });
          }
          buffer = normalized.buffer;
          storedType = normalized.contentType;
          storedPath = withExtension(path, normalized.extension);
        }

        // `overwrite: false`. The path is caller-chosen, so without the
        // condition a request naming an existing key silently replaces a live
        // asset — every page that already persisted that URL starts serving
        // the new bytes. All three callers mint timestamped, randomized paths,
        // so a 409 here means something unintended.
        const blobUrl = await storage.uploadBlob(
          container,
          storedPath,
          buffer,
          storedType,
          {},
          { overwrite: false }
        );

        // The pages persist `url` into Cosmos, so it must be the URL that will
        // actually serve. The raw blob URL does not: the account is closed to
        // the internet and `allow_nested_items_to_be_public = false` overrides
        // the containers' public access (T-105). Public containers get
        // the delivery route; private ones get no URL at all rather than a
        // plausible-looking dead one.
        const url = PUBLIC_MEDIA_CONTAINERS.has(container) ? mediaUrlFor(container, storedPath) : '';

        if (store) {
          await recordMutationAudit(store, {
            action: 'admin_upload_completed',
            actor: auth.user,
            resource: `${container}:${storedPath}`,
            details: { container, path: storedPath, size: buffer.length, contentType: storedType },
            now,
            uuid,
            context,
          });
        }

        return json(200, { success: true, url, blobUrl, container, path: storedPath });
      } catch (error) {
        if (error?.statusCode === 409 || error?.code === 'BlobAlreadyExists') {
          return json(409, { error: 'A file already exists at that path' });
        }
        context.error('uploadFile failed:', error);
        return json(500, { error: 'Failed to upload file' });
      }
    },
  };
}
