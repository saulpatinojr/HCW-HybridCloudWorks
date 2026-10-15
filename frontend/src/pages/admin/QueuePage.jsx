import React, { useState, useEffect, useMemo } from 'react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import RoleGate from '@/components/admin/RoleGate';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postJSON } from '@/lib/api';
import PageHeader from '@/components/admin/shared/PageHeader';
import TaxonomyPicker from '@/components/admin/shared/TaxonomyPicker';
import { useTaxonomy } from '@/components/admin/shared/useTaxonomy';
import { enabledEntries } from '@/lib/taxonomy';
import {
  formatPublishedDate,
  getConfirmModalCopy,
  getRootDomain,
  SORT_OPTIONS,
  sortQueueItemsBy,
} from './queue/itemHelpers';
import { QueueList } from './queue/QueueList';
import { CONTENT_TYPE_OPTIONS, STATUS_FILTERS } from './queue/constants';
import { useQueueActions } from './queue/useQueueActions';
import { useForgeMeter, useQueueSnapshot } from './queue/useQueueData';
import {
  buildQueueSearchParams,
  PAGE_SIZES,
  readPageSize,
  readSortDirection,
  readSortKey,
} from './queue/viewParams';
import {
  XCircle,
  RefreshCw,
  Loader2,
  Filter,
  Trash2,
  Flame,
  FilePen,
  ListChecks,
} from 'lucide-react';

/** What a first-time user needs to know about this page (ADR 0033 §7). */
const QUEUE_HELP = [
  'What arrives here: items from RSS feeds, Submit URLs, Forge from URL, the Recording Hub, and drafts sent to review from the Drafts page.',
  'Needs review is the default: Ingested items are raw, Inspected ones have been read by the AI inspector and carry a summary.',
  'What to do: open an item to read it, then Send to Publish (approve) or Reject. Select several and Forge or Reject them together.',
  'Kind and idea origin classify every item; set them here or on the review page so downstream tools (Listen & Learn, Social Hub, Newsletter) pick the right items.',
  'Where it goes next: approved items appear in the Editor for polishing, then on the Publish page. Rejected items decay and are purged unless restored.',
];

function isValidHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * "Forged today n/limit" against the autoForge daily budget (T-607). Renders
 * nothing until getForgeConfig has answered; the meter reads the same
 * forge_stats day bucket the scheduler's limit enforcement uses, so what the
 * page shows is exactly what the machine will honor.
 */
function ForgedTodayMeter({ meter }) {
  if (!meter) return null;
  const atLimit = meter.limit >= 1 && meter.forged >= meter.limit;
  return (
    <p className="text-xs mt-1">
      <span className={atLimit ? 'text-amber-500 font-medium' : 'text-muted-foreground'}>
        Forged today: {meter.forged}
        {meter.limit >= 1 ? `/${meter.limit}` : ''}
      </span>
      {!meter.enabled && <span className="text-muted-foreground"> · auto-forge off</span>}
    </p>
  );
}

/**
 * The unattended paste-a-URL entry point (Blog Machine T-602). Its own
 * component so the enqueue state lives with the form rather than adding four
 * more hooks to QueuePage. Fire-and-forget on purpose: the forge runs for
 * minutes under the job budget, so this enqueues and lets the result land
 * back in the queue as forge_ready or editing rather than holding the page.
 */
