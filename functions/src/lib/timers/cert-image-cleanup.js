/**
 * cert-image-cleanup.js — `cleanupUnusedCertImages`, daily.
 *
 * Ported from Site-Main index.js (088f458). Deletes image blobs in the
 * `certifications` container that no certification document references and
 * that are older than seven days.
 *
 * THE PREFIX IS THE WHOLE CONTAINER, FILTERED BY SEGMENT. The editor writes
 * `{docId}/images/badge-{ts}.{ext}` (CertEditor.jsx), and this listed
 * `images/` — a prefix no upload has ever had — so it examined nothing and
 * reported a clean container every night (ADR 0033, Spotlight slice). It now
 * lists everything and keeps a blob only when one of its path segments is
 * `images`, which covers today's `{docId}/images/…` and the legacy top-level
 * `images/…` the migrated references still name. Compare by blob path, never by exact URL:
 * editor uploads store tokened/variant URLs, and an exact-URL comparison
 * classified every editor-uploaded badge as unreferenced (the 2026-07-18
 * "cert images disappear" fix).
 *
 * On Azure the references can still be Firebase URLs (migrated documents
 * whose media has not been re-pointed) or blob URLs; both resolve to the same
 * blob name, `certifications/<path>` → `<path>`.
 *
 * DRY-RUN BY DEFAULT: it reports what it would delete and deletes nothing
 * until `CERT_IMAGE_CLEANUP_DELETE=true` — the T-302 rule for anything that
 * deletes blobs.
 */

import { errorFacts } from '../http/error-response.js';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CONTAINER = 'certifications';

/** Blob name inside `certifications` referenced by a URL, or null. */
export function blobNameFromUrl(url, { accountHost = null } = {}) {
  const value = String(url || '').trim();
  if (!value) return null;
  let path = null;
  // The media delivery route, `/api/public/media/certifications/<path>`,
  // relative or absolute: what the editor has stored since the port and
  // what publishSnapshot writes when it re-points a legacy badge (#868).
  // Not recognising it here would make every re-pointed badge look
  // unreferenced, and the caller DELETES on that answer.
  const media = /\/api\/public\/media\/certifications\/([^?#]+)/i.exec(value);
  if (media) {
    try {
      return media[1].split('/').map(decodeURIComponent).join('/');
    } catch {
      return media[1];
    }
  }
  const fb = /\/o\/([^?]+)/.exec(value); // firebasestorage .../o/<encodedPath>?...
  if (fb) {
    try {
      path = decodeURIComponent(fb[1]);
    } catch {
      path = fb[1];
    }
  } else {
    // Kept although the bucket is gone (#518): this derives a blob NAME for an
    // Azure cleanup, it does not fetch the Google URL. See gallery-images.js.
    //
    // `http` and case-insensitive on purpose. Returning null here does not
    // mean "not a Google URL", it means "this blob is referenced by nothing"
    // — and the caller DELETES on that answer. A scheme or host in the wrong
    // case would turn a referenced blob into an unreferenced one.
    const gcs = /^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+?)(?:\?|$)/i.exec(value);
    if (gcs) path = gcs[1];
    else {
      try {
        const u = new URL(value);
        if (
          u.hostname.endsWith('.blob.core.windows.net') &&
          (!accountHost || u.hostname === accountHost)
        ) {
          path = decodeURIComponent(u.pathname.replace(/^\//, ''));
        }
      } catch {
        return null;
      }
    }
  }
  if (!path) return null;
  return path.startsWith(`${CONTAINER}/`) ? path.slice(CONTAINER.length + 1) : path;
}

/** An editor upload (`{docId}/images/…`) or a legacy top-level `images/…` blob. */
export function isImageBlobName(name) {
  return String(name || '')
    .split('/')
    .slice(0, -1)
    .includes('images');
}

/** Every blob name a certification document references, across its image-bearing fields. */
export function collectReferencedBlobNames(docs, opts) {
  const names = new Set();
  const visit = (val) => {
    if (!val) return;
    if (typeof val === 'string') {
      const name = blobNameFromUrl(val, opts);
      if (name) names.add(name);
      return;
    }
    if (Array.isArray(val)) return val.forEach(visit);
    if (typeof val === 'object') {
      if (typeof val.ref === 'string' && val.ref.trim())
        names.add(val.ref.trim().replace(new RegExp(`^${CONTAINER}/`), ''));
      const candidate = val.downloadURL || val.downloadUrl || val.url || val.src || val.link;
      if (typeof candidate === 'string') visit(candidate);
    }
  };
  for (const data of docs || []) {
    visit(data.imageUrl);
    visit(data.image_url);
    visit(data.credentialImage);
    visit(data.image);
    visit(data.badge);
  }
  return names;
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function }} deps.store
 * @param {{ listBlobs: Function, deleteBlob: Function }} deps.storage
 * @param {Record<string,string|undefined>} [deps.env]
 */
export function createCertImageCleanup({
  store,
  storage,
  env = process.env,
  now = () => new Date(),
  log = {},
}) {
  async function run() {
    const deleteEnabled = env.CERT_IMAGE_CLEANUP_DELETE === 'true';
    const certs = await store.queryDocs(
      CONTAINER,
      'SELECT c.id, c.imageUrl, c.image_url, c.credentialImage, c.image, c.badge FROM c',
      []
    );
    const referenced = collectReferencedBlobNames(certs);
    const blobs = ((await storage.listBlobs(CONTAINER, '')) || []).filter((blob) =>
      isImageBlobName(blob.name)
    );
    const cutoff = now().getTime() - SEVEN_DAYS_MS;

    const candidates = [];
    let skipped = 0;
    for (const blob of blobs) {
      const modified = blob.lastModified ? new Date(blob.lastModified).getTime() : Number.NaN;
      if (!Number.isFinite(modified) || modified > cutoff || referenced.has(blob.name)) {
        skipped += 1;
        continue;
      }
      candidates.push(blob.name);
    }

    let deleted = 0;
    if (deleteEnabled) {
      for (const name of candidates) {
        try {
          await storage.deleteBlob(CONTAINER, name);
          deleted += 1;
          log.log?.(`[cleanupUnusedCertImages] Deleted unreferenced cert image: ${name}`);
        } catch (err) {
          log.error?.(`[cleanupUnusedCertImages] Failed to delete ${name}: ${errorFacts(err)}`);
        }
      }
    }
    log.log?.(
      `[cleanupUnusedCertImages] ${deleteEnabled ? 'deleted' : 'DRY RUN — would delete'} ${deleteEnabled ? deleted : candidates.length}, skipped (recent or referenced) ${skipped}, referenced ${referenced.size}`
    );
    return {
      dryRun: !deleteEnabled,
      examined: blobs.length,
      referenced: referenced.size,
      candidates: candidates.length,
      deleted,
      skipped,
    };
  }
  return { run };
}
