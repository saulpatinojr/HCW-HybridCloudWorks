/**
 * publishSnapshot RPC — writes the public `_snapshots/{collection}` documents
 * the About page and speaking-events widget read. Ported from Site-Main
 * lib/snapshots.js + index.js :5431.
 *
 * The certification sanitizer is the security boundary here: only
 * display:true certs, only the whitelisted fields — the snapshot path must
 * never leak more than the build-time static JSON does (hidden certs,
 * descriptions, learn URLs, _updatedAt). Carried verbatim, including the
 * GeoPoint flattening fix (private {_latitude,_longitude} keys crashed the
 * About page renderer).
 */
const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

import { errorResponse } from './http/error-response.js';
import { legacyBadgePath, legacyBadgePathsOf, repointAll } from './legacy-badge-url.js';

export function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (
    typeof value === 'object' &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
  ) {
    return { latitude: value.latitude, longitude: value.longitude };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

function getFirst(data, keys) {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  return undefined;
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null)
  );
}

function sanitizeImageValue(value) {
  if (!value) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sanitizeImageValue).filter(Boolean);
  if (typeof value === 'object') {
    return compactObject({
      downloadURL: getFirst(value, ['downloadURL', 'downloadUrl']),
      url: value.url,
      src: value.src,
      link: value.link,
    });
  }
  return undefined;
}

/**
 * The plain badge URL the snapshot carries. The editor writes `imageUrl`
 * (CertEditor.jsx) and the migrated rows carry `credentialImage`; the first
 * that is not a dead legacy reference wins, the editor's field first, so a
 * badge re-uploaded over a migrated row reaches the page (#870 review).
 * With every candidate legacy, the first defined is kept as before: the
 * page skips it and shows the placeholder.
 */
const BADGE_URL_FIELDS = ['imageUrl', 'ImageUrl', 'image_url', 'credentialImage', 'CredentialImage'];
function publishedBadgeUrl(doc) {
  const values = BADGE_URL_FIELDS.map((key) => doc[key]).filter(
    (value) => value !== undefined && value !== null && value !== ''
  );
  return values.find((value) => legacyBadgePath(value) === null) ?? values[0];
}

export function sanitizeCertification(doc) {
  if (getFirst(doc, ['display', 'Display']) !== true) return null;

  return compactObject({
    id: doc.id,
    name: getFirst(doc, ['name', 'Name']),
    Name: doc.Name,
    issuer: getFirst(doc, ['issuer', 'Issuer']),
    Issuer: doc.Issuer,
    issueDate: getFirst(doc, ['issueDate', 'issue_date', 'IssueDate']),
    expDate: getFirst(doc, ['expDate', 'exp_date', 'ExpDate']),
    certState: getFirst(doc, ['certState', 'isValid', 'is_valid', 'cert_state']),
    code: getFirst(doc, ['code', 'Code']),
    verifyUrl: getFirst(doc, ['verifyUrl', 'verify_url', 'VerifyUrl']),
    image: sanitizeImageValue(getFirst(doc, ['image', 'Image', 'badge', 'Badge'])),
    credentialImage: sanitizeImageValue(publishedBadgeUrl(doc)),
    displayOrder: getFirst(doc, ['displayOrder', 'display_order', 'DisplayOrder']),
    tags: getFirst(doc, ['tags', 'Tags']),
    // "Feature in Spotlight" had no public effect because this list dropped
    // it (ADR 0033 §1); the About page now leads with featured certs.
    featured: getFirst(doc, ['featured', 'Featured']) === true ? true : undefined,
    display: true,
  });
}

