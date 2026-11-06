/**
 * Publish-target and content-type normalizers.
 *
 * Ported verbatim from Site-Main cms-functions.js (:167, :191, :198). The
 * legacy aliases matter: published_news / approved_news / news / rss / both
 * are statuses and targets that the news-era ingestion wrote, and they all
 * collapse to 'blog'. An unknown target falls back to the (normalized)
 * content type, and an unknown type falls back to 'blog'.
 *
 * Keep the set in sync with the CONTRACTS keys in publish-contracts.js and
 * getPublicSectionForTarget in the frontend's contentModel.js.
 */

export const SUPPORTED_PUBLISH_TARGETS = new Set([
  'blog',
  'framework',
  'architecture',
  'coder_corner',
  // A conversation with a guest, written up as questions and answers,
  // reviewed and published from the admin (ADR 0040, D5).
  'interview',
]);

export function normalizeContentType(type) {
  const normalized = String(type || '')
    .trim()
    .toLowerCase();
  return SUPPORTED_PUBLISH_TARGETS.has(normalized) ? normalized : 'blog';
}

export function normalizePublishTarget(value, fallbackType = 'blog') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (normalized === 'published_news' || normalized === 'approved_news') {
    return 'blog';
  }

  if (normalized === 'news' || normalized === 'rss' || normalized === 'both') {
    return 'blog';
  }

  if (SUPPORTED_PUBLISH_TARGETS.has(normalized)) {
    return normalized;
  }

  return normalizeContentType(fallbackType);
}
