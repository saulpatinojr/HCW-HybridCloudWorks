import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePublicData } from '@/hooks/usePublicData';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getCoverImageUrl, formatPostDate } from '@/lib/blogUtils';
import { toDate } from '@/lib/dateUtils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getJSON } from '@/lib/api';
import { safeUrl } from '@/lib/safeUrl';
import { useContentTransitions } from './queue/useContentTransitions';
import ArchiveBoard from './editor-list/ArchiveBoard';
import {
  TYPE_BADGE,
  filterAndSortDraftItems,
  filterAndSortLiveItems,
  getContentType,
  getProviderDisplay,
  getPublicUrl,
} from './editor-list/editorItems';
import {
  PenLine,
  ExternalLink,
  Search,
  Loader2,
  Archive,
  EyeOff,
  Clock3,
  PenTool,
} from 'lucide-react';

/**
 * The server's list ceiling (functions/src/lib/cms-content.js LIST_MAX_LIMIT).
 * A board that comes back exactly this long was cut, and says so (AP-F6,
 * #930); before that the cut was silent and the search ran over the part
 * that arrived.
 */
export const LIST_PAGE = 500;

const EDITOR_HELP = [
  'What arrives here: items approved in the Review Queue, forge output graded as Forge ready, and anything the inspector marked Needs rework.',
  'Pre-live drafts are the work: open one to edit its text, metadata, images and publish date. Live items are listed below them so a published page can be edited too.',
  'What to do: Edit opens the editor; Send to Publish from inside it moves the item to the Publish page. Unpublish or Archive a live item from its row.',
  'Where it goes next: the Publish page for anything not yet live; the Archive board, below, for pages taken down for good.',
];

// ── Live item row ─────────────────────────────────────────────────────────────

