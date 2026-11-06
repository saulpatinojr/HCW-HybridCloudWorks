import { useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList, PUBLIC_CORPUS_LIMIT } from '@/lib/publicApi';
import { formatPostDate, normalizePublicImageUrl, pickPublicImageUrl } from '@/lib/blogUtils';
// One canonicaliser for the whole app (T-738). This hook used to carry its own
// copy, and that copy did not know `vmware`, `broadcom`, `ansible` or `redhat`
// while useProviderLandingContent's did — so those documents appeared on the
// landing page and vanished from their own provider's blog list.
import { canonicalizeProvider, inferProviderFromText, squashProvider } from '@/lib/providers';

// Canonical governance source is `content`.
// `blogs` is retained as a legacy read fallback for older migrated content.

// An interview has its own page at /azure/interviews (ADR 0040, D6); it is
// never a blog post, and the blog list never shows one.
const EXCLUDED_TYPES = new Set(['architecture', 'framework', 'interview']);

const firstPresent = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
};

const inferProviderFromUrlFields = (doc = {}) => {
  const urlFields = [
    doc.slugPageUrl,
    doc.expectedPublicUrl,
    doc.publishedUrl,
    doc.publicUrl,
    doc.blogUrl,
    doc.curatedSubpagePath,
    doc.sourceUrl,
    doc.url,
    doc['CD Url'],
  ];

  for (const value of urlFields) {
    const inferred = inferProviderFromText(value);
    if (inferred) return inferred;
  }

  return '';
};

const inferProviderFromDoc = (doc) => {
  const explicit =
    doc['Cloud Provider'] ||
    doc.cloudProvider ||
    doc.provider ||
    doc.Provider ||
    doc.primaryProvider;
  const explicitNormalized = canonicalizeProvider(explicit);
  if (explicitNormalized) return explicitNormalized;

  const pathNormalized = canonicalizeProvider(String(doc.curatedSubpagePath || '').split('/')[1]);
  if (pathNormalized) return pathNormalized;

  const urlProvider = inferProviderFromUrlFields(doc);
  if (urlProvider) return urlProvider;

  return (
    inferProviderFromText(doc.Title) ||
    inferProviderFromText(doc.title) ||
    inferProviderFromText(doc.Summary) ||
    inferProviderFromText(doc.summary) ||
    ''
  );
};

const getReadTime = (doc) => {
  if (doc.readTime) return doc.readTime;
  if (doc.ReadTime) return doc.ReadTime;
  const wordCount = doc.wordCount || doc.WordCount || doc.words;
  if (typeof wordCount === 'number' && wordCount > 0) {
    const minutes = Math.max(3, Math.round(wordCount / 200));
    return `${minutes} min`;
  }
  return null;
};

const isBlogDocument = (doc) => !EXCLUDED_TYPES.has(String(doc.type || '').toLowerCase());

const matchesProvider = (doc, providerKey) => {
  if (!providerKey) return true;
  return inferProviderFromDoc(doc) === providerKey;
};

const isValidPost = (post) => post.title && post.title !== 'Untitled';

// Visibility is enforced server-side now — the public API only ever returns
// published documents — so the client filters are scoped to provider/type.
const mapToPublicPosts = (docs, providerKey) =>
  (docs || [])
    .filter((doc) => matchesProvider(doc, providerKey))
    .filter(isBlogDocument)
    .map(normalizePost)
    .filter(isValidPost);

