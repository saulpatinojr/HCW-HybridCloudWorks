/**
 * The browser half of the admin upload route, `POST cms/uploads/{container}`
 * (functions/src/lib/admin-uploads.js).
 *
 * The same FileReader → base64 → postJSON sequence was written inline in three
 * pages. It lives here so a fourth caller (the Linkie Hub's post image, #501)
 * does not make it four, and so the limits the server enforces are stated once
 * on this side too.
 *
 * Client-side validation is UX, not enforcement: the route checks size, type
 * and extension again, and is the authority. What this adds is a clear message
 * before a 15 MB body is base64-encoded and sent only to be refused.
 *
 * ADR 0033 added the two measurements the gallery records on upload — pixel
 * dimensions and a sha256 for duplicate detection — both best-effort: a
 * browser without `crypto.subtle` or an image that will not decode yields
 * null, never a failed upload.
 */
import { postJSON } from '@/lib/api';

/** The route's decoded-byte cap (`MAX_UPLOAD_BYTES` in admin-uploads.js). */
export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Types a PUBLICLY SERVED container accepts, each with the extension written
 * into the blob path. The route requires the path's extension to agree with
 * the declared type, so the extension is derived from the type rather than
 * trusted from the filename (`photo.jfif` declared as `image/jpeg` would
 * otherwise be refused with a 415).
 *
 * SVG is absent on purpose: `PUBLIC_DENIED_MEDIA_TYPES` refuses it in every
 * public container, because served anonymously it is a scriptable document.
 */
export const PUBLIC_IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
});

/**
 * Why a file cannot go to a public image container, or '' when it can.
 *
 * @param {{ type?: string, size?: number } | null | undefined} file
 * @returns {string}
 */
export function publicImageFileProblem(file) {
  if (!file) return 'No file selected';
  const type = String(file.type || '').toLowerCase();
  if (!PUBLIC_IMAGE_EXTENSIONS[type]) {
    return 'Choose a PNG, JPEG, WebP, GIF or AVIF image';
  }
  if (Number(file.size) > MAX_IMAGE_UPLOAD_BYTES) return 'Images must be 15 MB or smaller';
  return '';
}

/**
 * A file's contents as bare base64 — the data URL with its `data:…;base64,`
 * prefix removed, which is what the route's `dataBase64` expects.
 *
 * @param {Blob} file
 * @returns {Promise<string>}
 */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * The extension to write into a blob path for a file, derived from its
 * DECLARED TYPE rather than from its name.
 *
 * The upload route requires the path's extension to agree with the content
 * type it is sent (`checkUploadMediaType`), so trusting the filename turns a
 * perfectly valid file into a 415: Windows writes `.jfif` for JPEGs saved from
 * a browser, and a PNG that someone named `.jpg` is refused the same way.
 * (#631)
 *
 * @param {{type?: string} | null | undefined} file
 * @returns {string} e.g. `jpg`; '' for a type this route does not accept
 */
export function imageExtensionFor(file) {
  return PUBLIC_IMAGE_EXTENSIONS[String(file?.type || '').toLowerCase()] || '';
}

/**
 * The pixel size of an image file, decoded by the browser through
 * `createImageBitmap`, or null when it cannot be (no decoder in this
 * environment, an unsupported or corrupt file). Resolves at once where the
 * API is missing — jsdom has an `Image` that never loads, and waiting on it
 * would hold every upload for the timeout.
 *
 * @param {Blob} file
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export async function readImageDimensions(file) {
  if (!file || typeof globalThis.createImageBitmap !== 'function') return null;
  try {
    const bitmap = await globalThis.createImageBitmap(file);
    const size =
      bitmap.width > 0 && bitmap.height > 0 ? { width: bitmap.width, height: bitmap.height } : null;
    bitmap.close?.();
    return size;
  } catch {
    return null;
  }
}

/** The type a photo is redrawn as; an animated or AVIF original becomes a still PNG or JPEG. */
const REDRAWN_TYPE = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/gif': 'image/png',
  'image/avif': 'image/jpeg',
});

/**
 * A copy of a photo with nothing but its pixels: redrawn onto a canvas and
 * encoded again, so the camera's metadata (EXIF location, device, time) is
 * not carried into a public container. Refuses rather than sending the
 * original when the browser cannot redraw it.
 *
 * @param {File} file
 * @returns {Promise<File>}
 */
export async function stripImageMetadata(file) {
  const refuse = () =>
    new Error('This browser could not prepare the photo. Try a JPEG or PNG, or another browser.');
  const wanted = REDRAWN_TYPE[String(file?.type || '').toLowerCase()];
  const Canvas = globalThis.OffscreenCanvas;
  if (
    !wanted ||
    typeof globalThis.createImageBitmap !== 'function' ||
    typeof Canvas !== 'function'
  ) {
    throw refuse();
  }
  let bitmap;
  try {
    // 'from-image' keeps a phone photo upright once its orientation tag is gone.
    bitmap = await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = new Canvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: wanted, quality: 0.92 });
    const type = PUBLIC_IMAGE_EXTENSIONS[blob.type] ? blob.type : '';
    if (!type) throw refuse();
    const base = String(file.name || 'photo').replace(/\.[^.]*$/, '');
    return new File([blob], `${base}.${PUBLIC_IMAGE_EXTENSIONS[type]}`, { type });
  } catch (error) {
    throw error?.message === refuse().message ? error : refuse();
  } finally {
    bitmap?.close?.();
  }
}

/**
 * Hex sha256 of a file's bytes through WebCrypto, or '' where it is
 * unavailable. The server records it on the row and marks later uploads of
 * the same bytes as duplicates.
 *
 * @param {Blob} file
 * @returns {Promise<string>}
 */
export async function sha256HexOf(file) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || !file || typeof file.arrayBuffer !== 'function') return '';
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

/**
 * Upload one file to an admin upload container.
 *
 * The response's `url` is SITE-RELATIVE (`/api/public/media/{container}/…`)
 * for a public container and EMPTY for a private one (`content`,
 * `speakerevents`) — the route returns no URL rather than a dead one. A caller
 * that needs something a browser or a third party can fetch has to upload to
 * a public container and resolve the path; see `resolveMediaUrl`.
 *
 * @param {{ container: string, path: string, file: Blob & { type?: string } }} args
 * @returns {Promise<{ url?: string, blobUrl?: string, container?: string, path?: string }>}
 */
export async function uploadImageFile({ container, path, file }) {
  const dataBase64 = await readFileAsBase64(file);
  return postJSON(`cms/uploads/${container}`, {
    path,
    contentType: file.type || 'image/png',
    dataBase64,
  });
}