/**
 * The speaker-events equivalent, and the reason it now exists.
 *
 * `SANITIZERS` had a `certifications` entry and no `speakerevents` one, so raw
 * rows were written wholesale into `_snapshots/speakerevents` and served
 * anonymously by `GET public/snapshots/speakerevents` (T-201). Two
 * things leaked:
 *
 *  - **Every admin's email address.** `upsertSpeakerEvent` stamps `createdBy`
 *    and `updatedBy` with `actor(user)`, which resolves to the admin's email.
 *    Both names are in `INTERNAL_FIELDS`, but `stripInternalFields` operates on
 *    the snapshot wrapper and never descends into `items[]`, so it never
 *    reached them.
 *  - **Hidden events.** `display: false` was filtered only client-side, in
 *    `CustomSessionizeWidget.jsx:451`, which is not a filter at all for anyone
 *    reading the endpoint directly.
 *
 * The allowlist below is positive, not a denylist, and that is the point:
 * `upsertSpeakerEvent` has no field allowlist on the write side, so anything an
 * editor adds to a document would otherwise become public the next time
 * snapshots are published. Only the fields the widget actually renders are
 * listed — derived from `mergeWithFirestore` and the manual-entry path in
 * `CustomSessionizeWidget.jsx`.
 *
 * Adding a field here publishes it to anonymous callers. That should be a
 * deliberate act, which is why the list is enumerated rather than computed.
 */
export function sanitizeSpeakerEvent(doc) {
  const sessionizeId = getFirst(doc, ['sessionizeId', 'sessionize_id', 'eventId']);
  const display = getFirst(doc, ['display', 'Display']);

  // A Sessionize-backed row the editor has unticked publishes a TOMBSTONE —
  // its join key and `display: false` and nothing else — so the public widget
  // can hide the event Sessionize still lists (ADR 0033, Spotlight slice).
  // Before this the widget rendered the Sessionize entry regardless, because
  // the row it would have matched had been dropped from the snapshot.
  if (display === false && sessionizeId !== undefined) {
    return { id: doc.id, sessionizeId, display: false };
  }

  // Not `!== false`: a document with no `display` field is not published.
  // Failing closed matters more than showing an event whose author forgot the
  // flag, and it matches how sanitizeCertification treats the same field.
  if (display !== true) return null;

  return compactObject({
    id: doc.id,
    name: getFirst(doc, ['name', 'Name', 'title', 'Title']),
    date: getFirst(doc, ['date', 'Date']),
    location: getFirst(doc, ['location', 'Location']),
    location_coords: serializeValue(getFirst(doc, ['location_coords', 'locationCoords'])),
    description: getFirst(doc, ['description', 'Description']),
    eventUrl: getFirst(doc, ['eventUrl', 'event_url', 'website', 'Website']),
    presentationUrl: getFirst(doc, ['presentationUrl', 'presentation_url']),
    image: sanitizeImageValue(getFirst(doc, ['image', 'Image'])),
    eventImageUrl: sanitizeImageValue(getFirst(doc, ['eventImageUrl', 'event_image_url'])),
    // The image-mirror trigger's copies (private blob, served through the
    // media route). Written server-side only — upsertSpeakerEvent's allowlist
    // refuses the key — so a mirrored image is always one the trigger made.
    images: sanitizeImageValue(getFirst(doc, ['images', 'Images'])),
    // The hub's status and sessions (ADR 0033 §4): a delivered session's
    // slides and recording are what the public page links.
    status: getFirst(doc, ['status']),
    sessions: sanitizeSessions(getFirst(doc, ['sessions'])),
    // The join key the widget matches Sessionize entries on. Not sensitive —
    // Sessionize ids are public — and omitting it would break the merge.
    sessionizeId,
    display: true,
  });
}

function sanitizeSessions(value) {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((s) => s && typeof s === 'object')
    .map((s) =>
      compactObject({
        title: s.title,
        abstract: s.abstract,
        slidesUrl: s.slidesUrl,
        videoUrl: s.videoUrl,
      })
    )
    .filter((s) => s.title);
  return out.length ? out : undefined;
}

/**
 * What the public speaking widget needs beside the rows: the Sessionize
 * speaker id it should read live, and the speaker profile (bio, headshot,
 * links). Both are saved on `admin_settings/integrations`; publishing copies
 * them into the snapshot so the widget never carries a hard-coded id and
 * reads nothing admin-gated. Only when the store can read documents.
 */
