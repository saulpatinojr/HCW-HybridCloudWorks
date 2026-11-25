/**
 * Content dedup: URL/title normalizers and the four-stage duplicate check.
 *
 * Ported from Site-Main cms-functions.js (normalizeUrlForDedup,
 * normalizeTitleForDedup, dedupCheck* stages 1-4, findDuplicateContent,
 * buildDedupFields). The normalizers are pure and carried verbatim; the staged
 * checks swap Firestore `where().limit(1)` queries for parameterised Cosmos
 * queries through an injected store, so the stage order and short-circuit
 * behaviour — exact URL, then normalized URL, then canonical, then
 * title-within-window — are preserved exactly.
 *
 * One deliberate adaptation: getDocDateValue also accepts ISO date strings.
 * The source handled Date and Firestore Timestamp (.toDate()); migrated Cosmos
 * documents carry the timestamps as ISO strings (scripts/lib/
 * firestore-transform.mjs), so without this the title-window stage would go
 * blind on every migrated document and dedup would silently weaken.
 */

/**
 * Canonical form of a URL for dedup matching: https, lowercased host without
 * www, no fragment, tracking params stripped, trailing slashes collapsed.
 */
export function normalizeUrlForDedup(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hash = '';
    const TRACKING = /^utm_|^mc_|^fbclid$|^gclid$|^ref$|^source$/i;
    [...u.searchParams.keys()].forEach((k) => {
      if (TRACKING.test(k)) u.searchParams.delete(k);
    });
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Lossy normalization for title-similarity dedup. Lowercase, ASCII-fold,
 * strip punctuation, collapse whitespace.
 */
export function normalizeTitleForDedup(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return null;
  const folded = rawTitle
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return folded || null;
}

export const TITLE_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Date from a stored field. Source shape (Date / Firestore Timestamp) plus the
 * migrated shape (ISO string) — see the header.
 */
export function getDocDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** First `content` doc matching `field == value`, or null. */
async function firstWhere(store, field, value) {
  const rows = await store.queryDocs(
    'content',
    // Bracket quoting so 'CD Url' (a real legacy field name) works too.
    `SELECT TOP 1 c.id FROM c WHERE c["${field}"] = @value`,
    [{ name: '@value', value }]
  );
  return rows[0] ?? null;
}

// Stage 1: exact source URL, current and legacy field names.
async function dedupCheckExactUrl(store, url) {
  if (!url) return null;
  const exact = await firstWhere(store, 'sourceUrl', url);
  if (exact) return { duplicate: true, reason: 'exact_url', existingId: exact.id };
  const legacy = await firstWhere(store, 'CD Url', url);
  if (legacy) return { duplicate: true, reason: 'legacy_url', existingId: legacy.id };
  return null;
}

// Stage 2: normalized URL (utm/fragment-stripped) match.
async function dedupCheckNormalizedUrl(store, normalizedUrl) {
  if (!normalizedUrl) return null;
  const match = await firstWhere(store, 'normalizedUrl', normalizedUrl);
  return match ? { duplicate: true, reason: 'normalized_url', existingId: match.id } : null;
}

// Stage 3: canonical URL match (when distinct from normalizedUrl).
async function dedupCheckCanonicalUrl(store, normalizedCanonical, normalizedUrl) {
  if (!normalizedCanonical || normalizedCanonical === normalizedUrl) return null;
  const norm = await firstWhere(store, 'normalizedUrl', normalizedCanonical);
  if (norm) return { duplicate: true, reason: 'canonical_url', existingId: norm.id };
  const canon = await firstWhere(store, 'canonicalUrl', normalizedCanonical);
  if (canon) return { duplicate: true, reason: 'canonical_url', existingId: canon.id };
  return null;
}

// Stage 4: normalized title match within +/-7d of candidate publish date.
async function dedupCheckTitleWindow(store, normalizedTitle, candidatePublishedMs) {
  if (!normalizedTitle || normalizedTitle.length < 8) return null;
  const matches = await store.queryDocs(
    'content',
    'SELECT TOP 10 c.id, c["publishedAt"], c["Published At"], c["publishedDate"], c["fetchedAt"], c["Created At"] FROM c WHERE c.normalizedTitle = @title',
    [{ name: '@title', value: normalizedTitle }]
  );
  for (const data of matches) {
    const candidateRef = firstTruthy([
      data.publishedAt,
      data['Published At'],
      data.publishedDate,
      data.fetchedAt,
      data['Created At'],
    ]);
    const refDate = getDocDateValue(candidateRef);
    if (!refDate) continue;
    if (Math.abs(refDate.getTime() - candidatePublishedMs) <= TITLE_DEDUP_WINDOW_MS) {
      return { duplicate: true, reason: 'title_within_window', existingId: data.id };
    }
  }
  return null;
}

/**
 * Four-stage duplicate check, short-circuiting on the first hit.
 *
 * @param {{ queryDocs: Function }} store cosmos-client (or a test fake)
 * @param {object} candidate { url|sourceUrl, canonicalUrl, title|Title, publishedAt|publishedMs }
 * @returns {Promise<{duplicate: boolean, reason?: string, existingId?: string}>}
 */
export async function findDuplicateContent(store, candidate = {}) {
  const url = candidate.url || candidate.sourceUrl || '';
  const canonical = candidate.canonicalUrl || '';
  const title = candidate.title || candidate.Title || '';
  const candidatePublishedMs = candidatePublishedMsOf(candidate);

  const normalizedUrl = normalizeUrlForDedup(url);
  const normalizedCanonical = normalizeUrlForDedup(canonical);
  const normalizedTitle = normalizeTitleForDedup(title);

  const stages = [
    () => dedupCheckExactUrl(store, url),
    () => dedupCheckNormalizedUrl(store, normalizedUrl),
    () => dedupCheckCanonicalUrl(store, normalizedCanonical, normalizedUrl),
    () => dedupCheckTitleWindow(store, normalizedTitle, candidatePublishedMs),
  ];
  for (const stage of stages) {
    const hit = await stage();
    if (hit) return hit;
  }
  return { duplicate: false };
}

/** The candidate's publish time in milliseconds; now when it gives none that can be read. */
function candidatePublishedMsOf(candidate) {
  if (typeof candidate.publishedMs === 'number') return candidate.publishedMs;
  if (candidate.publishedAt instanceof Date) return candidate.publishedAt.getTime();
  const now = Date.now();
  if (typeof candidate.publishedAt !== 'string') return now;
  const parsed = getDocDateValue(candidate.publishedAt);
  return parsed ? parsed.getTime() : now;
}

/** The first truthy value, or the last one when none is: what `a || b || c` gives. */
function firstTruthy(values) {
  return values.find(Boolean) ?? values[values.length - 1];
}

/**
 * Dedup-related fields to merge into a new content doc so future inserts can
 * match against it via findDuplicateContent.
 */
export function buildDedupFields({ url, canonicalUrl, title }) {
  const out = {};
  const normalizedUrl = normalizeUrlForDedup(url);
  if (normalizedUrl) out.normalizedUrl = normalizedUrl;
  const normalizedCanonical = normalizeUrlForDedup(canonicalUrl);
  if (normalizedCanonical) out.canonicalUrl = normalizedCanonical;
  const normalizedTitle = normalizeTitleForDedup(title);
  if (normalizedTitle) out.normalizedTitle = normalizedTitle;
  return out;
}
