/**
 * How Live Pages describes, selects and deletes a live record — pure
 * functions out of LivePagesPage.jsx so the page is a composition root with
 * one return (PR #841).
 */
import { getCanonicalContentType } from '@/lib/contentModel';
import { toMillis } from '@/lib/dateUtils';
import { getLiveUrl, isLiveRecord } from '@/lib/livePages';

export function getProvider(item) {
  return item['Cloud Provider'] || item.cloudProvider || item.provider || 'Unknown';
}

export function getTitle(item) {
  return item.Title || item.title || 'Untitled';
}

const TYPE_LABELS = {
  framework: 'Framework',
  architecture: 'Architecture',
  coder_corner: 'Coder Corner',
  news: 'News',
  blog: 'Blog',
};

export function getTypeLabel(item) {
  return TYPE_LABELS[getCanonicalContentType(item)] || 'Blog';
}

export function getRecencyScore(item) {
  return Math.max(
    toMillis(item?.publishedDate),
    toMillis(item?.datePublished),
    toMillis(item?.['Published At']),
    toMillis(item?.blogPublishedAt),
    toMillis(item?.publishedAt),
    toMillis(item?.updatedAt),
    toMillis(item?.createdAt)
  );
}

/** The editor opens the source record when the live one carries a pointer to it. */
export function editorTargetId(item) {
  return [item.sourceContentId, item.publishedContentId, item.id].find(Boolean) ?? '';
}

/** The live URL as a dedupe key: trimmed and lower-cased, '' when the record has none. */
export function liveUrlKey(item) {
  return String(getLiveUrl(item) || '')
    .trim()
    .toLowerCase();
}

/** Whether a record belongs on the page at all: live, with a URL, and not deleted here since load. */
function isShowable(item, locallyDeletedKeys) {
  return isLiveRecord(item) && Boolean(getLiveUrl(item)) && !locallyDeletedKeys[liveUrlKey(item)];
}

function matchesQuery(item, normalizedQuery) {
  return [getTitle(item), getProvider(item), getTypeLabel(item), getLiveUrl(item)]
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery);
}

/**
 * The rows the page lists: content records plus, when asked, the legacy
 * blogs; only live records with a URL; one row per URL; those matching the
 * search; newest first.
 */
export function selectLiveItems({
  contentItems,
  blogItems,
  includeLegacyPages,
  locallyDeletedKeys,
  query,
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const mergedItems = [
    ...(contentItems || []).map((item) => ({ ...item, __source: 'content' })),
    ...(includeLegacyPages
      ? (blogItems || []).map((item) => ({ ...item, __source: 'blogs' }))
      : []),
  ];

  const seen = new Set();
  const deduped = mergedItems.filter((item) => {
    if (!isShowable(item, locallyDeletedKeys)) return false;
    const key = liveUrlKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .filter((item) => !normalizedQuery || matchesQuery(item, normalizedQuery))
    .sort((a, b) => getRecencyScore(b) - getRecencyScore(a));
}
