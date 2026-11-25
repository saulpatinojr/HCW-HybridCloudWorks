/**
 * image-mirror.js — the three "download the external image into our storage"
 * triggers and the template-cover generator, as one factory.
 *
 * Ported from Site-Main `downloadSpeakerEventImage`, `downloadCertBadgeImage`,
 * `downloadBlogCoverImage`, `generateBlogCoverImage` (index.js, 088f458).
 * Each mirrors a URL field into a blob and writes the Rowy-shaped image array
 * the frontend reads first, plus the value marker that stops the next
 * delivery. The blob path keeps the upstream scheme
 * (`{docId}/images/<name>.<ext>` inside the collection's own container).
 *
 * `downloadURL` is the site-relative media route for the public containers
 * (blogs, certifications — blob-paths.js mediaUrlFor). `speakerevents` is
 * declared private in Terraform ("event assets served via API"), so its
 * mirror keeps the blob as the archive copy and leaves `downloadURL` on the
 * source URL the page already shows — making that container public is a
 * disclosure decision, not a trigger's.
 */
import { PUBLIC_MEDIA_CONTAINERS, mediaUrlFor } from '../blob-paths.js';
import {
  isExternalUrlString,
  requireImageExtension,
  fetchImage as defaultFetchImage,
} from './fetch-image.js';
import { shouldProcessValue } from './value-marker.js';
import { buildCoverSvg } from './cover-svg.js';
import { errorFacts, errorCode } from '../http/error-response.js';

export const MIRRORS = Object.freeze({
  speakerevents: {
    urlField: 'eventImageUrl',
    markerField: 'eventImageSourceUrl',
    targetField: 'images',
    blobName: 'event-image',
    tag: 'speakerEventImage',
  },
  certifications: {
    urlField: 'imageUrl',
    markerField: 'imageSourceUrl',
    targetField: 'image',
    blobName: 'badge-image',
    tag: 'certBadgeImage',
  },
  blogs: {
    urlField: 'contentImageUrl',
    markerField: 'contentImageSourceUrl',
    targetField: 'Cover Image',
    blobName: 'cover',
    tag: 'blogCoverImage',
  },
});

/** The Rowy-compatible image array entry. */
export function rowyImageField({ downloadURL, blobPath, contentType, size }) {
  return [{ downloadURL, name: blobPath.split('/').pop(), type: contentType, size, ref: blobPath }];
}

export function downloadUrlFor(container, blobPath, sourceUrl) {
  return PUBLIC_MEDIA_CONTAINERS.has(container) ? mediaUrlFor(container, blobPath) : sourceUrl;
}

/** Fetch the image and store it with its marker. The result `mirror` reports. */
async function storeMirror({ store, storage, fetchImage, log }, container, doc, newUrl) {
  const spec = MIRRORS[container];
  log.log?.(`[${spec.tag}] Downloading for a ${container} document`);
  const fetched = await fetchImage(newUrl);
  // Not an image, so not a mirror (#415). The marker is deliberately not
  // written: an editor who replaces the video with a picture gets it
  // mirrored on the next write, exactly as after a fetch failure.
  if (fetched.refused) {
    // The refusal's code, not its sentence: the sentence quotes the
    // remote server's Content-Type, which is text the far end chose (#1802).
    log.warn?.(`[${spec.tag}] Refused for a ${container} document: ${fetched.refused}`);
    return { mirrored: false, reason: `refused: ${fetched.refused}` };
  }
  const { buffer, contentType } = fetched;
  const ext = requireImageExtension(contentType);
  const blobPath = `${doc.id}/images/${spec.blobName}.${ext}`;
  await storage.uploadBlob(container, blobPath, buffer, contentType, { metadata: { sourceUrl: newUrl } });
  const field = rowyImageField({
    downloadURL: downloadUrlFor(container, blobPath, newUrl),
    blobPath,
    contentType,
    size: buffer.length,
  });
  // Marker written in the same patch, after the upload succeeded.
  await store.patchDoc(container, doc.id, {
    [spec.targetField]: field,
    [spec.markerField]: newUrl,
  });
  log.log?.(`[${spec.tag}] Stored an image for a ${container} document`);
  return { mirrored: true, reason: 'mirrored' };
}

