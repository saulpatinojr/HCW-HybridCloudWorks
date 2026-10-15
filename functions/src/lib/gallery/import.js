/**
 * Import-from-URL: the refusals, the guarded fetch, the duplicate probe, the
 * blob path and the record an import creates (PR #841 split of
 * gallery-images.js).
 */
import { mediaUrlFor } from '../blob-paths.js';
import { measureImage } from './measure.js';
import { LICENSES } from './metadata.js';
import { cleanFolder, cleanTagList, lower, refuse } from './shared.js';
import { authoredMessage, errorCode } from '../http/error-response.js';

/** Why an import cannot start: a non-http(s) URL, or a route with no upload. */
export function importRefusal(url, storage) {
  if (!/^https?:\/\//i.test(url)) return refuse(400, 'url must be http(s)');
  if (typeof storage?.uploadBlob !== 'function') {
    return refuse(503, 'Blob upload is not configured on this route');
  }
  return null;
}

/** The guarded fetch, with a thrown error as 422 and a refusal as 415. */
export async function fetchForImport(fetchImage, url) {
  let fetched;
  try {
    fetched = await fetchImage(url);
  } catch (error) {
    // The guard's own refusal (authored) or the failure's code; a socket's
    // sentence never reaches the 422 (#945). The URL is still masked.
    const reason = authoredMessage(error, `the request failed (${errorCode(error?.cause ?? error)})`).replace(
      url,
      '[url]'
    );
    return refuse(422, `Could not fetch image: ${reason}`);
  }
  if (fetched.refused) return refuse(415, fetched.reason);
  return { ok: true, buffer: fetched.buffer, contentType: fetched.contentType };
}

/** The gallery row already holding these bytes or this source URL, or null. */
export async function findImportDuplicate(store, { sha, source }) {
  if (typeof store.queryDocs !== 'function') return null;
  const dupes = await store
    .queryDocs(
      'generated_content_images',
      'SELECT TOP 1 c.id, c.imageUrl, c.title FROM c WHERE c.sha256 = @sha OR c.sourceUrl = @url',
      [
        { name: '@sha', value: sha },
        { name: '@url', value: source },
      ]
    )
    .catch(() => []);
  return dupes?.length ? dupes[0] : null;
}

/** The URL's last path segment without its extension, or ''. */
export function importFileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(
      /\.[^.]+$/,
      ''
    );
  } catch {
    return '';
  }
}

/** `image-gallery/imports/{stamp}-{slug}.{ext}` under the covers container. */
export function importBlobPath(title, ext, nowIso) {
  const stamp = nowIso
    .replace(/[-:TZ]/g, '')
    .replace(/\..*$/, '')
    .slice(0, 14);
  const slug =
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'import';
  return `image-gallery/imports/${stamp}-${slug}.${ext}`;
}

/** The gallery record an import creates. */
export function importedImageDoc({
  id,
  body,
  url,
  source,
  title,
  blobPath,
  buffer,
  contentType,
  ext,
  sha,
  nowIso,
  who,
}) {
  const measured = measureImage(buffer, contentType);
  const license = String(body.license || '').toLowerCase();
  return {
    id,
    articleId: 'import',
    contentId: '',
    imageUrl: mediaUrlFor('covers', blobPath),
    title,
    altText: String(body.altText || '').trim() || title,
    caption: String(body.caption || '').trim(),
    license: LICENSES.includes(license) ? license : 'other',
    credit: String(body.credit || '').trim() || new URL(url).hostname,
    provider: lower(body.provider),
    slot: String(body.slot || '').trim(),
    customTags: cleanTagList(body.tags ?? body.customTags),
    folder: cleanFolder(body.folder),
    archived: false,
    archivedAt: null,
    softDeletedAt: null,
    approvalStatus: 'approved',
    sourceCollection: 'import',
    sourceUrl: source,
    storagePath: `covers/${blobPath}`,
    bytes: buffer.length,
    format: ext,
    width: measured?.width ?? null,
    height: measured?.height ?? null,
    sha256: sha,
    promptSet: '',
    promptSetId: '',
    promptName: '',
    promptTemplateVersion: '',
    usageCount: 0,
    usedByContentIds: [],
    createdAt: nowIso,
    createdBy: who,
    updatedAt: nowIso,
    updatedBy: who,
  };
}
