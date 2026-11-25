import { useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import { formatPostDate } from '@/lib/blogUtils';

// Provider alias expansion ('gcp' → 'Google Cloud', casing variants) and the
// public-visibility filter both live server-side now — see
// functions/src/lib/public-reads.js.

function normalizeTags(doc = {}) {
  if (Array.isArray(doc.tags)) return doc.tags;
  if (Array.isArray(doc.Tags)) return doc.Tags;
  if (Array.isArray(doc.keyTopics)) return doc.keyTopics;
  return [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

// The fields a document may carry its publish date in, most specific first.
const PUBLISHED_DATE_FIELDS = [
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
  'publishedAt',
];

function resolvePublishedDate(doc = {}) {
  return PUBLISHED_DATE_FIELDS.map((field) => doc[field]).find(Boolean) || null;
}

function normalizeItem(doc = {}) {
  const tags = normalizeTags(doc);
  const title = firstNonEmpty(doc.title, doc.Title, 'Untitled') || 'Untitled';
  const description =
    firstNonEmpty(doc.summary, doc.Summary, doc.explanation, doc.description, '') || '';
  const category = firstNonEmpty(doc.category, doc.Category, 'Coder Corner') || 'Coder Corner';
  const complexity =
    firstNonEmpty(doc.complexity, doc.Complexity, 'Intermediate') || 'Intermediate';
  const slug = firstNonEmpty(doc.slug, doc.Slug, doc.id);
  const language = firstNonEmpty(doc.language, doc.stack);
  const repoUrl = firstNonEmpty(doc.repoUrl, doc.sourceUrl, doc.url);

  return {
    id: doc.id,
    title,
    description,
    excerpt: firstNonEmpty(doc.summary, doc.Summary, doc.explanation, '') || '',
    category,
    complexity,
    tags,
    date: formatPostDate(resolvePublishedDate(doc)),
    slug,
    language,
    repoUrl,
  };
}

export function useCoderCornerData(provider) {
  const normalizedProvider = String(provider || '').toLowerCase();

  const { data: contentRecords, loading: contentLoading } = usePublicData(
    () =>
      fetchPublicContentList({
        type: 'coder_corner',
        provider: normalizedProvider,
        limit: 60,
      }),
    normalizedProvider ? `coder-corner:${normalizedProvider}` : ''
  );

  const contentItems = useMemo(
    () => (contentRecords || []).map(normalizeItem).filter((item) => item.title && item.slug),
    [contentRecords]
  );
  const shouldLoadLegacy = !contentLoading && contentItems.length === 0;
  const { data: legacyBlogRecords, loading: blogsLoading } = usePublicData(
    () =>
      fetchPublicContentList({
        type: 'coder_corner',
        provider: normalizedProvider,
        limit: 30,
        source: 'blogs',
      }),
    shouldLoadLegacy && normalizedProvider ? `coder-corner:${normalizedProvider}:legacy` : ''
  );

  const items = useMemo(() => {
    if (contentItems.length > 0) {
      return contentItems;
    }

    return (legacyBlogRecords || []).map(normalizeItem).filter((item) => item.title && item.slug);
  }, [contentItems, legacyBlogRecords]);

  return {
    items,
    loading: contentLoading || (shouldLoadLegacy && blogsLoading),
    error: null,
  };
}

export default useCoderCornerData;
