/**
 * Pure helpers for the review queue: how an item is described, ordered, badged,
 * and what a destructive confirmation says.
 *
 * Split out of QueuePage.jsx (T-412), which had grown to 1,310 lines
 * with the page's riskiest code — the bulk transitions — buried in the middle
 * of it. Everything here is a pure function of one item (or of the confirm
 * target), so it is testable without rendering a card, which is the point.
 *
 * `.jsx` rather than `.js`: the badge helpers return elements.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { ADMIN_ROUTES } from '@/config/admin';
import { toDate, toMillis } from '@/lib/dateUtils';

export function getReviewPath(contentId) {
  return `${ADMIN_ROUTES.REVIEW.replace(':id', contentId)}?source=content`;
}

const toDateMaybe = toDate;

export function formatPublishedDate(item) {
  const published =
    item?.publishedAt ||
    item?.blogPublishedAt ||
    item?.['Published At'] ||
    item?.publishedDate ||
    item?.datePublished ||
    item?.pubDate;
  const publishedDate = toDateMaybe(published);
  if (publishedDate) {
    return {
      label: publishedDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      isFallback: false,
    };
  }
  const fallback = item?.fetchedAt || item?.createdAt;
  const fallbackDate = toDateMaybe(fallback);
  if (fallbackDate) {
    return {
      label: `Fetched ${fallbackDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })}`,
      isFallback: true,
    };
  }
  return null;
}

export function getRootDomain(item) {
  const url = item?.sourceUrl || item?.url || item?.link;
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export function getEditorPath(contentId) {
  return ADMIN_ROUTES.EDITOR.replace(':id', contentId);
}

// Sort options for the queue toolbar. The default is `published_desc` —
// newest published article first, falling back to fetched date when an
// item lacks a publish date. Each entry's `compare` returns the standard
// negative/positive/zero for ascending order; the toolbar negates the
// result for descending.
export function getPublishedMs(item) {
  const v =
    item?.publishedAt ||
    item?.blogPublishedAt ||
    item?.['Published At'] ||
    item?.publishedDate ||
    item?.datePublished ||
    item?.pubDate;
  return toMillis(v) || null;
}

export function getIngestedMs(item) {
  return toMillis(item?.fetchedAt) || toMillis(item?.createdAt);
}

export function getRootDomainForSort(item) {
  const url = item?.sourceUrl || item?.url || item?.link || '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const SORT_OPTIONS = {
  published: {
    label: 'Published date',
    compare: (a, b) => {
      const aMs = getPublishedMs(a);
      const bMs = getPublishedMs(b);
      // Items without a published date sort to the bottom of asc order
      // (so they land at the top in desc), matching the existing fallback
      // behavior in formatPublishedDate.
      if (aMs === null && bMs === null) return getIngestedMs(a) - getIngestedMs(b);
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      return aMs - bMs;
    },
  },
  ingested: {
    label: 'Ingested date',
    compare: (a, b) => getIngestedMs(a) - getIngestedMs(b),
  },
  domain: {
    label: 'Source domain',
    compare: (a, b) => getRootDomainForSort(a).localeCompare(getRootDomainForSort(b)),
  },
  title: {
    label: 'Title',
    compare: (a, b) =>
      String(a?.Title || a?.title || '').localeCompare(String(b?.Title || b?.title || '')),
  },
  grade: {
    label: 'Forge grade',
    // Ungraded items take a -1 sentinel (grades are 0-100), so descending —
    // the natural direction for "best staged first" — puts them last.
    compare: (a, b) => getForgeGradeForSort(a) - getForgeGradeForSort(b),
  },
};

export function getForgeGradeForSort(item) {
  const overall = item?.forgeGrade?.overall;
  return typeof overall === 'number' ? overall : -1;
}

/**
 * Forged-so-far today from getForgeConfig's stats.today rolling day bucket
 * (UTC date key, written by forge.js). A stale bucket — yesterday's date —
 * reads as zero, matching the backend's own reset-on-rollover.
 */
export function forgedTodayFromStats(stats, nowDate = new Date()) {
  const todayKey = nowDate.toISOString().slice(0, 10);
  return stats?.today?.date === todayKey ? Number(stats.today.forged) || 0 : 0;
}

export function sortQueueItemsBy(items, sortKey, direction) {
  const opt = SORT_OPTIONS[sortKey] || SORT_OPTIONS.published;
  const factor = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => factor * opt.compare(a, b));
}

// Default sort retained for the initial fetch: published date, descending.
export function sortQueueItems(a, b) {
  return -SORT_OPTIONS.published.compare(a, b);
}

