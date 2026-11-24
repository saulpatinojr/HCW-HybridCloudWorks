/**
 * dashboard-stats.js — keeps `system/dashboard_stats_v1` current from the
 * content change feed, and from the delete endpoints the feed cannot see.
 *
 * Ported from Site-Main `cms/dashboard.js` `applyDashboardStatsTransition`
 * (088f458). The previous position comes from a marker document in
 * `content_stats_markers` (one per content document — a sibling container,
 * so writing it does not re-fire the content feed), never from a previous
 * image. Idempotent: a redelivery reads a marker that already equals the
 * after position, computes no deltas, writes nothing. The marker advances
 * first (etag-conditioned); the counter write is a second, separate write —
 * a lost delta is recoverable, a stale marker skews every later one.
 *
 * The classification mirrors admin-snapshots.js summarizeDashboardItems so
 * the maintained counters agree with a full-scan recompute, and the recompute
 * (recalculateDashboardStats) re-derives the markers with `rederiveMarkers`
 * below, so a change to the classification is applied to both by one Recount.
 * admin-snapshots.js loads this module with a dynamic import, at call time,
 * because this module imports it statically.
 */
import {
  isBlockedContentSource,
  getCanonicalContentTypeForAdmin,
  DASHBOARD_STATS_DOC_ID,
} from '../admin-snapshots.js';
import { REVIEW_DECISION_STATUSES } from '../cms/content-status.js';

export const MARKERS_CONTAINER = 'content_stats_markers';
export const ABSENT_POSITION = Object.freeze({ exists: false, bucket: null, type: null });

/**
 * Statuses on no counter. `archived` is out of the pipeline; `drafting` is the
 * Drafts stage (content-status.js DRAFTS_STAGE_STATUS), the owner's writing
 * desk, not the pipeline yet — counting it as inProgress would put every
 * unfinished draft on the Editor badge. A draft enters the counters when it
 * is sent to In Review.
 */
const UNCOUNTED_STATUSES = new Set(['archived', 'drafting']);
/** draft, ingested, inspected and — since 2026-10-08 — in_review. */
const NEEDS_REVIEW_STATUSES = new Set(REVIEW_DECISION_STATUSES);

/** 'needsReview' | 'inProgress' | 'published' | 'rejected' | null (archived / drafting / missing / blocked). */
export function classifyContentBucket(data) {
  if (!data || isBlockedContentSource(data)) return null;
  const status = String(data.contentStatus || 'ingested');
  if (status === 'rejected') return 'rejected';
  if (UNCOUNTED_STATUSES.has(status)) return null;
  if (data.Live === true) return 'published';
  return NEEDS_REVIEW_STATUSES.has(status) ? 'needsReview' : 'inProgress';
}

export function resolveStatsPosition(data) {
  if (!data) return ABSENT_POSITION;
  return {
    exists: true,
    bucket: classifyContentBucket(data),
    type: getCanonicalContentTypeForAdmin(data),
  };
}

export function positionsEqual(a, b) {
  const left = a || ABSENT_POSITION;
  const right = b || ABSENT_POSITION;
  return left.exists === right.exists && left.bucket === right.bucket && left.type === right.type;
}

/** Counter deltas between two positions, as a flat `{ 'blog.needsReview': -1, totalDocs: 1 }` map (zeros dropped). */
export function buildDashboardStatsDeltas(beforePosition, afterPosition) {
  const before = beforePosition || ABSENT_POSITION;
  const after = afterPosition || ABSENT_POSITION;
  const deltas = {};
  const add = (key, delta) => {
    if (delta === 0) return;
    deltas[key] = (deltas[key] || 0) + delta;
    if (deltas[key] === 0) delete deltas[key];
  };
  if (!before.exists && after.exists) add('totalDocs', 1);
  if (before.exists && !after.exists) add('totalDocs', -1);
  if (before.bucket === 'rejected') add('rejected', -1);
  else if (before.bucket && before.type) {
    add(`${before.type}.${before.bucket}`, -1);
    add(`${before.type}.total`, -1);
  }
  if (after.bucket === 'rejected') add('rejected', 1);
  else if (after.bucket && after.type) {
    add(`${after.type}.${after.bucket}`, 1);
    add(`${after.type}.total`, 1);
  }
  return deltas;
}

/** Apply flat deltas onto a stats document (nested maps), never below zero. */
export function applyDeltas(stats, deltas) {
  const next = { ...stats };
  for (const [key, delta] of Object.entries(deltas)) {
    const dot = key.indexOf('.');
    if (dot === -1) {
      next[key] = Math.max(0, (Number(next[key]) || 0) + delta);
      continue;
    }
    const type = key.slice(0, dot);
    const bucket = key.slice(dot + 1);
    next[type] = { ...(next[type] || {}) };
    next[type][bucket] = Math.max(0, (Number(next[type][bucket]) || 0) + delta);
  }
  return next;
}

