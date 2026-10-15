/**
 * Image Gallery — the central media library (ADR 0033 Creative slice).
 *
 * Visual first: a thumbnail grid with hover actions and a details dialog per
 * image; server-side search, filters, sort and paging (lib/imageGallery.js
 * → GET cms/images); bulk actions that patch each selected image against its
 * own document (POST cms/images/bulk — the fix for "Update Selected" touching
 * one image and tag toggles erasing tags); archive, trash and permanent
 * delete; folders persisted in admin_config/gallery_folders; upload and
 * import-from-URL. Every image that came from a prompt set links back to it
 * on Image Prompts.
 *
 * The page composes three hooks and a few sections from ./imageGallery/
 * (PR #841): the listing, the selection, the actions, and the grid, pager and
 * notices they feed.
 */
import React, { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Images, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/admin/shared/PageHeader';
import GalleryTile from '@/components/admin/images/GalleryTile';
import GalleryToolbar from '@/components/admin/images/GalleryToolbar';
import BulkActionsBar from '@/components/admin/images/BulkActionsBar';
import ImageDetailsDialog from '@/components/admin/images/ImageDetailsDialog';
import UploadPanel from '@/components/admin/images/UploadPanel';
import { DEFAULT_FILTERS, HELP, listingSummary } from './imageGallery/galleryPageModel';
import useGalleryListing from './imageGallery/useGalleryListing';
import useGallerySelection from './imageGallery/useGallerySelection';
import useGalleryActions from './imageGallery/useGalleryActions';
import GalleryGrid from './imageGallery/GalleryGrid';
import GalleryPager from './imageGallery/GalleryPager';
import { GalleryCounts, GalleryMessage } from './imageGallery/GalleryNotices';

// The page's pure rules live in ./imageGallery/galleryPageModel.js; these
// three are re-exported so existing imports keep working.
export {
  deletionMessage,
  filtersFromSearch,
  hasActiveFilters,
} from './imageGallery/galleryPageModel';

/** Focuses the upload picker, which UploadPanel renders further down the page. */
const focusUploadPicker = () => document.getElementById('gallery-files')?.focus();

/**
 * The Image Gallery page (see the header): the listing, selection and actions
 * hooks composed over the grid, the pager and the dialogs.
 */
export default function ImageGalleryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const listing = useGalleryListing(location.search);
  const selection = useGallerySelection();
  const actions = useGalleryActions({ listing, selection, navigate });

  const { items, facets, filters, setFilters, loading, error, refresh, folders, total } = listing;
  const { selectedIds, busyIds, copiedId, detailsId, setDetailsId } = selection;
  const { runBulk, copyText, reuse } = actions;

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  );
  const detailsItem = useMemo(
    () => items.find((item) => item.id === detailsId) || null,
    [items, detailsId]
  );
  const summary = listingSummary({
    loading,
    filters,
    total,
    count: items.length,
    selectedCount: selectedIds.size,
  });

  const renderTile = (item) => (
    <GalleryTile
      key={item.id}
      item={item}
      selected={selectedIds.has(item.id)}
      busy={busyIds.has(item.id)}
      copied={copiedId === `url-${item.id}`}
      onToggleSelect={selection.toggleSelected}
      onOpen={(it) => setDetailsId(it.id)}
      onReuse={reuse}
      onCopy={copyText}
      onArchive={(it) => runBulk([it], 'archive')}
      onTrash={(it) => runBulk([it], 'trash')}
      onRestore={(it) => runBulk([it], 'restore')}
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Images}
        help={HELP}
        status={facets?.counts && <GalleryCounts counts={facets.counts} />}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={focusUploadPicker}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" /> Add images
          </Button>
        }
      />

      <GalleryMessage text={actions.message} />

      <UploadPanel
        folders={folders}
        items={items}
        onFoldersChange={actions.changeFolders}
        onUploaded={async () => refresh()}
        onMessage={actions.say}
      />

      <GalleryToolbar
        filters={filters}
        onChange={setFilters}
        facets={facets}
        folders={folders}
        providerValues={listing.providerValues}
        slotValues={listing.slotValues}
        tagValues={listing.tagValues}
        loading={loading}
        onRefresh={refresh}
        summary={summary}
      />

      <BulkActionsBar
        selectedItems={selectedItems}
        allItems={items}
        folders={folders}
        busy={actions.bulkBusy}
        onClear={selection.clearSelection}
        onSelectAll={() => selection.selectAll(items)}
        onBulk={(action, extra) => runBulk(selectedItems, action, extra)}
      />

      <GalleryGrid
        error={error}
        loading={loading}
        items={items}
        filters={filters}
        onRetry={refresh}
        onClearFilters={() => setFilters({ ...DEFAULT_FILTERS, state: filters.state })}
        onOpenPrompts={() => navigate('/admin/image-prompts')}
        renderTile={renderTile}
      />

      <GalleryPager
        filters={filters}
        onChange={setFilters}
        total={total}
        hasMore={listing.hasMore}
        loading={loading}
        count={items.length}
      />

      {detailsItem && (
        <ImageDetailsDialog
          item={detailsItem}
          folders={folders}
          busy={busyIds.has(detailsItem.id)}
          copied={copiedId}
          onClose={() => setDetailsId('')}
          onSave={actions.saveDetails}
          onArchive={(it) => runBulk([it], 'archive')}
          onRestore={(it) => runBulk([it], 'restore')}
          onTrash={(it) => runBulk([it], 'trash')}
          onDelete={actions.deleteOne}
          onReuse={reuse}
          onCopy={copyText}
          onOpenSet={(name) => navigate(`/admin/image-prompts?set=${encodeURIComponent(name)}`)}
          onOpenContent={(use) => navigate(`/admin/review-queue/${encodeURIComponent(use.id)}`)}
          onOpenVariant={actions.openVariant}
        />
      )}
    </div>
  );
}
