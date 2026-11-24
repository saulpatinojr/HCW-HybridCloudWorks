/**
 * Legacy-blogs read counter, ported from
 * The source implementation was retired; this Azure route remains only as a
 * bounded compatibility counter for the admin fallback path.
 *
 * The `blogs` container is a fallback: list hooks query it only when `content`
 * comes back empty. This counter is the evidence for retiring it — without a
 * number, "is anything still reading the fallback?" has no answer, and the
 * container stays forever on the grounds that nobody can prove it is unused.
 *
 * **The route is authenticated, and the source's was not.** Its one caller is
 * an admin page, so anonymity bought nothing and cost an unauthenticated write
 * endpoint whose whole job is to increment a counter — a free write-amplification
 * target that also lets anyone poison the evidence this exists to produce.
 * `viewer` is the floor of the role hierarchy: everyone who can reach the page
 * can already call it.
 *
 * That change removes the reason the browser used `sendBeacon` (it cannot carry
 * an `Authorization` header). The call site is an ordinary async load, not an
 * unload handler, so nothing depended on beacon semantics.
 *
 * The Firestore original used `FieldValue.increment` on nested paths. Cosmos
 * has no server-side increment, so this is a read-modify-write on the whole
 * document — the same adaptation `bumpForgeStats` makes in the publish
 * pipeline, and for the same reason: the source key is caller-influenced text,
 * and writing whole objects avoids dotted-path escaping entirely.
 */

import { errorFacts } from './http/error-response.js';
export const TELEMETRY_CONTAINER = 'system';
export const LEGACY_BLOGS_READS_ID = 'legacy_blogs_reads';

/**
 * Sources the counter will attribute a read to.
 *
 * The source repository's allowlist named five `useFirestore*` hooks that no
 * longer exist — the Firestore hooks went with the migration. Keeping dead
 * entries would make the allowlist look like a record of live callers when it
 * is not, so only the one surviving caller is listed. Adding a caller means
 * adding it here; that is the point of an allowlist over free text, which would
 * let anyone grow `sources.<key>` without bound.
 */
export const LEGACY_BLOGS_READ_SOURCES = new Set(['socialhubpage', 'unknown']);

const DETAILS_MAX_KEYS = 10;
const DETAILS_MAX_JSON = 2000;
const DETAILS_MAX_KEY_LENGTH = 120;
const DETAILS_MAX_VALUE_LENGTH = 500;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * @param {unknown} source
 * @returns {string}
 */
export function normalizeSource(source) {
  return String(source || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 80);
}

/**
 * Primitive values only, at most ten keys, serialized size bounded. Returns
 * `null` when the input violates any of those, because a caller sending
 * something unexpected is a bug to surface rather than data to silently trim.
 *
 * @param {Record<string, unknown>} details
 * @returns {Record<string, string|number|boolean|null>|null}
 */
export function sanitizeDetails(details) {
  const keys = Object.keys(details);
  if (keys.length > DETAILS_MAX_KEYS) return null;

  const sanitized = {};
  for (const key of keys) {
    const value = details[key];
    const type = typeof value;
    if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
      return null;
    }
    sanitized[String(key).slice(0, DETAILS_MAX_KEY_LENGTH)] =
      type === 'string' ? value.slice(0, DETAILS_MAX_VALUE_LENGTH) : value;
  }

  if (JSON.stringify(sanitized).length > DETAILS_MAX_JSON) return null;
  return sanitized;
}

/**
 * Merge one read into the counter document.
 *
 * Pure and exported so the arithmetic is testable without a store — the whole
 * value of this endpoint is that its numbers are trustworthy.
 *
 * @param {object|null} existing
 * @param {{source: string, count: number, details: object, nowIso: string}} event
 * @returns {object}
 */
export function applyLegacyBlogsRead(existing, { source, count, details, nowIso }) {
  const sources = { ...(existing?.sources || {}) };
  sources[source] = (sources[source] || 0) + count;

  return {
    ...(existing || {}),
    id: LEGACY_BLOGS_READS_ID,
    totalReads: (existing?.totalReads || 0) + count,
    sources,
    updatedAt: nowIso,
    ...(Object.keys(details).length > 0 ? { lastDetails: details } : {}),
  };
}

/**
 * @param {object} deps
 * @param {{requireRole: Function}} deps.guard
 * @param {{readDoc: Function, upsertDoc: Function}} deps.store
 * @param {() => Date} [deps.now]
 */
export function createLegacyBlogsTelemetryHandlers({ guard, store, now = () => new Date() }) {
  return {
    /** POST /api/cms/telemetry/legacy-blogs-read — {source, count, details} */
    async recordLegacyBlogsRead(request, context) {
      const auth = await guard.requireRole(request, 'viewer');
      if (auth.error) return auth.error;

      try {
        const body = (await request.json().catch(() => null)) || {};
        const { source, count = 1, details = {} } = body;

        const normalizedSource = normalizeSource(source);
        if (!normalizedSource) {
          return json(400, { error: 'source is required' });
        }
        if (!LEGACY_BLOGS_READ_SOURCES.has(normalizedSource)) {
          return json(400, { error: 'unrecognized source' });
        }
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
          return json(400, { error: 'details must be an object' });
        }

        const sanitizedDetails = sanitizeDetails(details);
        if (!sanitizedDetails) {
          return json(400, {
            error: 'details too large or contains non-primitive values',
          });
        }

        const numericCount = Number(count);
        const normalizedCount = Number.isFinite(numericCount)
          ? Math.max(1, Math.floor(numericCount))
          : 1;

        const existing = await store.readDoc(
          TELEMETRY_CONTAINER,
          LEGACY_BLOGS_READS_ID,
          LEGACY_BLOGS_READS_ID
        );
        await store.upsertDoc(
          TELEMETRY_CONTAINER,
          applyLegacyBlogsRead(existing, {
            source: normalizedSource,
            count: normalizedCount,
            details: sanitizedDetails,
            nowIso: now().toISOString(),
          })
        );

        return json(200, { success: true });
      } catch (error) {
        context.error('recordLegacyBlogsRead failed:', errorFacts(error));
        return json(500, { error: 'Failed to record telemetry' });
      }
    },
  };
}
