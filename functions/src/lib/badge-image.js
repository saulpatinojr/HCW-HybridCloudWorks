/**
 * badge-image.js — one shape for every certification badge.
 *
 * The Certifications editor accepted "PNG / JPG / SVG" on its Settings tab
 * while the upload route refused SVG into `certifications` (a publicly served
 * container, where an SVG is a scriptable document — admin-uploads.js), and a
 * PNG went in at whatever size the issuer shipped: a 2,000 px Credly export
 * beside a 96 px favicon-sized badge on the same About page row. Owner
 * request 2026-10-05: accept PNG or SVG, and normalise them.
 *
 * So a badge is decoded here and re-encoded as the one thing the page wants:
 * a {@link BADGE_SIZE}-pixel square PNG with a transparent canvas, the image
 * contained inside it (never cropped, never stretched), EXIF rotation
 * applied, metadata dropped. An SVG is rasterised onto that canvas and the
 * stored object is the PNG — nothing scriptable is ever written, which is
 * what lets the route accept the type it used to refuse.
 *
 * sharp (libvips) does the work; it is imported lazily so loading this
 * module costs nothing on code paths that never upload. A buffer libvips
 * cannot decode (a file renamed to .png, a truncated download, an SVG with
 * no size) is answered with `{ error }` and the route turns it into a 415,
 * which is the honest answer to "this is not a badge".
 */

import { errorCode } from './http/error-response.js';

/** Square edge of every stored badge, in pixels. */
export const BADGE_SIZE = 512;

/** Density used to rasterise vector input, so a 24 px SVG does not come out blurred. */
const SVG_DENSITY = 300;

const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, alpha: 0 });

/** Declared types this module can decode (the upload allowlist minus nothing: all are raster or SVG). */
export const BADGE_INPUT_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
]);

let sharpModule = null;
async function loadSharp() {
  if (!sharpModule) sharpModule = (await import('sharp')).default;
  return sharpModule;
}

/**
 * Decode `buffer` (declared as `contentType`) and return it as a
 * BADGE_SIZE × BADGE_SIZE transparent PNG.
 *
 * @param {Buffer} buffer
 * @param {{ contentType: string, sharp?: Function }} options `sharp` is injectable for tests.
 * @returns {Promise<{ buffer: Buffer, contentType: 'image/png', extension: 'png', width: number, height: number } | { error: string }>}
 */
export async function normalizeBadgeImage(buffer, { contentType, sharp = null } = {}) {
  if (!BADGE_INPUT_TYPES.includes(contentType)) {
    return { error: `Cannot normalise a badge declared as ${contentType || 'nothing'}` };
  }
  const lib = sharp || (await loadSharp());
  try {
    const input = contentType === 'image/svg+xml' ? { density: SVG_DENSITY } : {};
    const out = await lib(buffer, { ...input, animated: false })
      .rotate()
      .resize(BADGE_SIZE, BADGE_SIZE, { fit: 'contain', background: TRANSPARENT })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { buffer: out, contentType: 'image/png', extension: 'png', width: BADGE_SIZE, height: BADGE_SIZE };
  } catch (cause) {
    // The decoder's own words stay out of the 415 (#945); its code says which failure.
    return { error: `Not a decodable image (${errorCode(cause)}).` };
  }
}

/** `a/b/badge-1.svg` → `a/b/badge-1.png`; a path with no extension gains one. */
export function withExtension(path, extension) {
  const segments = String(path).split('/');
  const last = segments.pop() || '';
  const dot = last.lastIndexOf('.');
  const stem = dot > 0 ? last.slice(0, dot) : last;
  segments.push(`${stem}.${extension}`);
  return segments.join('/');
}
