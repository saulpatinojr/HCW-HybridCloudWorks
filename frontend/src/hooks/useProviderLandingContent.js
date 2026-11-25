import { useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList, PUBLIC_CORPUS_LIMIT } from '@/lib/publicApi';
import { formatPostDate } from '@/lib/blogUtils';
import { toMillis } from '@/lib/dateUtils';
import { getCanonicalContentType, getContentPublicPath } from '@/lib/contentModel';
// One canonicaliser for the whole app (T-738). The alias table this file
// used to own privately — vmware/broadcom, ansible/redhat — is the table
// every other reader now shares, which is what stops those documents
// showing here and vanishing from their own provider's blog list.
import {
  canonicalDocProvider,
  canonicalizeProvider,
  inferProviderFromFields,
} from '@/lib/providers';

const DISPLAY_TYPE_LABELS = {
  blog: 'Blog',
  news: 'News',
  framework: 'Framework',
  architecture: 'Architecture',
  coder_corner: 'Coder Corner',
};

const SUPPORTED_TYPES = new Set(Object.keys(DISPLAY_TYPE_LABELS));

// `a || b || c` over a list of field names: the first truthy field, or a
// falsy value when none is.
function firstTruthyField(doc, fields) {
  return fields.reduce((found, field) => found || doc[field], undefined);
}

// Fields read, in order, for a provider name inside a URL, path or title.
const PROVIDER_TEXT_FIELDS = [
  'slugPageUrl',
  'publishedUrl',
  'publicUrl',
  'blogUrl',
  'curatedSubpagePath',
  'url',
  'sourceUrl',
  'Title',
  'title',
];

function inferProviderFromDoc(doc = {}) {
  const explicit = canonicalDocProvider(doc);
  if (explicit) return explicit;

  const pathProvider = canonicalizeProvider(String(doc.curatedSubpagePath || '').split('/')[1]);
  if (pathProvider) return pathProvider;

  return inferProviderFromFields(doc, PROVIDER_TEXT_FIELDS);
}

function curatedPageUrl(curatedSubpagePath) {
  if (!curatedSubpagePath) return '';
  const path = String(curatedSubpagePath).startsWith('/')
    ? curatedSubpagePath
    : `/${curatedSubpagePath}`;
  return `https://hybridcloudworks.com${path}`;
}

function getPublicUrl(doc = {}) {
  const explicitUrl =
    firstTruthyField(doc, ['slugPageUrl', 'publishedUrl', 'blogUrl', 'publicUrl']) ||
    curatedPageUrl(doc.curatedSubpagePath);

  if (explicitUrl) return explicitUrl;

  const publicPath = getContentPublicPath(doc);
  return publicPath ? `https://hybridcloudworks.com${publicPath}` : '';
}

function getRecency(doc = {}) {
  return Math.max(
    toMillis(doc.publishedDate),
    toMillis(doc.datePublished),
    toMillis(doc['Published At']),
    toMillis(doc.blogPublishedAt),
    toMillis(doc.publishedAt),
    toMillis(doc.updatedAt),
    toMillis(doc.createdAt)
  );
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function normalizeTags(doc = {}) {
  const raw = firstPresent(doc.tags, doc.Tags, doc.keyTopics, []);
  return Array.isArray(raw) ? raw.filter(Boolean).slice(0, 3) : [];
}

function normalizeItem(doc = {}) {
  const contentType = getCanonicalContentType(doc);
  const publicUrl = getPublicUrl(doc);
  const title = firstPresent(doc.Title, doc.title, doc.name, 'Untitled');
  const summary = firstPresent(doc.Summary, doc.summary, doc.description, doc.excerpt, '');
  const publishedAt = firstPresent(
    doc.publishedDate,
    doc.datePublished,
    doc['Published At'],
    doc.blogPublishedAt,
    doc.publishedAt
  );

  return {
    id: doc.id,
    title,
    summary,
    publicUrl,
    contentType,
    contentTypeLabel: DISPLAY_TYPE_LABELS[contentType] || 'Content',
    tags: normalizeTags(doc),
    dateLabel: formatPostDate(publishedAt),
    recency: getRecency(doc),
  };
}

function hasPublicPage(item) {
  return Boolean(item.publicUrl && item.title && item.title !== 'Untitled');
}

// The provider's own items from a list of documents: supported types only,
// one per public URL, newest first.
function collectProviderItems(docs, providerKey) {
  const seen = new Set();
  const merged = [];

  for (const doc of docs || []) {
    if (inferProviderFromDoc(doc) !== providerKey) continue;
    if (!SUPPORTED_TYPES.has(getCanonicalContentType(doc))) continue;

    const normalized = normalizeItem(doc);
    if (!hasPublicPage(normalized)) continue;

    const dedupeKey = normalized.publicUrl.trim().toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(normalized);
  }

  return merged.sort((a, b) => b.recency - a.recency);
}

export function useProviderLandingContent(provider) {
  const providerKey = canonicalizeProvider(provider);
  // Visibility is enforced server-side — the public API only returns
  // published documents — so the client filters are scoped to provider/type.
  const { data: contentDocs, loading: contentLoading } = usePublicData(
    () => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT }),
    'landing:content'
  );

  const contentItems = useMemo(
    () => collectProviderItems(contentDocs, providerKey),
    [contentDocs, providerKey]
  );

  const shouldLoadLegacy = !contentLoading && contentItems.length === 0;
  const { data: blogDocs, loading: blogLoading } = usePublicData(
    () => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT, source: 'blogs' }),
    shouldLoadLegacy ? 'landing:legacy' : ''
  );

  const blogItems = useMemo(
    () => collectProviderItems(blogDocs, providerKey),
    [blogDocs, providerKey]
  );

  const items = contentItems.length > 0 ? contentItems : blogItems;

  return {
    items,
    loading: contentLoading || (shouldLoadLegacy && blogLoading),
  };
}

export default useProviderLandingContent;