// Decay badge for rejected / soft-deleted items. Two phases:
//   1. contentStatus === 'rejected' and no softDeletedAt yet → counting down
//      to the 04:00 CT cron that will set softDeletedAt. (~0-24h.)
//   2. softDeletedAt is set → counting down to permanent removal by the
//      hourly soft-delete reaper (7-day window from softDeletedAt).
// Returns null for any item not in those states.
const SOFT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REJECTION_GRACE_MS = 24 * 60 * 60 * 1000;

export function formatRemaining(ms) {
  if (ms <= 0) return 'imminent';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)));
  return `${minutes}m`;
}

export function getDecayBadge(item) {
  if (!item) return null;
  const now = Date.now();

  const softDeletedAt = toDate(item.softDeletedAt);
  if (softDeletedAt) {
    const remaining = SOFT_DELETE_GRACE_MS - (now - softDeletedAt.getTime());
    return (
      <Badge
        variant="outline"
        className="text-xs font-mono border-amber-400 text-amber-700 dark:border-amber-500 dark:text-amber-300"
        title="Soft-deleted. Will be permanently removed when this counter reaches zero."
      >
        purges in {formatRemaining(remaining)}
      </Badge>
    );
  }

  if (item.contentStatus === 'rejected') {
    const rejectedAt = toDate(item.rejectedAt) || toDate(item.reviewedAt) || toDate(item.updatedAt);
    if (!rejectedAt) return null;
    const remaining = REJECTION_GRACE_MS - (now - rejectedAt.getTime());
    return (
      <Badge
        variant="outline"
        className="text-xs font-mono border-orange-400 text-orange-700 dark:border-orange-500 dark:text-orange-300"
        title="Rejected. Will be moved to soft-delete (7-day recovery) at the next 04:00 CT cron run."
      >
        soft-delete in {formatRemaining(remaining)}
      </Badge>
    );
  }

  return null;
}

export function getSourceBadge(item) {
  if (item.source === 'rss') {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wide">
        RSS
      </Badge>
    );
  }

  if (item.source === 'manual_url') {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wide">
        Manual URL
      </Badge>
    );
  }

  if (item.source === 'forge-url') {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wide">
        Forged URL
      </Badge>
    );
  }

  // Imported from docs/content by the queue's repository panel.
  if (item.source === 'repo') {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wide">
        Repository
      </Badge>
    );
  }

  return null;
}

/**
 * The forge pipeline's verdict on a card (Blog Machine T-603). The grade is
 * written by forge.js as forgeGrade.overall; forge_ready means it cleared
 * the publish threshold, anything else landed in editing.
 */
export function getForgeBadge(item) {
  const overall = item?.forgeGrade?.overall;
  if (typeof overall !== 'number') return null;
  const staged = item?.contentStatus === 'forge_ready';
  return (
    <Badge variant={staged ? 'default' : 'secondary'} className="text-xs uppercase tracking-wide">
      Forge {Math.round(overall)}
    </Badge>
  );
}

export function getConfirmModalCopy(confirmTarget) {
  if (confirmTarget?.type === 'reject') {
    return {
      title: 'Reject content?',
      description:
        'Rejected items remain recoverable for ~8 days (24h grace, then 7-day soft-delete window) before being permanently removed.',
      confirmLabel: 'Reject',
      destructive: true,
    };
  }

  if (confirmTarget?.type === 'bulkDelete') {
    return {
      title: 'Move all rejected items to soft-delete?',
      description:
        'All rejected items are marked for soft-delete now. They remain recoverable for 7 days, then are permanently removed. This batches what the nightly cron does automatically after 24h.',
      confirmLabel: 'Soft-Delete All',
      destructive: true,
    };
  }

  if (confirmTarget?.type === 'bulkReject') {
    const count = confirmTarget.ids?.length || 0;
    return {
      title: `Reject ${count} items?`,
      description: `These ${count} items will be marked rejected. Recoverable for ~8 days (24h grace, then 7-day soft-delete window) before permanent removal.`,
      confirmLabel: 'Reject All',
      destructive: true,
    };
  }

  if (confirmTarget?.type === 'deleteRejected') {
    return {
      title: 'Delete rejected content permanently?',
      description:
        'This removes the rejected item from the content store immediately. This cannot be undone — use soft-delete instead if you want a 7-day recovery window.',
      confirmLabel: 'Delete Permanently',
      destructive: true,
    };
  }

  return {
    title: 'Restore content?',
    description: 'This will return the content to the review queue.',
    confirmLabel: 'Restore',
    destructive: false,
  };
}

export function getHeroCacheBust(item) {
  if (typeof item.altCoverImage === 'string' && item.altCoverImage.includes('?t=')) {
    return item.altCoverImage.split('?t=')[1];
  }
  return null;
}

export function getQueueItemCoverUrl(baseCoverUrl, cacheBust) {
  if (!baseCoverUrl || !cacheBust) return baseCoverUrl;
  return `${baseCoverUrl}${baseCoverUrl.includes('?') ? '&' : '?'}t=${cacheBust}`;
}
