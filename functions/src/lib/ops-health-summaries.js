/**
 * ops-health-summaries.js — the pieces of the Health page's snapshot that
 * are computed rather than read: times as hours, the orphaned-image count,
 * the content agent's card, and the day's jobs and forge summaries. Split
 * out of ops-health.js, which re-exports the public names.
 */
import { CAPABILITIES, enabledCapabilities, isUsable } from './agent-content/keys.js';
import { DEFAULT_AGENT_KEY } from './agent-content/agent-keys.js';

export function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  // A migrated Firestore time stored as plain JSON: { seconds, nanoseconds }
  // or { _seconds, _nanoseconds } (#1516).
  const seconds = value.seconds ?? value._seconds;
  if (typeof seconds === 'number') return seconds * 1000;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function toHoursSince(value, nowMs) {
  const ts = toMillis(value);
  if (!ts) return null;
  return Math.max(0, Math.round(((nowMs - ts) / (1000 * 60 * 60)) * 10) / 10);
}

export function getWorkflowAlertStatus(alert = {}) {
  return alert.status || (alert.active === false ? 'resolved' : 'open');
}

/** The most generated images one snapshot reads; above it the storage count is a floor. */
export const IMAGES_PROBE_BOUND = 2000;
/**
 * Content ids per orphan-probe query (T-711). Bounded because a Cosmos query
 * carries its parameters in the request: one enormous ARRAY_CONTAINS would
 * trade 2000 small reads for one request too large to serve.
 */
const ORPHAN_PROBE_BATCH = 100;

/** An image's content id as a key, or '' when it has none. */
const contentIdOf = (image) => String(image?.contentId || '').trim();

/**
 * Orphan detection (T-711): how many generated images name a content
 * document that no longer exists, or none at all.
 *
 * This used to be `Promise.all(generatedImages.map(… readDoc …))` — an
 * unthrottled fan-out of up to IMAGES_PROBE_BOUND (2000) concurrent point
 * reads, purely to produce one count. Every /status, /queue, /alerts,
 * /digest and /ai reaches it, AND so does every free-form Telegram
 * message, so one chat message could exhaust the RU budget the anonymous
 * public list endpoints share and 429 the website.
 *
 * Two properties do the work. Images are keyed by contentId and a single
 * content document can carry up to four generated images, so deduplicating
 * removes most of the reads before any I/O. What remains is answered in
 * batches with ARRAY_CONTAINS instead of one request each: ~2000 point
 * reads become a handful of queries, and the count is identical.
 */
export async function countOrphanedImages(store, generatedImages) {
  const idsToProbe = [...new Set(generatedImages.map(contentIdOf))].filter(Boolean);
  // An image with no contentId is an orphan by definition and needs no probe.
  const missingIdCount = generatedImages.filter((image) => !contentIdOf(image)).length;

  const existingIds = new Set();
  for (let i = 0; i < idsToProbe.length; i += ORPHAN_PROBE_BATCH) {
    const batch = idsToProbe.slice(i, i + ORPHAN_PROBE_BATCH);
    const rows = await store.queryDocs(
      'content',
      'SELECT c.id FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
      [{ name: '@ids', value: batch }]
    );
    for (const row of rows || []) existingIds.add(row.id);
  }
  return (
    missingIdCount +
    generatedImages.filter((image) => {
      const contentId = contentIdOf(image);
      return contentId && !existingIds.has(contentId);
    }).length
  );
}

/**
 * Approved or Published, not live yet and not scheduled for later: what
 * "waiting to go live" means on the Operational Signals tile (#1512). `Live`
 * may be absent on an item that was never published, and a comparison with an
 * absent field is undefined in Cosmos, so absence is spelled out, in the same
 * spelling scheduled-publish.js uses. Writes only ever store a boolean.
 */
export const STAGED_NOT_LIVE =
  'ARRAY_CONTAINS(@stagedStatuses, c.contentStatus) AND (NOT IS_DEFINED(c.Live) OR c.Live = false)' +
  // An item scheduled for later is not stuck: it is waiting on purpose, and
  // the scheduler's own card (Overdue Scheduled) covers it once it is due.
  ' AND (NOT IS_DEFINED(c.scheduledPublishDate) OR IS_NULL(c.scheduledPublishDate) OR c.scheduledPublishDate <= @now)';

/** The most undated waiting items one snapshot reads for their age (#1516). */
export const UNDATED_STAGED_BOUND = 50;

/** How far back the content agent's denials and the platform jobs are counted. */
export const AGENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most denial rows one snapshot reads; above it the count is a floor. */
export const AGENT_DENIALS_BOUND = 200;
/** The `action` (and `kind`) of the content agent's denial rows (agent-content/guard.js). */
export const AGENT_DENIAL_ACTION = 'agent-content-denial';

