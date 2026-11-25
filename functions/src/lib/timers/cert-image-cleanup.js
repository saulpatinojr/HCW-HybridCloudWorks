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

/**
 * The media delivery route, `/api/public/media/certifications/<path>`,
 * relative or absolute: what the editor has stored since the port and
 * what publishSnapshot writes when it re-points a legacy badge (#868).
 * Not recognising it here would make every re-pointed badge look
 * unreferenced, and the caller DELETES on that answer.
 */
const MEDIA_ROUTE = /\/api\/public\/media\/certifications\/([^?#]+)/i;
/** firebasestorage .../o/<encodedPath>?... */
const FIREBASE_OBJECT = /\/o\/([^?]+)/;
/**
 * Kept although the bucket is gone (#518): this derives a blob NAME for an
 * Azure cleanup, it does not fetch the Google URL. See gallery-images.js.
 *
 * `http` and case-insensitive on purpose. Returning null here does not
 * mean "not a Google URL", it means "this blob is referenced by nothing"
 * — and the caller DELETES on that answer. A scheme or host in the wrong
 * case would turn a referenced blob into an unreferenced one.
 */
const GCS_OBJECT = /^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+?)(?:\?|$)/i;

/** The blob name in a media route address, segment by segment decoded; null when it is not one. */
function mediaRouteName(value) {
  const media = MEDIA_ROUTE.exec(value);
  if (!media) return null;
  try {
    return media[1].split('/').map(decodeURIComponent).join('/');
  } catch {
    return media[1];
  }
}

/** The path in an Azure blob address on this account (any account when none is named); null otherwise. */
function azureBlobPath(value, accountHost) {
  try {
    const u = new URL(value);
    const ours = u.hostname.endsWith('.blob.core.windows.net') && (!accountHost || u.hostname === accountHost);
    return ours ? decodeURIComponent(u.pathname.replace(/^\//, '')) : null;
  } catch {
    return null;
  }
}

/** The storage path a Firebase, Google Cloud Storage or Azure blob address names, or null. */
function storagePath(value, accountHost) {
  const fb = FIREBASE_OBJECT.exec(value);
  if (fb) {
    try {
      return decodeURIComponent(fb[1]);
    } catch {
      return fb[1];
    }
  }
  const gcs = GCS_OBJECT.exec(value);
  if (gcs) return gcs[1];
  return azureBlobPath(value, accountHost);
}

/** Blob name inside `certifications` referenced by a URL, or null. */
export function blobNameFromUrl(url, { accountHost = null } = {}) {
  const value = String(url || '').trim();
  if (!value) return null;
  const media = mediaRouteName(value);
  if (media !== null) return media;
  const path = storagePath(value, accountHost);
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

/** The fields of an image object that may hold its address, first found wins. */
const ADDRESS_FIELDS = ['downloadURL', 'downloadUrl', 'url', 'src', 'link'];

/** Add every blob name one value references: a URL, a list of values, or an image object. */
function visitImageValue(names, val, opts) {
  if (!val) return;
  if (typeof val === 'string') {
    const name = blobNameFromUrl(val, opts);
    if (name) names.add(name);
    return;
  }
  if (Array.isArray(val)) {
    val.forEach((item) => visitImageValue(names, item, opts));
    return;
  }
  if (typeof val !== 'object') return;
  if (typeof val.ref === 'string' && val.ref.trim()) names.add(val.ref.trim().replace(new RegExp(`^${CONTAINER}/`), ''));
  const candidate = ADDRESS_FIELDS.map((field) => val[field]).find(Boolean);
  if (typeof candidate === 'string') visitImageValue(names, candidate, opts);
}

/** Every blob name a certification document references, across its image-bearing fields. */
export function collectReferencedBlobNames(docs, opts) {
  const names = new Set();
  for (const data of docs || []) {
    visitImageValue(names, data.imageUrl, opts);
    visitImageValue(names, data.image_url, opts);
    visitImageValue(names, data.credentialImage, opts);
    visitImageValue(names, data.image, opts);
    visitImageValue(names, data.badge, opts);
  }
  return names;
}

/** The blobs old enough and referenced by nothing, and how many were kept. */
function pickCandidates(blobs, referenced, cutoff) {
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
  return { candidates, skipped };
}

/** Delete each candidate; one that fails is logged and the rest go on. Returns how many went. */
async function deleteCandidates(storage, log, candidates) {
  let deleted = 0;
  for (const name of candidates) {
    try {
      await storage.deleteBlob(CONTAINER, name);
      deleted += 1;
      log.log?.('[cleanupUnusedCertImages] Deleted an unreferenced cert image');
    } catch (err) {
      log.error?.(`[cleanupUnusedCertImages] Failed to delete a cert image: ${errorFacts(err)}`);
    }
  }
  return deleted;
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
    const { candidates, skipped } = pickCandidates(blobs, referenced, cutoff);
    const deleted = deleteEnabled ? await deleteCandidates(storage, log, candidates) : 0;
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