function ForgeFromUrlCard() {
  const [forgeUrl, setForgeUrl] = useState('');
  const [forgingUrl, setForgingUrl] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // The classification of what the forge will write (ADR 0033 §4). A pasted
  // URL is an imported source by definition; what it becomes is the owner's call.
  const [taxonomy, setTaxonomy] = useState({ kind: 'article', ideaOrigin: 'imported-source' });

  const handleSubmit = async (event) => {
    event.preventDefault();
    const url = forgeUrl.trim();
    setNotice('');
    if (!isValidHttpUrl(url)) {
      setError('Enter a valid http(s) article URL.');
      return;
    }
    setError('');
    setForgingUrl(true);
    try {
      const accepted = await postJSON('enqueueJob', {
        type: 'forge-from-url',
        payload: { url, kind: taxonomy.kind, ideaOrigin: taxonomy.ideaOrigin },
      });
      if (!accepted?.ok || !accepted.jobId) {
        throw new Error(accepted?.error || 'Job was not accepted');
      }
      setForgeUrl('');
      setNotice(
        `Forge queued (job ${accepted.jobId}). The scraped source and its forged draft land in this queue as forge_ready or editing — refresh in a few minutes.`
      );
    } catch (err) {
      setError(err?.message || 'Failed to queue the forge.');
    } finally {
      setForgingUrl(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSubmit}>
          <Label htmlFor="forge-from-url" className="flex items-center gap-1 whitespace-nowrap">
            <Flame className="h-4 w-4 text-primary" /> Forge from URL
          </Label>
          <Input
            id="forge-from-url"
            type="text"
            inputMode="url"
            placeholder="https://… paste an article to forge into a post"
            value={forgeUrl}
            onChange={(event) => setForgeUrl(event.target.value)}
            disabled={forgingUrl}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={forgingUrl || !forgeUrl.trim()}>
            {forgingUrl ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Forge'}
          </Button>
        </form>
        <TaxonomyPicker
          className="mt-3"
          compact
          kind={taxonomy.kind}
          ideaOrigin={taxonomy.ideaOrigin}
          onChange={setTaxonomy}
          disabled={forgingUrl}
        />
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        {notice && <p className="mt-2 text-sm text-muted-foreground">{notice}</p>}
      </CardContent>
    </Card>
  );
}

/** One labelled select over a taxonomy list, with "All" first. */
function TaxonomyFilterSelect({ id, label, value, entries, onChange }) {
  return (
    <div>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
      >
        <option value="all">All</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The Forge Selected result banners, out of QueuePage for complexity's sake. */
function ForgeFeedback({ error, message }) {
  return (
    <>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-green-500/50 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {message}
        </div>
      )}
    </>
  );
}

/**
 * For bulk-reject confirmations, a top-10 preview inside the modal so the
 * user can verify scope. Items are looked up out of the current `items`
 * array (only currently-rendered items can be selected anyway).
 */
function BulkRejectPreview({ confirmTarget, items }) {
  if (confirmTarget?.type !== 'bulkReject') return null;
  const ids = confirmTarget.ids || [];
  if (ids.length === 0) return null;
  const byId = new Map(items.map((it) => [it.id, it]));
  const previewItems = ids
    .slice(0, 10)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const overflow = Math.max(ids.length - previewItems.length, 0);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 max-h-72 overflow-y-auto text-sm">
      <ul className="space-y-2">
        {previewItems.map((it) => {
          const dateInfo = formatPublishedDate(it);
          const domain = getRootDomain(it);
          return (
            <li key={it.id} className="flex flex-col gap-0.5">
              <span className="font-medium leading-snug line-clamp-2">
                {it.Title || it.title || 'Untitled'}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {domain || ''}
                {dateInfo ? ` · ${dateInfo.label}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <p className="mt-2 text-xs text-muted-foreground italic">…and {overflow} more not shown.</p>
      )}
    </div>
  );
}

/** The header's bulk actions, out of QueuePage for complexity's sake. */
function QueueHeaderActions({
  statusFilter,
  totalCount,
  selectedIds,
  bulkDeletingRejected,
  forgingSelected,
  bulkRejecting,
  handleDeleteRejectedNow,
  handleForgeSelected,
  handleBulkReject,
}) {
  return (
    <div className="flex flex-col items-end gap-2">
      {/* deleteRejectedContent is publisher (lib/gallery-images.js); the
          approve, reject and forge actions beside it are the page's own
          editor role and need no gate. */}
      <RoleGate minRole="publisher" reason="Deleting rejected content needs the publisher role.">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDeleteRejectedNow}
          disabled={bulkDeletingRejected || statusFilter !== 'rejected' || totalCount === 0}
          className="gap-1 text-destructive hover:text-destructive"
        >
          {bulkDeletingRejected ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          Delete Rejected Now
        </Button>
      </RoleGate>
      {selectedIds.size > 0 && statusFilter !== 'rejected' && statusFilter !== 'published_live' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleForgeSelected}
          disabled={forgingSelected}
          className="gap-1"
        >
          {forgingSelected ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Flame className="h-4 w-4 text-primary" />
          )}
          Forge Selected ({selectedIds.size})
        </Button>
      )}
      {selectedIds.size > 1 && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleBulkReject}
          disabled={bulkRejecting}
          className="gap-1 text-destructive hover:text-destructive border-destructive/60"
        >
          {bulkRejecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Reject All Now ({selectedIds.size})
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => window.location.reload()}
        className="gap-1"
      >
        <RefreshCw className="h-4 w-4" /> Refresh
      </Button>
    </div>
  );
}

export default function QueuePage() {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'needs_review');
  const [contentTypeFilter, setContentTypeFilter] = useState(
    searchParams.get('contentType') || 'all'
  );
  const [kindFilter, setKindFilter] = useState(searchParams.get('kind') || 'all');
  const [ideaOriginFilter, setIdeaOriginFilter] = useState(searchParams.get('ideaOrigin') || 'all');
  const { taxonomy } = useTaxonomy();
  const [sortKey, setSortKey] = useState(() => readSortKey(searchParams));
  const [sortDirection, setSortDirection] = useState(() => readSortDirection(searchParams));
  const [pageSize, setPageSize] = useState(() => readPageSize(searchParams));
  const { items, setItems, totalCount, loading, loadError } = useQueueSnapshot({
    authReady,
    statusFilter,
    contentTypeFilter,
    kindFilter,
    ideaOriginFilter,
    pageSize,
  });
  const forgeMeter = useForgeMeter(authReady);
  const {
    actionLoading,
    actionError,
    bulkDeletingRejected,
    bulkDeleteError,
    bulkDeleteMessage,
    bulkRejecting,
    confirmTarget,
    setConfirmTarget,
    selectedIds,
    toggleSelected,
    toggleSelectAll,
    forgingSelected,
    forgeMessage,
    forgeError,
    handleForgeSelected,
    handleApprove,
    handleBulkReject,
    handleConfirm,
    handleDeleteRejectedNow,
    handleGenerateHero,
    handlePermanentDelete,
    handleReinspect,
    handleReject,
    handleRestore,
  } = useQueueActions({ items, setItems, statusFilter, contentTypeFilter });

  const confirmModalCopy = getConfirmModalCopy(confirmTarget);

  const displayedItems = useMemo(
    () => sortQueueItemsBy(items, sortKey, sortDirection),
    [items, sortKey, sortDirection]
  );

  const confirmModalPreview = <BulkRejectPreview confirmTarget={confirmTarget} items={items} />;

  useEffect(() => {
    setSearchParams(
      buildQueueSearchParams({
        statusFilter,
        contentTypeFilter,
        kindFilter,
        ideaOriginFilter,
        pageSize,
        sortKey,
        sortDirection,
      }),
      { replace: true }
    );
  }, [
    statusFilter,
    contentTypeFilter,
    kindFilter,
    ideaOriginFilter,
    pageSize,
    sortKey,
    sortDirection,
    setSearchParams,
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={ListChecks}
        help={QUEUE_HELP}
        status={
          <>
            <span className="text-muted-foreground">
              Showing {items.length} of {totalCount} matching items.
            </span>
            <ForgedTodayMeter meter={forgeMeter} />
          </>
        }
        actions={
          <QueueHeaderActions
            statusFilter={statusFilter}
            totalCount={totalCount}
            selectedIds={selectedIds}
            bulkDeletingRejected={bulkDeletingRejected}
            forgingSelected={forgingSelected}
            bulkRejecting={bulkRejecting}
            handleDeleteRejectedNow={handleDeleteRejectedNow}
            handleForgeSelected={handleForgeSelected}
            handleBulkReject={handleBulkReject}
          />
        }
      />

      <ForgeFromUrlCard />

      {/* Repository drafts moved to their own stage (owner request 2026-10-03):
          written, imported and sent here from /admin/drafts. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-start gap-3">
            <FilePen className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Drafts</p>
              <p className="text-sm text-muted-foreground">
                Articles are written, imported from docs/content, and sent to In Review on the
                Drafts page.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/drafts">Open Drafts</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Rejected decay-countdown explanation banner */}
      {statusFilter === 'rejected' && (
        <div className="rounded-md border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="font-medium">Rejected items decay automatically.</p>
          <p className="mt-1 text-xs">
            Rejected items get a 24-hour grace period, then move to soft-delete with a 7-day
            recovery window before permanent removal (the countdown badge on each card shows where
            it is in that decay). Use the <strong>Restore to Review</strong> button on a card to
            pull an item back into the pipeline before it expires.
          </p>
        </div>
      )}

      {/* Load error banner */}
      {loadError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load queue: {loadError}
        </div>
      )}

      {/* Bulk delete feedback */}
      {bulkDeleteError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {bulkDeleteError}
        </div>
      )}
      {bulkDeleteMessage && (
        <div className="rounded-md border border-green-500/50 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {bulkDeleteMessage}
        </div>
      )}

      {/* Forge Selected feedback */}
      <ForgeFeedback error={forgeError} message={forgeMessage} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter className="h-4 w-4" /> Filter by Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3">
            <Label className="text-xs">Content Type</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {CONTENT_TYPE_OPTIONS.map(({ value, label }) => (
                <Button
                  key={value}
                  variant={contentTypeFilter === value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setContentTypeFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map(({ value, label }) => (
              <Button
                key={value}
                variant={statusFilter === value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <TaxonomyFilterSelect
              id="queue-kind-filter"
              label="Kind (what it becomes)"
              value={kindFilter}
              entries={enabledEntries(taxonomy.kinds)}
              onChange={setKindFilter}
            />
            <TaxonomyFilterSelect
              id="queue-origin-filter"
              label="Idea origin (how it started)"
              value={ideaOriginFilter}
              entries={enabledEntries(taxonomy.ideaOrigins)}
              onChange={setIdeaOriginFilter}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-6">
            <div>
              <Label className="text-xs">Show per page</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {PAGE_SIZES.map((size) => (
                  <Button
                    key={size}
                    variant={pageSize === size ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPageSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Sort by</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {Object.entries(SORT_OPTIONS).map(([value, { label }]) => (
                  <Button
                    key={value}
                    variant={sortKey === value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSortKey(value)}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                  title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortDirection === 'asc' ? '↑ Asc' : '↓ Desc'}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <QueueList
        items={displayedItems}
        loading={loading}
        actionLoading={actionLoading}
        actionError={actionError}
        handleApprove={handleApprove}
        handleReject={handleReject}
        handleReinspect={handleReinspect}
        handleRestore={handleRestore}
        handlePermanentDelete={handlePermanentDelete}
        handleGenerateHero={handleGenerateHero}
        navigate={navigate}
        statusFilter={statusFilter}
        selectedIds={selectedIds}
        toggleSelected={toggleSelected}
        toggleSelectAll={toggleSelectAll}
      />

      <ConfirmModal
        open={Boolean(confirmTarget)}
        title={confirmModalCopy.title}
        description={confirmModalCopy.description}
        preview={confirmModalPreview}
        confirmLabel={confirmModalCopy.confirmLabel}
        destructive={confirmModalCopy.destructive}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