/** An unset key: what `agent.key` says when the record is absent or could not be read. */
const NO_KEY = Object.freeze({
  present: false,
  active: false,
  createdAt: null,
  rotatedAt: null,
  revokedAt: null,
  lastUsedAt: null,
});

/**
 * One agent key (Koda's by default; one per row of agent-content/agent-keys.js,
 * ADR 0037 and 0038) as the Health page shows it:
 * the state of its key without the hint or the hash, the switches that are
 * off, and the refusals the last day recorded. A denial row is content-free
 * by design (`agent-content/guard.js`), so counting them by reason discloses
 * nothing a viewer may not see.
 *
 * Two different "no" answers are kept apart. `key.present: false` with
 * `key.unavailable: false` means the store has no key record (the agent is
 * not set up); `key.unavailable: true` means the read failed and nothing
 * about the key is known. The same for the refusals: `denials.unavailable`
 * is true when the audit read failed, so the card says it could not look
 * instead of showing a reassuring zero.
 *
 * `denialRows` come newest first (the query orders by the indexed
 * `timestamp`), so `lastAt` is the newest row's time even when the read hit
 * its bound; `bounded` then says the total and the reasons are a floor.
 */
export function agentSummary({ key = DEFAULT_AGENT_KEY, record, keyUnavailable = false, denialRows, sinceIso, lastCheckedAt }) {
  return {
    id: key.id,
    label: key.displayName,
    key: keyState(record, keyUnavailable),
    sectionsOff: sectionsOffOf(record),
    denials: denialsSummary(denialRows, sinceIso),
    lastCheckedAt,
  };
}

/** The key record's state, without the hint or the hash; NO_KEY when there is none or it could not be read. */
function keyState(record, keyUnavailable) {
  if (!record) return { ...NO_KEY, unavailable: Boolean(keyUnavailable) };
  return {
    present: true,
    active: isUsable(record),
    createdAt: record.createdAt || null,
    rotatedAt: record.rotatedAt || null,
    revokedAt: record.revokedAt || null,
    lastUsedAt: record.lastUsedAt || null,
    unavailable: false,
  };
}

/** The capability switches that are off. */
function sectionsOffOf(record) {
  // Switches mean nothing without a key: every capability reads as "on" for
  // an empty record, which is not a fact about anything.
  if (!record) return [];
  const on = new Set(enabledCapabilities(record));
  return CAPABILITIES.filter((capability) => !on.has(capability.id)).map((capability) => ({
    id: capability.id,
    label: capability.label,
  }));
}

/** The last day's refusals by reason, newest time, and whether the read was bounded or failed. */
function denialsSummary(denialRows, sinceIso) {
  if (!Array.isArray(denialRows)) {
    return { since: sinceIso, total: 0, byReason: [], lastAt: null, bounded: false, unavailable: true };
  }
  const counts = new Map();
  let lastAt = null;
  for (const row of denialRows) {
    const reason = typeof row?.reason === 'string' && row.reason ? row.reason : 'unstated';
    counts.set(reason, (counts.get(reason) || 0) + 1);
    lastAt = laterStamp(lastAt, typeof row?.timestamp === 'string' ? row.timestamp : row?.at);
  }
  return {
    since: sinceIso,
    total: denialRows.length,
    byReason: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    lastAt,
    bounded: denialRows.length >= AGENT_DENIALS_BOUND,
    unavailable: false,
  };
}

/** The later of two ISO stamps; a value that is not a string is ignored. */
const laterStamp = (current, at) => (typeof at === 'string' && (!current || at > current) ? at : current);

/** The job statuses the day's strip counts by name; anything else is `other`. */
const COUNTED_JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed']);

/** The last day's platform jobs by status, from a GROUP BY the jobs index serves. */
export function jobsSummary(rows, sinceIso) {
  if (!Array.isArray(rows)) {
    return { since: sinceIso, queued: 0, running: 0, succeeded: 0, failed: 0, other: 0, total: 0, unavailable: true };
  }
  const summary = { since: sinceIso, queued: 0, running: 0, succeeded: 0, failed: 0, other: 0, total: 0, unavailable: false };
  for (const row of rows) {
    const n = Number(row?.n) || 0;
    const status = String(row?.status || '');
    if (COUNTED_JOB_STATUSES.has(status)) summary[status] += n;
    else summary.other += n;
    summary.total += n;
  }
  return summary;
}

/**
 * The autonomous forge's rolling day bucket (content/forge.js) as the Health
 * page shows it: when the forge last did anything, and how much today.
 */
export function forgeSummary(forgeStats, lastCheckedAt) {
  return {
    updatedAt: forgeStats?.updatedAt ?? null,
    todayDate: forgeStats?.today?.date ?? null,
    forgedToday: Number(forgeStats?.today?.forged) || 0,
    lastCheckedAt,
  };
}
