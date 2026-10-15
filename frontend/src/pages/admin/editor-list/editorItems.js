/**
 * How the Editor list reads an item — its type, provider and public URL —
 * and the filters and sorts its boards apply. Shared by EditorListPage and
 * its Archive board (PR #841 split).
 */
import { byNewest } from '@/lib/dateUtils';
import { getLiveUrl } from '@/lib/livePages';
import { getCanonicalContentType } from '@/lib/contentModel';

/**
 * The status the Archive board lists, and the one Live Pages' Archive moves
 * a page into (AP-F13, #937): one name, so "deleting a live page moves it to
 * the Archive board" is the same word on both sides.
 */
export const ARCHIVED_STATUS = 'archived';

export function getContentType(item) {
  return getCanonicalContentType(item);
}

/** The one live-URL rule every surface shares (lib/livePages.js, ADR 0033 §2). */
export const getPublicUrl = (item) => getLiveUrl(item) || null;

export function getProviderDisplay(item) {
  return item['Cloud Provider'] || item.cloudProvider || '—';
}

export const TYPE_BADGE = {
  blog: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
  framework: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300',
  architecture: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  coder_corner: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  news: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
};

export function matchesProviderFilter(item, providerFilter) {
  if (providerFilter === 'All') return true;
  const raw = (item['Cloud Provider'] || item.cloudProvider || '').toLowerCase();
  return raw.includes(providerFilter.toLowerCase());
}

export function matchesItemSearch(item, queryText) {
  const query = queryText.trim().toLowerCase();
  if (!query) return true;
  const title = String(item.Title || item.title || '').toLowerCase();
  const provider = String(item['Cloud Provider'] || item.cloudProvider || '').toLowerCase();
  return title.includes(query) || provider.includes(query);
}

export function filterByType(items, typeFilter) {
  if (typeFilter === 'all') return items;
  return items.filter((item) => getContentType(item) === typeFilter);
}

// Every comparator in this file was timestamp-object-only, so against the ISO strings
// Cosmos returns each scored 0 and the sorts were permanent no-ops — the lists
// rendered in raw Cosmos order while the controls appeared to work
// (T-304).
const sortByPublishedDateDesc = byNewest('blogPublishedAt');
const sortByUpdatedDateDesc = byNewest('updatedAt', 'blogEditedAt');

export function filterAndSortLiveItems(items, typeFilter, searchText) {
  const byType = filterByType(items, typeFilter);
  const bySearch = byType.filter((item) => matchesItemSearch(item, searchText));
  return [...bySearch].sort(sortByPublishedDateDesc);
}

export function filterAndSortDraftItems(items, typeFilter, searchText) {
  const notLive = items.filter((item) => item.Live !== true);
  const byType = filterByType(notLive, typeFilter);
  const bySearch = byType.filter((item) => matchesItemSearch(item, searchText));
  return [...bySearch].sort(sortByUpdatedDateDesc);
}

const ARCHIVE_SORT_COMPARE = {
  // `archivedAt` and `updatedAt` were byte-identical before, so the two menu
  // entries did the same thing even once the comparator worked. Kept distinct
  // now, which is what the labels promise.
  archivedAt: byNewest('archivedAt', 'updatedAt'),
  updatedAt: byNewest('updatedAt'),
  publishedAt: byNewest('blogPublishedAt'),
  provider: (a, b) => getProviderDisplay(a).localeCompare(getProviderDisplay(b)),
};

function compareArchivedItems(a, b, archiveSortField, archiveSortDir) {
  const compare = ARCHIVE_SORT_COMPARE[archiveSortField];
  if (!compare) return 0;
  const dir = archiveSortDir === 'asc' ? 1 : -1;
  return compare(a, b) * dir;
}

export function filterAndSortArchivedItems(
  items,
  archiveProviderFilter,
  archiveSearch,
  archiveSortField,
  archiveSortDir
) {
  const byProvider =
    archiveProviderFilter === 'All'
      ? items
      : items.filter((item) => matchesProviderFilter(item, archiveProviderFilter));
  const query = archiveSearch.trim().toLowerCase();
  const bySearch =
    query.length === 0
      ? byProvider
      : byProvider.filter((item) =>
          String(item.Title || item.title || '')
            .toLowerCase()
            .includes(query)
        );
  return [...bySearch].sort((a, b) => compareArchivedItems(a, b, archiveSortField, archiveSortDir));
}