/**
 * Mirror one document's URL field if it is a new external URL. Swallows
 * errors (logged): the marker is written only after success, so the next
 * write retries.
 * @returns {Promise<{ mirrored: boolean, reason: string }>}
 */
async function mirror(d, container, doc) {
  const spec = MIRRORS[container];
  const newUrl = doc?.[spec.urlField];
  if (!isExternalUrlString(newUrl)) return { mirrored: false, reason: 'not_external_url' };
  const decision = await shouldProcessValue({
    value: newUrl,
    snapshotMarker: doc[spec.markerField],
    readLiveMarker: async () =>
      (await d.store.readDoc(container, doc.id, doc.id))?.[spec.markerField],
  });
  if (!decision.process) return { mirrored: false, reason: decision.reason };

  try {
    return await storeMirror(d, container, doc, newUrl);
  } catch (err) {
    d.log.error?.(`[${spec.tag}] Failed for a ${container} document: ${errorFacts(err)}`);
    return { mirrored: false, reason: `error: ${errorCode(err)}` };
  }
}

/** Whether a blog already has a cover: a non-empty image array, or an image object with an address. */
function hasCover(cover) {
  if (Array.isArray(cover)) return cover.length > 0;
  return Boolean(cover && typeof cover === 'object' && cover.downloadURL);
}

/** Why a blog with a title gets no template cover, or null when it should get one. */
function coverSkipReason(doc) {
  if (doc.contentImageUrl && String(doc.contentImageUrl).startsWith('http')) return 'has_content_image_url';
  if (hasCover(doc['Cover Image'])) return 'has_cover';
  if (doc.generatedCover === true) return 'already_generated';
  return null;
}

/** Build, upload and record the branded cover. */
async function storeTemplateCover({ store, storage, log }, doc, title) {
  const svg = buildCoverSvg(doc['Cloud Provider'] || 'Azure', title, doc.category || 'Update');
  const blobPath = `${doc.id}/images/generated-cover.svg`;
  const buffer = Buffer.from(svg, 'utf8');
  await storage.uploadBlob('blogs', blobPath, buffer, 'image/svg+xml', {
    metadata: { sourceUrl: 'generated' },
  });
  const field = rowyImageField({
    downloadURL: mediaUrlFor('blogs', blobPath),
    blobPath,
    contentType: 'image/svg+xml',
    size: buffer.length,
  });
  await store.patchDoc('blogs', doc.id, { 'Cover Image': field, generatedCover: true });
  log.log?.('[generateCover] Generated a template cover for a blog');
}

/**
 * Generate the branded template cover for a blog with a title but no image
 * source and no cover. Decides from current state alone.
 * @returns {Promise<{ generated: boolean, reason: string }>}
 */
async function generateTemplateCover(d, doc) {
  const title = doc?.Title || doc?.title;
  if (!title) return { generated: false, reason: 'no_title' };
  const skip = coverSkipReason(doc);
  if (skip) return { generated: false, reason: skip };
  try {
    await storeTemplateCover(d, doc, title);
    return { generated: true, reason: 'generated' };
  } catch (err) {
    d.log.error?.(`[generateCover] Failed for a blog: ${errorFacts(err)}`);
    return { generated: false, reason: `error: ${errorCode(err)}` };
  }
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {{ uploadBlob: Function }} deps.storage - uploadBlob(container, blobName, content, contentType, { metadata })
 * @param {(url: string) => Promise<{buffer?: Buffer, contentType: string, refused?: string, reason?: string}>} [deps.fetchImage]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 */
export function createImageMirror({ store, storage, fetchImage = defaultFetchImage, log = {} }) {
  const d = { store, storage, fetchImage, log };
  return {
    mirror: (container, doc) => mirror(d, container, doc),
    generateTemplateCover: (doc) => generateTemplateCover(d, doc),
  };
}