async function speakerMeta(store) {
  if (typeof store.readDoc !== 'function') return undefined;
  let settings = null;
  try {
    settings = await store.readDoc('admin_settings', 'integrations', 'integrations');
  } catch {
    return undefined;
  }
  if (!settings) return undefined;
  const speakerId = String(settings.sessionizeSpeakerId || '').trim();
  const profile = settings.speakerProfile;
  return compactObject({
    speakerId: speakerId || undefined,
    speakerProfile:
      profile && typeof profile === 'object'
        ? compactObject({
            name: profile.name,
            bio: profile.bio,
            headshotUrl: profile.headshotUrl,
            links: Array.isArray(profile.links)
              ? profile.links
                  .filter(
                    (l) => l && typeof l === 'object' && /^https?:\/\//i.test(String(l.url || ''))
                  )
                  .map((l) => ({ label: l.label || l.url, url: l.url }))
              : undefined,
          })
        : undefined,
  });
}

const SANITIZERS = {
  certifications: sanitizeCertification,
  speakerevents: sanitizeSpeakerEvent,
};

const SNAPSHOT_COLLECTIONS = ['certifications', 'speakerevents'];

/**
 * Re-point the certifications whose badge still names the decommissioned
 * Firebase bucket at the same path in the `certifications` container, where
 * the migration copied the blobs (legacy-badge-url.js, #868). Only when
 * blob storage confirms the blob exists: a reference rewritten to nothing
 * would swap a placeholder for a broken frame.
 *
 * The rewrite is persisted as ONE conditional write per row (`ifMatch` on
 * the `_etag` the row was read with), so an editor who saved a replacement
 * badge while blob storage was being asked is not overwritten by the
 * migration. A 412 re-reads the row, recomputes the rewrite against what is
 * stored now, and tries once more; if that fails too the fresh row is
 * published exactly as stored and the miss is logged — never the stale row.
 * A missing blob is reported by name and the document is left as it was.
 *
 * @param {object[]} rows the raw certification documents
 * @param {{ blobExists: (path: string) => Promise<boolean>, patch: ((id: string, changes: object, etag: string|undefined) => Promise<unknown>)|null, reread: ((id: string) => Promise<object|null>)|null, log: object }} deps
 * @returns {Promise<{ rows: object[], repointed: number, missing: string[] }>}
 */
async function repointLegacyBadges(rows, deps) {
  const existing = await confirmLegacyBlobs(rows, deps.blobExists);
  const out = [];
  const missing = [];
  let repointed = 0;
  for (const row of rows) {
    const outcome = await repointRow(row, existing, deps);
    out.push(outcome.row);
    repointed += outcome.repointed;
    missing.push(...outcome.missing.map((path) => `${row.name || row.Name || row.id}: ${path}`));
  }
  return { rows: out, repointed, missing };
}

/** Every distinct legacy path the rows name, asked of blob storage once each. */
async function confirmLegacyBlobs(rows, blobExists) {
  const paths = new Set(rows.flatMap(legacyBadgePathsOf));
  const existing = new Set();
  for (const path of paths) {
    if (await blobExists(path)) existing.add(path);
  }
  return existing;
}

/** One row: the rewrite as one change set, persisted conditionally, retried once from a fresh read. */
async function repointRow(row, existing, { patch, reread, log }) {
  const first = repointAll(row, existing);
  if (Object.keys(first.changes).length === 0) {
    return { row, repointed: 0, missing: first.missing };
  }
  if (!patch) return { row: first.doc, repointed: 1, missing: first.missing };

  const written = await persistRepoint(patch, row, first.changes, log);
  if (written !== 'conflict') return { row: first.doc, repointed: 1, missing: first.missing };

  // Someone wrote between the query and this write. Decide again from the
  // row as it is now, and publish that decision whether or not it persists.
  const fresh = reread ? await reread(row.id) : null;
  if (!fresh) {
    log?.warn?.(`[publishSnapshot] ${row.id} changed during publish and could not be re-read; published as queried`);
    return { row, repointed: 0, missing: first.missing };
  }
  const again = repointAll(fresh, existing);
  if (Object.keys(again.changes).length === 0) {
    return { row: fresh, repointed: 0, missing: again.missing };
  }
  const second = await persistRepoint(patch, fresh, again.changes, log);
  if (second === 'conflict') {
    log?.warn?.(`[publishSnapshot] ${row.id} changed twice during publish; published as stored, not re-pointed`);
    return { row: fresh, repointed: 0, missing: again.missing };
  }
  return { row: again.doc, repointed: 1, missing: again.missing };
}

