// Plain-data helpers for BlogDetailTemplate: where the back link goes, and how
// a blog or content document is turned into the one shape the page renders.
import { pickPublicImageUrl } from '@/lib/blogUtils';

// Back link per section; anything else goes back to the blog list.
const BACK_LINKS = {
  news: { path: 'rss', label: 'Back to News' },
  code: { path: 'code', label: 'Back to Code' },
  'coder-corner': { path: 'coder-corner', label: 'Back to Coder Corner' },
};
const DEFAULT_BACK_LINK = { path: 'blog', label: 'Back to Blog' };

export function backLinkFor(provider, section) {
  const link = BACK_LINKS[section] || DEFAULT_BACK_LINK;
  return { backPath: `/${provider}/${link.path}`, backLabel: link.label };
}

// The first field in `keys` that has a truthy value, else `fallback`.
// Same result as writing `a.x || a.y || ... || fallback`.
function firstField(article, keys, fallback) {
  for (const key of keys) {
    if (article[key]) return article[key];
  }
  return fallback;
}

const DATE_FIELDS = [
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
  'publishedAt',
];

function formatArticleDate(article) {
  const raw = firstField(article, DATE_FIELDS, null);
  if (!raw) return null;
  try {
    const d = raw?.toDate ? raw.toDate() : new Date(raw);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return null;
  }
}

// Pick the imageUrl from the first non-empty source, then surface the
// matching responsive variants from the same source (F9 — see
// Firebase-GCP-Cost-Inventory.md). Falls back to null variants when
// the chosen source doesn't have them, in which case the consumer
// renders the plain PNG.
// `pickPublicImageUrl`, not a `||` chain: a feed-supplied video in
// `contentImageUrl` is skipped rather than rendered into an `<img>` and
// rather than shadowing a real cover behind it (issue #374).
function resolveImage(article) {
  const imageUrl = pickPublicImageUrl(
    article.contentImageUrl,
    article.heroImageUrl,
    article.altCoverImage,
    article.imageUrl
  );
  let imageVariants = null;
  if (imageUrl === article.altCoverImage && article.altCoverImageVariants) {
    imageVariants = article.altCoverImageVariants;
  } else if (article.aiImageVariants?.hero && imageUrl === article.aiImageUrls?.hero) {
    imageVariants = article.aiImageVariants.hero;
  }
  return { imageUrl, imageVariants };
}

function firstTag(tags) {
  return Array.isArray(tags) ? tags[0] : null;
}

// Normalize field names across blogs/content documents
export function normalizeArticle(article) {
  if (!article) return null;
  const tags = firstField(article, ['Tags', 'tags', 'keyTopics'], []);
  const { imageUrl, imageVariants } = resolveImage(article);
  return {
    // Coder Corner: the fields the publish contract requires but nothing
    // rendered (components/shared/CoderCornerSnippet.jsx).
    codeSnippet: firstField(article, ['codeSnippet', 'code', 'terraformCode'], ''),
    language: firstField(article, ['language', 'codeLanguage'], ''),
    repoUrl: article.repoUrl || null,
    title: firstField(article, ['Title', 'title'], 'Untitled'),
    summary: firstField(article, ['Summary', 'summary', 'description', 'excerpt'], ''),
    // Body: prefer editor draft → raw content → summary fallback
    body: firstField(article, ['blogDraft', 'Content', 'content'], ''),
    imageUrl,
    imageVariants,
    category: firstField(article, ['category', 'Category'], null) || firstTag(tags) || 'General',
    tags: Array.isArray(tags) ? tags : [],
    author: firstField(
      article,
      ['editorAuthor', 'siteAuthor', 'publishedByName', 'createdByName'],
      'Hybrid Cloud Works'
    ),
    date: formatArticleDate(article),
    readTime: firstField(article, ['readTime', 'ReadTime'], null),
    sourceUrl: firstField(article, ['sourceUrl', 'url', 'CD Url', 'Source URL'], null),
  };
}
