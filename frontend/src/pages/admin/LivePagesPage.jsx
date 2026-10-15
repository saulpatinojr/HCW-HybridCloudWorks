import React, { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Globe, Search, Trash2 } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getJSON } from '@/lib/api';
import { safeUrl } from '@/lib/safeUrl';
import { getLiveUrl } from '@/lib/livePages';
import {
  editorTargetId,
  getProvider,
  getTitle,
  getTypeLabel,
  selectLiveItems,
} from './livePages/liveItems';
import { useLivePageDeletion } from './livePages/useLivePageDeletion';

const LIVE_PAGES_HELP = [
  'What is here: every page visitors can open right now — the records whose Live flag is set, with the URL the site serves them at.',
  'Nothing is drafted or approved here; this is the end of the pipeline. Open Editor to change a page, Open Live Page to see it as a visitor does.',
  'Delete Live Page takes the page off the site immediately (the URL returns 404) and soft-deletes the record for 24 hours before cleanup.',
  'Legacy pages from the retired blogs collection can be included with the checkbox; they are read-only here.',
];

/**
 * The newest live pages, ordered on the server (ADR 0033 §1). The list route
 * used to answer 500 arbitrary documents of every status that were then
 * filtered here, so a live page could be missing while a hundred rejected
 * items were fetched for nothing. `live=true` filters and `sort=publishedAt`
 * orders newest first: every published document carries publishedAt.
 */
export const LIVE_PAGES_QUERY = 'cms/content?live=true&limit=500&sort=publishedAt';

/** One live page: its title, badges and URL, with Open Editor, Delete and Open Live Page. */
function LivePageRow({ item, deleting, onDelete }) {
  const liveUrl = getLiveUrl(item);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{getTitle(item)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge content={item} />
          <Badge variant="outline">{getProvider(item)}</Badge>
          <Badge variant="secondary">{getTypeLabel(item)}</Badge>
          <TaxonomyChips item={item} />
        </div>
        <a
          href={safeUrl(liveUrl, '#')}
          target={liveUrl ? '_blank' : undefined}
          rel={liveUrl ? 'noreferrer' : undefined}
          className={`mt-2 block truncate text-sm ${liveUrl ? 'text-blue-600 hover:underline' : 'text-muted-foreground'}`}
        >
          {liveUrl || 'Live URL unavailable on record'}
        </a>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to={`/admin/editor/${editorTargetId(item)}`}>Open Editor</Link>
        </Button>
        <Button size="sm" variant="destructive" onClick={() => onDelete(item)} disabled={deleting}>
          <Trash2 className="mr-2 h-4 w-4" />
          {deleting ? 'Deleting...' : 'Delete Live Page'}
        </Button>
        {liveUrl && (
          <Button size="sm" asChild>
            <a href={safeUrl(liveUrl)} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open Live Page
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

export default function LivePagesPage() {
  const { authReady } = useAuthReady();
  const [includeLegacyPages, setIncludeLegacyPages] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const {
    data: contentItems,
    loading: contentLoading,
    error: contentError,
  } = usePublicData(
    () => getJSON(LIVE_PAGES_QUERY).then((res) => res.items || []),
    authReady ? `live-pages:content:${attempt}` : ''
  );
  // Legacy blogs via the public list — this page only renders live records,
  // which is exactly the server-side public filter.
  const { data: blogItems, loading: blogsLoading } = usePublicData(
    () => fetchPublicContentList({ limit: 250, source: 'blogs' }),
    authReady && includeLegacyPages ? 'live-pages:legacy' : ''
  );
  const [query, setQuery] = useState('');
  const {
    deleteTarget,
    setDeleteTarget,
    deletingId,
    deleteError,
    locallyDeletedKeys,
    handleDeleteLivePage,
  } = useLivePageDeletion();
  const loading = contentLoading || (includeLegacyPages && blogsLoading);

  const liveItems = useMemo(
    () =>
      selectLiveItems({ contentItems, blogItems, includeLegacyPages, locallyDeletedKeys, query }),
    [blogItems, contentItems, includeLegacyPages, locallyDeletedKeys, query]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Live Pages"
        help={LIVE_PAGES_HELP}
        status={
          <span className="text-muted-foreground">
            Public pages only. Draft, staged, or unpublished items do not appear here.
          </span>
        }
      />

      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="live-pages-search" className="sr-only">
              Search live pages
            </label>
            <Input
              id="live-pages-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title, provider, type, or live URL"
              className="pl-9"
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeLegacyPages}
              onChange={(event) => setIncludeLegacyPages(event.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Include legacy `blogs` pages
          </label>
          <p className="mt-3 text-xs text-muted-foreground">
            {loading ? 'Loading live pages...' : `${liveItems.length} live pages found`}
          </p>
          {!includeLegacyPages && (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing `content` only by default. Enable legacy pages to include older `blogs`
              records.
            </p>
          )}
          {deleteError && <p className="mt-2 text-xs text-red-500">{deleteError}</p>}
        </CardContent>
      </Card>

      {loading && (
        <Card>
          <CardContent className="p-8 text-sm text-muted-foreground">
            Loading live pages...
          </CardContent>
        </Card>
      )}
      {!loading && contentError && (
        <EmptyState
          variant="error"
          title="Live pages could not be loaded"
          description={contentError.message || 'The request failed.'}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {!loading && !contentError && (contentItems ?? []).length >= 500 && (
        <p
          role="status"
          className="mb-0 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          The first 500 items are shown. Anything older is not in this list or its search.
        </p>
      )}
      {!loading && !contentError && liveItems.length === 0 && (
        <EmptyState
          variant={query ? 'filtered' : 'empty'}
          title={query ? 'No live pages match the current filter.' : 'Nothing is live yet.'}
          description="Pages published from the Publish page appear here with their public URL."
        />
      )}
      {!loading && liveItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Published URLs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {liveItems.map((item) => (
              <LivePageRow
                key={item.id}
                item={item}
                deleting={deletingId === item.id}
                onDelete={setDeleteTarget}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete live page?"
        description="This removes the page from the public site immediately so the URL returns 404. The underlying records are soft-deleted for 24 hours before permanent cleanup."
        confirmLabel="Delete Live Page"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteLivePage}
      />
    </div>
  );
}