const normalizePost = (doc) => {
  const rawTags = firstPresent(doc.Tags, doc.tags, doc.keyTopics, []);
  const tags = Array.isArray(rawTags) ? rawTags : [];
  const category = firstPresent(
    doc.category,
    doc.Category,
    doc.primaryCategory,
    tags[0],
    'General'
  );
  const title = firstPresent(doc.Title, doc.title, doc.name, 'Untitled');
  const summary = firstPresent(doc.Summary, doc.summary, doc.description, doc.excerpt, '');
  const author = firstPresent(
    doc.editorAuthor,
    doc.siteAuthor,
    doc.publishedByName,
    doc.createdByName,
    'Hybrid Cloud Works'
  );
  const publishedAt = firstPresent(
    doc.publishedDate,
    doc.datePublished,
    doc['Published At'],
    doc.blogPublishedAt,
    doc.publishedAt
  );
  const complexity = firstPresent(doc.technicalLevel, doc.complexity, doc.TechnicalLevel, null);
  const slug = firstPresent(doc.slug, doc.Slug, doc.id);
  // `pickPublicImageUrl`, not `firstPresent` then normalize: a feed-supplied
  // video in `contentImageUrl` is skipped rather than rendered into a card's
  // `<img>` and rather than shadowing a real cover behind it (issue #374).
  const imageUrl = pickPublicImageUrl(
    doc.contentImageUrl,
    doc.altCoverImage,
    doc.imageUrl,
    doc.ImageUrl,
    doc.coverImage,
    doc.thumbnail
  );
  // F9 — surface WebP variants when the chosen imageUrl comes from
  // altCoverImage (the only field that currently has matching variants).
  // Consumers fall back to plain PNG when imageVariants is null.
  let imageVariants = null;
  if (
    doc.altCoverImage &&
    imageUrl === normalizePublicImageUrl(doc.altCoverImage) &&
    doc.altCoverImageVariants
  ) {
    imageVariants = doc.altCoverImageVariants;
  }
  const url = firstPresent(
    doc.sourceUrl,
    doc.url,
    doc['CD Url'],
    doc['Source URL'],
    doc.link,
    null
  );

  return {
    id: firstPresent(doc.id, doc.slug, doc.Slug),
    title,
    description: summary,
    excerpt: summary,
    author,
    date: formatPostDate(publishedAt),
    category,
    tags,
    readTime: getReadTime(doc),
    featured: doc.featured === true || doc.Featured === true,
    complexity,
    slug,
    // Cover image — AI pipeline stores result in altCoverImage; fall back to common field names
    // contentImageUrl is set on content collection docs (pipeline + admin-published articles)
    imageUrl,
    imageVariants,
    // Article URL for "Read Article" links
    url,
  };
};

export function useBlogData(provider) {
  // The route segment, squashed only — it is already canonical, and running it
  // through the alias table would be a no-op at best.
  const providerKey = squashProvider(provider);

  // Canonical source — content collection (pipeline + admin published)
  const {
    data: contentData,
    loading: contentLoading,
    error: contentError,
  } = usePublicData(() => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT }), 'blog:content');
  const contentPosts = useMemo(
    () =>
      mapToPublicPosts(
        (contentData || []).map((d) => ({ ...d, __source: 'content' })),
        providerKey
      ),
    [contentData, providerKey]
  );
  const shouldLoadLegacy = !contentLoading && contentPosts.length === 0;

  // Legacy source — blogs collection (older migrated content + republished docs)
  const {
    data: blogsData,
    loading: blogsLoading,
    error: blogsError,
  } = usePublicData(
    () => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT, source: 'blogs' }),
    shouldLoadLegacy ? 'blog:legacy' : ''
  );

  const blogsPosts = useMemo(
    () =>
      mapToPublicPosts(
        (blogsData || []).map((d) => ({ ...d, __source: 'blogs' })),
        providerKey
      ),
    [blogsData, providerKey]
  );

  const loading = contentLoading || (shouldLoadLegacy && blogsLoading);

  const posts = useMemo(() => {
    if (contentPosts.length > 0) {
      return contentPosts;
    }

    return blogsPosts;
  }, [blogsPosts, contentPosts]);

  // Was hardcoded `error: null`, so a failed fetch reached no UI anywhere on
  // the blog path and one network blip rendered as an empty list (T-717).
  // Either source failing is reportable; the first one is enough to show.
  return { posts, loading, error: contentError || blogsError || null };
}

export default useBlogData;
