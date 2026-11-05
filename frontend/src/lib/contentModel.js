import { canonicalizeProvider } from './providers.js';

export const CONTENT_TYPES = new Set([
  'blog',
  'framework',
  'architecture',
  'coder_corner',
  'interview',
  'news',
]);

export function normalizeContentType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return CONTENT_TYPES.has(normalized) ? normalized : 'blog';
}

export function getPublishTargetForType(value) {
  const type = normalizeContentType(value);
  if (type === 'news') return 'blog';
  return type;
}

export function getPublicSectionForTarget(value) {
  switch (getPublishTargetForType(value)) {
    case 'framework':
      return 'frameworks';
    case 'architecture':
      return 'architecture-designs';
    case 'coder_corner':
      return 'code';
    // ADR 0040, D5: an interview lives at /azure/interviews/<slug>.
    case 'interview':
      return 'interviews';
    case 'news':
      return 'news';
    case 'blog':
    default:
      return 'blog';
  }
}

export function getCanonicalContentType(item = {}) {
  const explicitType = normalizeContentType(item.contentType || item.type);
  if (explicitType !== 'blog') return explicitType;

  const target = String(item.publishTarget || '')
    .trim()
    .toLowerCase();

  if (
    target === 'framework' ||
    target === 'architecture' ||
    target === 'coder_corner' ||
    target === 'interview'
  ) {
    return target;
  }
  if (target === 'news' || target === 'rss') {
    return 'news';
  }
  return explicitType;
}

export function getPublishTargetForItem(item = {}) {
  return getPublishTargetForType(item.publishTarget || getCanonicalContentType(item));
}

/**
 * Retained as a named export because several modules import it; the
 * implementation is now the shared one (T-738).
 *
 * The exact-key alias map this replaces matched only whole strings, so
 * "Microsoft Azure" fell through to `microsoftazure` and "AWS Lambda" to
 * `awslambda`. Because this function feeds `getContentPublicPath`, that
 * produced a public URL no route serves — for real documents, since a
 * multi-word provider field is the normal case rather than the exotic one.
 */
export const normalizeContentProvider = canonicalizeProvider;

export function getContentPublicPath(item = {}) {
  const provider = normalizeContentProvider(
    item['Cloud Provider'] || item.cloudProvider || item.provider || ''
  );
  const slug = item.slug || item.Slug || '';

  if (!provider || !slug) return '';

  return `/${provider}/${getPublicSectionForTarget(getPublishTargetForItem(item))}/${slug}`;
}
