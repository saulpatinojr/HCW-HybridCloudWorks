import React, { useMemo, useState } from 'react';
import { Globe, Search } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import { getJSON } from '@/lib/api';
import { selectLiveItems } from './livePages/liveItems';
import LivePageRow from './livePages/LivePageRow';
import { useLivePageArchive } from './livePages/useLivePageArchive';

const LIVE_PAGES_HELP = [
  'What is here: every page visitors can open right now — the records whose Live flag is set, with the URL the site serves them at.',
  'Nothing is drafted or approved here; this is the end of the pipeline. Open Editor to change a page, Open Live Page to see it as a visitor does.',
  'Archive takes the page off the site at once and lists it on the Editor page’s Archive board; the toast offers Undo for ten seconds. After that, Restore to live and Delete permanently are on the Archive board. Archive, Undo and Restore need the publisher role: taking a page off the site, or putting it back, is a publisher’s action. Archive works on a published or rejected page; a live page in another status, such as Editing, is moved on from the Editor first.',
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

/**
 * The Live Pages page: every page the site serves, newest first, each with Open
 * Editor, Archive (a publisher's, with ten seconds of Undo) and Open Live Page.
 */
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
  const { archivingId, archiveError, locallyArchivedKeys, archiveLivePage, archiveBlockedReason } =
    useLivePageArchive();
  const loading = contentLoading || (includeLegacyPages && blogsLoading);

  const liveItems = useMemo(
    () =>
      selectLiveItems({
        contentItems,
        blogItems,
        includeLegacyPages,
        locallyDeletedKeys: locallyArchivedKeys,
        query,
      }),
    [blogItems, contentItems, includeLegacyPages, locallyArchivedKeys, query]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
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
          {archiveError && (
            <p role="alert" className="mt-2 text-xs text-red-500">
              {archiveError}
            </p>
          )}
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
                archiving={archivingId === item.id}
                archiveBlockedReason={archiveBlockedReason(item)}
                onArchive={archiveLivePage}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
