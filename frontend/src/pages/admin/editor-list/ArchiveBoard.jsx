/**
 * The Archive board under the Editor list: pages taken off the site, behind
 * a disclosure, with their own search, provider filter and sort. The state
 * is the board's alone, so it lives here rather than on the page (PR #841).
 *
 * TWO WAYS OUT OF THE ARCHIVE, BOTH EXPLICIT (AP-F13, #937). Archiving is the
 * first, reversible step of a delete — Live Pages' Archive lands here, with
 * Undo on its toast for ten seconds — so this board is where the second step
 * is taken: Restore to live (`archived → published`, the publisher's edge,
 * audited by the server) or Delete permanently, the one action with no way
 * back, behind the confirm dialog and the `deleteContentItem` RPC the Review
 * Queue's own delete uses.
 *
 * The board's rows are a read, and another session can move a page after
 * it. So Delete permanently names the status the row was read in, and the
 * server deletes only while the page is still archived, under that read's
 * ETag, and audits the delete itself; a page restored meanwhile answers 409,
 * and the row stays with the refusal shown. A restore here puts the page on
 * the live board above, so the page is asked to read that list again
 * (`onRestored`).
 */
import React, { useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ExternalLink as LinkIcon,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ConfirmModal from '@/components/admin/ConfirmModal';
import RoleGate from '@/components/admin/RoleGate';
import EmptyState from '@/components/admin/shared/EmptyState';
import { postJSON } from '@/lib/api';
import { toDate } from '@/lib/dateUtils';
import { safeUrl } from '@/lib/safeUrl';
import { PROVIDER_OPTIONS as ADMIN_PROVIDER_OPTIONS } from '@/config/admin';
import { useContentTransitions } from '@/pages/admin/queue/useContentTransitions';
import {
  ARCHIVED_STATUS,
  TYPE_BADGE,
  filterAndSortArchivedItems,
  getContentType,
  getProviderDisplay,
  getPublicUrl,
} from './editorItems';

// Every provider the site routes, from the registry (config/admin.js), so the
// filter cannot fall behind it again: VMware and Ansible were missing here.
// Matched by substring of the stored value, so the label's lower case works.
const PROVIDER_OPTIONS = ['All', ...ADMIN_PROVIDER_OPTIONS.map((option) => option.label)];

const SORT_OPTIONS = [
  { value: 'archivedAt', label: 'Archived Date' },
  { value: 'publishedAt', label: 'Published Date' },
  { value: 'provider', label: 'Technology' },
];

// ── Archive board row ─────────────────────────────────────────────────────────

/**
 * One archived page: its title, provider, type and dates, the public URL it
 * had, and the two ways out of the archive behind the publisher gate.
 */
function ArchiveRow({ item, busy, onRestore, onDelete }) {
  const publicUrl = getPublicUrl(item);
  const provider = getProviderDisplay(item);
  const type = getContentType(item);
  const archivedAt = toDate(item.archivedAt) || toDate(item.updatedAt);
  const publishedAt = toDate(item.blogPublishedAt);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors text-sm">
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate text-sm">{item.Title || item.title || 'Untitled'}</p>
        <div className="flex flex-wrap items-center gap-2 mt-0.5">
          <Badge variant="outline" className="text-[11px]">
            {provider}
          </Badge>
          <span
            className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${TYPE_BADGE[type] || TYPE_BADGE.blog}`}
          >
            {type}
          </span>
          {publishedAt && (
            <span className="text-xs text-muted-foreground">
              Published{' '}
              {new Intl.DateTimeFormat('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }).format(publishedAt)}
            </span>
          )}
          {archivedAt && (
            <span className="text-xs text-muted-foreground">
              · Archived{' '}
              {new Intl.DateTimeFormat('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }).format(archivedAt)}
            </span>
          )}
        </div>
      </div>
      {publicUrl && (
        <a
          href={safeUrl(publicUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-blue-500 hover:underline shrink-0"
        >
          <LinkIcon className="h-3.5 w-3.5" />
          View
        </a>
      )}
      <Badge variant="secondary" className="text-[10px] shrink-0">
        archived
      </Badge>
      {/* Both ways out are a publisher's: Restore to live is the edge into
          published, Delete permanently the publisher RPC deleteContentItem.
          One gate, so the row reads the reason once (AP-F4). */}
      <RoleGate
        minRole="publisher"
        reason="Restoring or deleting an archived page needs the publisher role."
        className="shrink-0"
      >
        <Button
          size="sm"
          variant="outline"
          className="gap-1 text-xs shrink-0"
          disabled={busy}
          onClick={() => onRestore(item)}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          Restore to live
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-xs shrink-0 text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => onDelete(item)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete permanently
        </Button>
      </RoleGate>
    </div>
  );
}

/** The chevron beside the active sort, pointing the way it sorts. */
function SortChevron({ active, dir }) {
  if (!active) return null;
  return dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
}

/** Search, provider filter and the sort buttons above the rows. */
function ArchiveControls({
  search,
  onSearch,
  providerFilter,
  onProviderFilter,
  sortField,
  sortDir,
  onToggleSort,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-45">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search archive…"
          className="pl-9 h-8 text-sm"
        />
      </div>
      <div className="flex gap-1 flex-wrap">
        {PROVIDER_OPTIONS.map((p) => (
          <button
            key={p}
            onClick={() => onProviderFilter(p)}
            className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
              providerFilter === p
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-1 ml-auto">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onToggleSort(opt.value)}
            className={`flex items-center gap-0.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
              sortField === opt.value
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {opt.label}
            <SortChevron active={sortField === opt.value} dir={sortDir} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The rows, the spinner while they load, or the empty state. */
function ArchiveContent({ loading, items, filtered, busyId, onRestore, onDelete }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        variant={filtered ? 'filtered' : 'empty'}
        title={filtered ? 'No archived items match your filters.' : 'No archived content yet.'}
        description="Archive a live item from its row above, or from Live Pages, and it is listed here."
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <ArchiveRow
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

/**
 * The Archive board (see the header): archived pages behind a disclosure, with
 * their own search, provider filter and sort, and Restore to live and Delete
 * permanently on each.
 */
export default function ArchiveBoard({ archivedList, loading, onRestored }) {
  const [archiveSearch, setArchiveSearch] = useState('');
  const [archiveProviderFilter, setArchiveProviderFilter] = useState('All');
  const [archiveSortField, setArchiveSortField] = useState('archivedAt');
  const [archiveSortDir, setArchiveSortDir] = useState('desc');
  const [showArchive, setShowArchive] = useState(false);

  // Rows restored or deleted since the list was read leave without a refetch.
  const [goneIds, setGoneIds] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingId, setDeletingId] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const transitions = useContentTransitions();
  const busyId =
    deletingId || Object.keys(transitions.loading).find((id) => transitions.loading[id]) || '';
  const actionError = deleteError || Object.values(transitions.errors).find(Boolean) || '';

  /**
   * Put an archived page back on the site; the row leaves the board, and the
   * page is asked to read its live list again.
   */
  const restore = async (item) => {
    const result = await transitions.transition(item, 'published', {
      markLive: true,
      reviewNotes: 'Restored to live from the Archive board',
      label: 'Restore',
    });
    if (!result) return;
    setGoneIds((prev) => ({ ...prev, [item.id]: true }));
    // Back on the site, so on the live board, which was read before this.
    onRestored?.(item);
  };

  /**
   * Delete the confirmed page for good, only while it is still archived
   * (expectedStatus), keeping the row and the server's sentence when it
   * refuses.
   */
  const deletePermanently = async () => {
    const item = deleteTarget;
    setDeleteTarget(null);
    if (!item) return;
    setDeleteError('');
    setDeletingId(item.id);
    try {
      // Only while it is still archived: the server refuses with 409 a page
      // another session restored (or moved) since this list was read.
      await postJSON('deleteContentItem', { contentId: item.id, expectedStatus: ARCHIVED_STATUS });
      setGoneIds((prev) => ({ ...prev, [item.id]: true }));
    } catch (err) {
      // A 409 is the server's own sentence: what changed, and that nothing
      // was deleted.
      setDeleteError(
        err?.status === 409 && err.message
          ? err.message
          : `Delete failed: ${err?.message || 'Unknown error'}`
      );
    } finally {
      setDeletingId('');
    }
  };

  const listed = useMemo(
    () => archivedList.filter((item) => !goneIds[item.id]),
    [archivedList, goneIds]
  );

  // Filtered + sorted archive items
  const filteredArchive = useMemo(() => {
    return filterAndSortArchivedItems(
      listed,
      archiveProviderFilter,
      archiveSearch,
      archiveSortField,
      archiveSortDir
    );
  }, [listed, archiveSearch, archiveProviderFilter, archiveSortField, archiveSortDir]);

  /** Sort by `field`: the same field again flips the direction, a new one starts newest first. */
  function toggleSort(field) {
    if (archiveSortField === field) {
      setArchiveSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setArchiveSortField(field);
      setArchiveSortDir('desc');
    }
  }

  const filtered = Boolean(archiveSearch) || archiveProviderFilter !== 'All';

  return (
    <section>
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setShowArchive((v) => !v)}
      >
        <Archive className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold tracking-tight">Archive ({listed.length})</h2>
        {showArchive ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground ml-auto" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" />
        )}
      </button>

      {showArchive && (
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Archived articles — off the site, kept. Restore to live puts one back as it was;
              Delete permanently removes it for good. Sorted by{' '}
              {SORT_OPTIONS.find((o) => o.value === archiveSortField)?.label}.
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ArchiveControls
              search={archiveSearch}
              onSearch={setArchiveSearch}
              providerFilter={archiveProviderFilter}
              onProviderFilter={setArchiveProviderFilter}
              sortField={archiveSortField}
              sortDir={archiveSortDir}
              onToggleSort={toggleSort}
            />

            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}

            <ArchiveContent
              loading={loading}
              items={filteredArchive}
              filtered={filtered}
              busyId={busyId}
              onRestore={restore}
              onDelete={setDeleteTarget}
            />
          </CardContent>
        </Card>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete this page permanently?"
        description="This removes the record and its live URL for good, and nothing brings it back. To put it back on the site instead, choose Restore to live."
        confirmLabel="Delete permanently"
        onConfirm={deletePermanently}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
