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

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {{ uploadBlob: Function }} deps.storage - uploadBlob(container, blobName, content, contentType, metadata)
 * @param {(url: string) => Promise<{buffer?: Buffer, contentType: string, refused?: string, reason?: string}>} [deps.fetchImage]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 */
export function createImageMirror({ store, storage, fetchImage = defaultFetchImage, log = {} }) {
  /**
   * Mirror one document's URL field if it is a new external URL. Swallows
   * errors (logged): the marker is written only after success, so the next
   * write retries.
   * @returns {Promise<{ mirrored: boolean, reason: string }>}
   */
  async function mirror(container, doc) {
    const spec = MIRRORS[container];
    const newUrl = doc?.[spec.urlField];
    if (!isExternalUrlString(newUrl)) return { mirrored: false, reason: 'not_external_url' };
    const decision = await shouldProcessValue({
      value: newUrl,
      snapshotMarker: doc[spec.markerField],
      readLiveMarker: async () =>
        (await store.readDoc(container, doc.id, doc.id))?.[spec.markerField],
    });
    if (!decision.process) return { mirrored: false, reason: decision.reason };

    try {
      log.log?.(`[${spec.tag}] Downloading for ${container}/${doc.id}`);
      const fetched = await fetchImage(newUrl);
      // Not an image, so not a mirror (#415). The marker is deliberately not
      // written: an editor who replaces the video with a picture gets it
      // mirrored on the next write, exactly as after a fetch failure.
      if (fetched.refused) {
        log.warn?.(`[${spec.tag}] Refused ${container}/${doc.id}: ${fetched.reason}`);
        return { mirrored: false, reason: `refused: ${fetched.refused}` };
      }
      const { buffer, contentType } = fetched;
      const ext = requireImageExtension(contentType);
      const blobPath = `${doc.id}/images/${spec.blobName}.${ext}`;
      await storage.uploadBlob(container, blobPath, buffer, contentType, { sourceUrl: newUrl });
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
      log.log?.(`[${spec.tag}] Stored ${container}/${blobPath}`);
      return { mirrored: true, reason: 'mirrored' };
    } catch (err) {
      log.error?.(`[${spec.tag}] Failed for ${container}/${doc.id}: ${errorFacts(err)}`);
      return { mirrored: false, reason: `error: ${errorCode(err)}` };
    }
  }

  /**
   * Generate the branded template cover for a blog with a title but no image
   * source and no cover. Decides from current state alone.
   * @returns {Promise<{ generated: boolean, reason: string }>}
   */
  async function generateTemplateCover(doc) {
    const title = doc?.Title || doc?.title;
    if (!title) return { generated: false, reason: 'no_title' };
    if (doc.contentImageUrl && String(doc.contentImageUrl).startsWith('http'))
      return { generated: false, reason: 'has_content_image_url' };
    const cover = doc['Cover Image'];
    if (Array.isArray(cover) && cover.length > 0) return { generated: false, reason: 'has_cover' };
    if (cover && typeof cover === 'object' && cover.downloadURL)
      return { generated: false, reason: 'has_cover' };
    if (doc.generatedCover === true) return { generated: false, reason: 'already_generated' };

    try {
      const svg = buildCoverSvg(doc['Cloud Provider'] || 'Azure', title, doc.category || 'Update');
      const blobPath = `${doc.id}/images/generated-cover.svg`;
      const buffer = Buffer.from(svg, 'utf8');
      await storage.uploadBlob('blogs', blobPath, buffer, 'image/svg+xml', {
        sourceUrl: 'generated',
      });
      const field = rowyImageField({
        downloadURL: mediaUrlFor('blogs', blobPath),
        blobPath,
        contentType: 'image/svg+xml',
        size: buffer.length,
      });
      await store.patchDoc('blogs', doc.id, { 'Cover Image': field, generatedCover: true });
      log.log?.(`[generateCover] Generated template cover for blog ${doc.id}`);
      return { generated: true, reason: 'generated' };
    } catch (err) {
      log.error?.(`[generateCover] Failed for blog ${doc.id}: ${errorFacts(err)}`);
      return { generated: false, reason: `error: ${errorCode(err)}` };
    }
  }

  return { mirror, generateTemplateCover };
}