function LiveItemRow({ item, onArchive, onUnpublish, actionId }) {
  const coverUrl = getCoverImageUrl(item);
  const type = getContentType(item);
  const publicUrl = getPublicUrl(item);
  const provider = getProviderDisplay(item);
  const title = item.Title || item.title || 'Untitled';
  const isActing = actionId === item.id;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors">
      {coverUrl ? (
        <img
          src={safeUrl(coverUrl)}
          alt=""
          className="h-12 w-16 object-cover rounded shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="h-12 w-16 rounded bg-muted shrink-0 flex items-center justify-center">
          <PenLine className="h-4 w-4 text-muted-foreground" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <StatusBadge content={item} size="xs" />
          <Badge variant="outline" className="text-xs">
            {provider}
          </Badge>
          <span
            className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${TYPE_BADGE[type] || TYPE_BADGE.blog}`}
          >
            {type}
          </span>
          <TaxonomyChips item={item} />
          <span className="text-xs text-muted-foreground">
            {formatPostDate(item.blogPublishedAt)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {publicUrl && (
          <a
            href={safeUrl(publicUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="View live page"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <Link
          to={`/admin/editor/${item.id}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium transition-colors"
        >
          <PenLine className="h-3.5 w-3.5" />
          Edit
        </Link>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 text-xs"
          disabled={isActing}
          onClick={() => onUnpublish(item)}
          title="Unpublish — removes from live site and returns to Publish queue"
        >
          {isActing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
          Unpublish
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-xs text-muted-foreground hover:text-foreground"
          disabled={isActing}
          onClick={() => onArchive(item)}
          title="Archive — move to archive board"
        >
          {isActing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
          Archive
        </Button>
      </div>
    </div>
  );
}

function DraftItemRow({ item }) {
  const type = getContentType(item);
  const provider = getProviderDisplay(item);
  const title = item.Title || item.title || 'Untitled';
  const updatedAt = toDate(item.updatedAt) || toDate(item.blogEditedAt);

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <Badge variant="outline" className="text-xs">
            {provider}
          </Badge>
          <span
            className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${TYPE_BADGE[type] || TYPE_BADGE.blog}`}
          >
            {type}
          </span>
          <StatusBadge content={item} size="xs" />
          <TaxonomyChips item={item} />
          {updatedAt && (
            <span className="text-xs text-muted-foreground">
              Updated{' '}
              {new Intl.DateTimeFormat('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }).format(updatedAt)}
            </span>
          )}
        </div>
      </div>

      <Link
        to={`/admin/editor/${item.id}`}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium transition-colors"
      >
        <PenLine className="h-3.5 w-3.5" />
        Edit
      </Link>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EditorListPage() {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();

  const listContent = (qs) => getJSON(`cms/content?${qs}`).then((res) => res.items || []);
  // Retry re-keys the three reads; usePublicData fetches again on a new key.
  const [attempt, setAttempt] = useState(0);
  const {
    data: liveItems,
    loading: liveLoading,
    error: liveError,
  } = usePublicData(
    () => listContent(`live=true&limit=${LIST_PAGE}`),
    authReady ? `editor:live:${attempt}` : ''
  );
  const {
    data: archivedItems,
    loading: archiveLoading,
    error: archiveError,
  } = usePublicData(
    () => listContent(`status=archived&limit=${LIST_PAGE}`),
    authReady ? `editor:archived:${attempt}` : ''
  );
  const {
    data: draftItems,
    loading: draftLoading,
    error: draftError,
  } = usePublicData(
    () => listContent(`status=editing,approved,forge_ready,needs_rework&limit=${LIST_PAGE}`),
    authReady ? `editor:drafts:${attempt}` : ''
  );

  const loading = liveLoading || archiveLoading || draftLoading;
  // The hooks' errors were read by nobody: a 401 or a 5xx rendered as "No
  // items match your filters" (AP-F6, #930).
  const loadError = liveError || draftError || archiveError;
  const liveList = useMemo(() => liveItems ?? [], [liveItems]);
  const draftList = useMemo(() => draftItems ?? [], [draftItems]);
  const archivedList = useMemo(() => archivedItems ?? [], [archivedItems]);
  const truncated = [liveList, draftList, archivedList].some((list) => list.length >= LIST_PAGE);

  // Live board state
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Action state
  const [actionId, setActionId] = useState('');
  const [localActionError, setActionError] = useState('');
  const [unpublishTarget, setUnpublishTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  // Archive and unpublish through the shared transitions (ADR 0033 §2); the
  // server records both, so no client audit row is written here.
  const transitions = useContentTransitions();
  const actionError = localActionError || Object.values(transitions.errors).find(Boolean) || '';

  // Live counts
  const counts = useMemo(() => {
    const c = { blog: 0, framework: 0, architecture: 0, coder_corner: 0, news: 0 };
    liveList.forEach((item) => {
      const t = getContentType(item);
      c[t] = (c[t] || 0) + 1;
    });
    return c;
  }, [liveList]);

  // Filtered live items
  const filteredLive = useMemo(() => {
    return filterAndSortLiveItems(liveList, typeFilter, search);
  }, [liveList, search, typeFilter]);

  const filteredDrafts = useMemo(() => {
    return filterAndSortDraftItems(draftList, typeFilter, search);
  }, [draftList, search, typeFilter]);

  const TYPE_TABS = [
    { key: 'all', label: `All (${liveList.length})` },
    { key: 'blog', label: `Blogs (${counts.blog})` },
    { key: 'framework', label: `Frameworks (${counts.framework})` },
    { key: 'architecture', label: `Architecture (${counts.architecture})` },
    { key: 'coder_corner', label: `Code (${counts.coder_corner})` },
    { key: 'news', label: `News / RSS (${counts.news})` },
  ];

  // ── Actions ──────────────────────────────────────────────────────────────

  const doUnpublish = async (item) => {
    setActionError('');
    setActionId(item.id);
    const currentStatus = item.contentStatus || '';
    const result = await transitions.recall(item.id, {
      currentStatus,
      reviewNotes: `Unpublished from Editor board (was ${currentStatus || 'unknown'}) - returned to review queue`,
    });
    setActionId('');
    if (result) navigate('/admin/queue');
  };

  const doArchive = async (item) => {
    setActionError('');
    setActionId(item.id);
    await transitions.transition(item, 'archived', {
      markLive: false,
      reviewNotes: 'Archived from Editor board',
      label: 'Archive',
    });
    setActionId('');
  };

  function renderLiveBoardSection() {
    return (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-50">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or provider…"
              className="pl-9"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {TYPE_TABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTypeFilter(key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  typeFilter === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {!loading && filteredDrafts.length > 0 && (
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock3 className="h-4 w-4" />
                Pre-Live Drafts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {filteredDrafts.map((item) => (
                <DraftItemRow key={item.id} item={item} />
              ))}
            </CardContent>
          </Card>
        )}

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && loadError && (
          <EmptyState
            variant="error"
            title="The editor lists could not be loaded"
            description={loadError.message || 'The request failed.'}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}

        {!loading && !loadError && truncated && (
          <p
            role="status"
            className="mb-0 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
          >
            The first {LIST_PAGE} items of a board are shown. Anything older is not in this list or
            its search.
          </p>
        )}

        {!loading && !loadError && filteredLive.length === 0 && (
          <EmptyState
            variant={search || typeFilter !== 'all' ? 'filtered' : 'empty'}
            title={
              search || typeFilter !== 'all'
                ? 'No items match your filters.'
                : 'No live published content found.'
            }
            description="Live pages appear here once something is published from the Publish page."
          />
        )}

        {!loading && filteredLive.length > 0 && (
          <div className="space-y-2">
            {filteredLive.map((item) => (
              <LiveItemRow
                key={item.id}
                item={item}
                actionId={actionId}
                onUnpublish={(i) => setUnpublishTarget(i)}
                onArchive={(i) => setArchiveTarget(i)}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={PenTool}
        title="Editor"
        help={EDITOR_HELP}
        status={
          <span className="text-muted-foreground">
            {loading
              ? 'Loading…'
              : `${filteredDrafts.length} pre-live drafts and ${liveList.length} live published items`}
          </span>
        }
      >
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </PageHeader>

      {renderLiveBoardSection()}
      <ArchiveBoard archivedList={archivedList} loading={archiveLoading} />

      {/* ── Confirm modals ── */}
      <ConfirmModal
        open={Boolean(unpublishTarget)}
        title="Unpublish this article?"
        description="This removes it from the live site and sitemap, and returns it to the Publish queue where it can be edited or rejected."
        confirmLabel="Unpublish"
        onConfirm={() => {
          const item = unpublishTarget;
          setUnpublishTarget(null);
          doUnpublish(item);
        }}
        onCancel={() => setUnpublishTarget(null)}
      />
      <ConfirmModal
        open={Boolean(archiveTarget)}
        title="Archive this article?"
        description="This removes it from the live site and moves it to the Archive board. It won't appear in the publish queue."
        confirmLabel="Archive"
        onConfirm={() => {
          const item = archiveTarget;
          setArchiveTarget(null);
          doArchive(item);
        }}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
}