/**
 * Persist a rewrite with the row's ETag as the precondition. 'conflict' on a
 * 412; any other failure is logged and the publish still carries the URL.
 */
async function persistRepoint(patch, row, changes, log) {
  try {
    await patch(row.id, changes, row._etag);
    return 'written';
  } catch (error) {
    if (error?.code === 412 || error?.statusCode === 412) return 'conflict';
    log?.warn?.(
      `[publishSnapshot] could not persist the re-pointed badge of ${row.id}: ${error?.message || error}`
    );
    return 'failed';
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, upsertDoc: Function, readDoc?: Function, patchDoc?: Function }} deps.store
 * @param {{ headBlobForDelivery: Function }|null} [deps.storage] blob storage; with none, legacy badges are left as they are
 * @param {() => Date} [deps.now]
 * @param {object} [deps.log]
 */
export function createSnapshotPublishHandlers({
  guard,
  store,
  storage = null,
  now = () => new Date(),
  log = console,
}) {
  const blobExists = storage?.headBlobForDelivery
    ? async (path) => Boolean(await storage.headBlobForDelivery('certifications', path))
    : null;
  const patch = store?.patchDoc
    ? (id, changes, etag) =>
        store.patchDoc('certifications', id, changes, etag ? { ifMatch: etag } : {})
    : null;
  const reread = store?.readDoc ? (id) => store.readDoc('certifications', id) : null;

  async function publishSnapshots(collectionNames = SNAPSHOT_COLLECTIONS) {
    const generatedAt = now().toISOString();
    const results = {};
    let legacyBadges;

    for (const collectionName of collectionNames) {
      let rows = await store.queryDocs(collectionName, 'SELECT TOP 2000 * FROM c', []);
      if (collectionName === 'certifications' && blobExists) {
        const outcome = await repointLegacyBadges(rows, { blobExists, patch, reread, log });
        rows = outcome.rows;
        legacyBadges = { repointed: outcome.repointed, missing: outcome.missing };
      }
      let items = rows.map((d) => serializeValue(d));
      const sanitize = SANITIZERS[collectionName];
      if (sanitize) items = items.map(sanitize).filter(Boolean);
      const meta = collectionName === 'speakerevents' ? await speakerMeta(store) : undefined;
      // `publishedAt` is the name the public pages compare against the
      // build-time JSON's stamp (ADR 0033, Spotlight slice: the newer of the
      // two wins); `generatedAt` stays for every existing reader.
      await store.upsertDoc('_snapshots', {
        id: collectionName,
        generatedAt,
        publishedAt: generatedAt,
        items,
        ...(meta && Object.keys(meta).length ? { meta } : {}),
      });
      results[collectionName] = items.length;
    }

    return { results, generatedAt, ...(legacyBadges ? { legacyBadges } : {}) };
  }

  return {
    // The weekly reVerifyCertifications timer (schedulers.js) republishes
    // through this after it marks a certificate expired, revoked or renewed.
    // It was wired to `snapshots.publishSnapshots` since the port and this
    // object never carried it, so that branch threw "is not a function" after
    // the patches were written and the snapshot stayed stale (#868, found
    // 2026-10-05). The timers test pins the name now.
    publishSnapshots,

    /** POST /api/publishSnapshot — editor. */
    async publishSnapshot(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const { results, generatedAt, legacyBadges } = await publishSnapshots();
        return json(200, { ...results, generatedAt, ...(legacyBadges ? { legacyBadges } : {}) });
      } catch (error) {
        return errorResponse(context, 'Failed to publish snapshots', error, 500, request);
      }
    },
  };
}
