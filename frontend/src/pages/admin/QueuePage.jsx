import React, { useState, useEffect, useMemo } from 'react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import PageHeader from '@/components/admin/shared/PageHeader';
import { useTaxonomy } from '@/components/admin/shared/useTaxonomy';
import { enabledEntries } from '@/lib/taxonomy';
import { getConfirmModalCopy, SORT_OPTIONS, sortQueueItemsBy } from './queue/itemHelpers';
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
  ForgedTodayMeter,
  ForgeFromUrlCard,
  TaxonomyFilterSelect,
  ForgeFeedback,
  BulkRejectPreview,
  QueueHeaderActions,
} from './queue/QueuePageComponents';
import { Filter, FilePen, ListChecks } from 'lucide-react';

/** What a first-time user needs to know about this page (ADR 0033 §7). */
const QUEUE_HELP = [
  'What arrives here: items from RSS feeds, Submit URLs, Forge from URL, the Recording Hub, and drafts sent to review from the Drafts page.',
  'Needs review is the default: Ingested items are raw, Inspected ones have been read by the AI inspector and carry a summary.',
  'What to do: open an item to read it, then Send to Publish (approve) or Reject. Select several and Forge or Reject them together.',
  'Kind and idea origin classify every item; set them here or on the review page so downstream tools (Listen & Learn, Social Hub, Newsletter) pick the right items.',
  'Where it goes next: approved items appear in the Editor for polishing, then on the Publish page. Rejected items decay and are purged unless restored.',
];

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
                Articles are written or uploaded from a markdown file, and sent to In Review on the
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