/** The markers one Recount reads: one per content document, bounded like its scan. */
export const MARKER_SCAN_TOP = 5000;
/** Marker writes a Recount keeps in flight at once. */
const MARKER_WRITE_BATCH = 10;

const hasStatus = (code) => (err) => err?.code === code || err?.statusCode === code;
const isConflict = hasStatus(409);
const isPreconditionFailed = hasStatus(412);

/** The write that brings one marker to `position`, or null when it is there already. */
function markerWrite(store, { id, marker, position, stamp }) {
  const next = { bucket: position.bucket, type: position.type, updatedAt: stamp };
  if (!marker) {
    return () =>
      store.createDoc(MARKERS_CONTAINER, { id, ...next }).then(
        () => 'created',
        (err) => {
          if (isConflict(err)) return 'skipped';
          throw err;
        }
      );
  }
  const current = { exists: true, bucket: marker.bucket ?? null, type: marker.type ?? null };
  if (positionsEqual(current, position)) return null;
  return () =>
    store.replaceDocIfMatch(MARKERS_CONTAINER, { ...marker, ...next }).then(
      () => 'rewritten',
      (err) => {
        if (isPreconditionFailed(err)) return 'skipped';
        throw err;
      }
    );
}

/**
 * Bring each scanned document's marker to the position the current
 * classification gives it: the half of a Recount the counters alone cannot
 * do, because every later delta is computed from the marker. A marker the
 * change feed moved after it was read (412) or created meanwhile (409) is
 * left as the feed wrote it — that write is newer than the scan. Markers of
 * documents outside the scan are not touched.
 *
 * @param {object} args
 * @param {{ queryDocs: Function, createDoc: Function, replaceDocIfMatch: Function }} args.store
 * @param {object[]} args.items the scanned content documents
 * @param {() => Date} [args.now]
 * @returns {Promise<{ checked: number, created: number, rewritten: number, skipped: number }>}
 */
export async function rederiveMarkers({ store, items, now = () => new Date() }) {
  const rows = await store.queryDocs(MARKERS_CONTAINER, `SELECT TOP ${MARKER_SCAN_TOP} * FROM c`, []);
  const markers = new Map((rows || []).map((row) => [row.id, row]));
  const stamp = now().toISOString();
  const scanned = items || [];
  const writes = scanned
    .map((item) =>
      markerWrite(store, {
        id: item.id,
        marker: markers.get(item.id),
        position: resolveStatsPosition(item),
        stamp,
      })
    )
    .filter(Boolean);
  const tally = { checked: scanned.length, created: 0, rewritten: 0, skipped: 0 };
  for (let start = 0; start < writes.length; start += MARKER_WRITE_BATCH) {
    const batch = writes.slice(start, start + MARKER_WRITE_BATCH);
    const outcomes = await Promise.all(batch.map((write) => write()));
    outcomes.forEach((outcome) => {
      tally[outcome] += 1;
    });
  }
  return tally;
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function, deleteDoc: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export function createDashboardStatsMaintainer({ store, now = () => new Date(), log = {} }) {
  /**
   * Move the counters for one content document to its current position.
   * `afterData === null` means the document is gone (the delete endpoints).
   * @returns {Promise<object>} the deltas applied ({} when nothing moved)
   */
  async function applyTransition({ contentId, afterData }) {
    const afterPosition = resolveStatsPosition(afterData);
    const marker = await store.readDoc(MARKERS_CONTAINER, contentId, contentId);
    const beforePosition = marker
      ? { exists: true, bucket: marker.bucket ?? null, type: marker.type ?? null }
      : ABSENT_POSITION;

    if (!afterPosition.exists) {
      if (marker) await store.deleteDoc(MARKERS_CONTAINER, contentId, contentId);
    } else if (!positionsEqual(beforePosition, afterPosition)) {
      const next = {
        ...(marker || {}),
        id: contentId,
        bucket: afterPosition.bucket,
        type: afterPosition.type,
        updatedAt: now().toISOString(),
      };
      if (marker?._etag) {
        try {
          await store.replaceDocIfMatch(MARKERS_CONTAINER, next);
        } catch (err) {
          if (err?.code === 412 || err?.statusCode === 412) {
            log.log?.('[dashboard-stats] a marker advanced concurrently; no-op');
            return {};
          }
          throw err;
        }
      } else {
        await store.upsertDoc(MARKERS_CONTAINER, next);
      }
    }

    const deltas = buildDashboardStatsDeltas(beforePosition, afterPosition);
    if (Object.keys(deltas).length === 0) return deltas;

    const stats = (await store.readDoc(
      'system',
      DASHBOARD_STATS_DOC_ID,
      DASHBOARD_STATS_DOC_ID
    )) || { id: DASHBOARD_STATS_DOC_ID, schemaVersion: 1 };
    const updated = {
      ...applyDeltas(stats, deltas),
      id: DASHBOARD_STATS_DOC_ID,
      updatedAt: now().toISOString(),
    };
    await store.upsertDoc('system', updated);
    return deltas;
  }

  return { applyTransition };
}
