/**
 * The review queue's list and its item card.
 *
 * Split out of QueuePage.jsx (T-412). This is the bulk of the page by
 * line count and almost none of its risk: every component here is a function of
 * its props, with the mutating handlers passed in. Separating it is what lets
 * the bulk-transition logic be exercised without rendering four hundred lines
 * of card markup.
 *
 * `QueueItemCard` is exported alongside `QueueList` because a card renders
 * meaningfully on its own, which is the unit a test wants.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ADMIN_ROUTES } from '@/config/admin';
import RoleGate from '@/components/admin/RoleGate';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getCoverImageUrl } from '@/lib/blogUtils';
import {
  BookOpen,
  Calendar,
  CheckCircle,
  Edit3,
  Eye,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import {
  formatPublishedDate,
  getDecayBadge,
  getEditorPath,
  getForgeBadge,
  getHeroCacheBust,
  getQueueItemCoverUrl,
  getReviewPath,
  getRootDomain,
  getSourceBadge,
} from './itemHelpers';

export function QueueList({
  items,
  loading,
  actionLoading,
  actionError,
  handleApprove,
  handleReject,
  handleReinspect,
  handleRestore,
  handlePermanentDelete,
  handleGenerateHero,
  navigate,
  statusFilter,
  selectedIds,
  toggleSelected,
  toggleSelectAll,
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-blue" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        variant="filtered"
        title="Nothing matches these filters"
        description="New items arrive here from RSS feeds, Submit URLs, Forge from URL and Drafts sent to review. Try another status, type, kind or origin."
      />
    );
  }

  const canSelect = statusFilter !== 'rejected' && statusFilter !== 'published_live';
  const allSelected =
    canSelect && items.length > 0 && items.every((item) => selectedIds?.has(item.id));

  return (
    <div className="space-y-4">
      {canSelect && toggleSelectAll && (
        <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            aria-label="Select all visible items"
            checked={allSelected}
            onChange={() => toggleSelectAll(items.map((item) => item.id))}
            className="h-4 w-4 cursor-pointer"
          />
          Select all {items.length} visible
        </label>
      )}
      {items.map((item) => (
        <QueueItemCard
          key={item.id}
          item={item}
          statusFilter={statusFilter}
          actionLoading={actionLoading}
          actionError={actionError}
          handleApprove={handleApprove}
          handleReject={handleReject}
          handleReinspect={handleReinspect}
          handleRestore={handleRestore}
          handlePermanentDelete={handlePermanentDelete}
          handleGenerateHero={handleGenerateHero}
          navigate={navigate}
          isSelected={selectedIds?.has(item.id)}
          toggleSelected={toggleSelected}
        />
      ))}
    </div>
  );
}

/**
 * Action buttons component for queue items
 * Extracted to reduce complexity
 */
function QueueItemActions({
  item,
  statusFilter,
  isLoading,
  handleApprove,
  handleReject,
  handleReinspect,
  handleRestore,
  handlePermanentDelete,
  navigate,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {statusFilter === 'published_live' && (
        <>
          <Button
            variant="default"
            size="sm"
            onClick={() => navigate(ADMIN_ROUTES.PUBLISHED)}
            className="gap-1"
          >
            Manage in Publish
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(getReviewPath(item.id))}
            className="gap-1"
          >
            <Eye className="h-4 w-4" /> View
          </Button>
        </>
      )}

      {statusFilter === 'ready_to_publish' && (
        <Button
          variant="default"
          size="sm"
          onClick={() => navigate(ADMIN_ROUTES.PUBLISHED)}
          className="gap-1"
        >
          Go to Publish→
        </Button>
      )}

      {(statusFilter === 'inspected' || statusFilter === 'needs_review') && (
        <>
          <Button
            variant="default"
            size="sm"
            onClick={() => handleApprove(item)}
            disabled={isLoading}
            className="gap-1"
          >
            {isLoading === 'approving' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            Send to Publish
          </Button>
        </>
      )}

      {statusFilter === 'ingested' && (
        <Button
          variant="default"
          size="sm"
          onClick={() => handleReinspect(item.id)}
          disabled={isLoading}
          className="gap-1"
        >
          {isLoading === 'inspecting' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Inspect Now
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(getReviewPath(item.id))}
        className="gap-1"
      >
        <Eye className="h-4 w-4" /> View
      </Button>

      {statusFilter === 'ready_to_publish' && (
        <Button
          variant="default"
          size="sm"
          onClick={() => navigate(ADMIN_ROUTES.CALENDAR)}
          className="gap-1"
        >
          <Calendar className="h-4 w-4" /> Schedule on Calendar
        </Button>
      )}

      {(statusFilter === 'approved' || item.publishTarget === 'blog') && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(getEditorPath(item.id))}
          className="gap-1"
        >
          <Edit3 className="h-4 w-4" /> Edit
        </Button>
      )}

      {statusFilter !== 'published_live' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(getEditorPath(item.id))}
          className="gap-1"
        >
          <Edit3 className="h-4 w-4" /> Open in Editor
        </Button>
      )}

      {statusFilter !== 'rejected' && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleReject(item.id)}
          disabled={isLoading}
          className="gap-1 text-destructive hover:text-destructive"
        >
          {isLoading === 'rejecting' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Reject
        </Button>
      )}

      {statusFilter === 'rejected' && (
        <>
          <Button
            variant="default"
            size="sm"
            onClick={() => handleRestore(item.id)}
            disabled={isLoading}
            className="gap-1"
          >
            {isLoading === 'restoring' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Undo2 className="h-4 w-4" />
            )}
            Restore to Review
          </Button>
          {/* deleteContentItem is publisher (lib/content-workflow.js). */}
          <RoleGate minRole="publisher" reason="Deleting content needs the publisher role.">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handlePermanentDelete(item.id)}
              disabled={isLoading}
              className="gap-1"
            >
              {isLoading === 'deleting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete Permanently
            </Button>
          </RoleGate>
        </>
      )}
    </div>
  );
}

function QueueItemCover({ item, coverUrl, canGenerateHero, isGeneratingHero, handleGenerateHero }) {
  let icon = <Sparkles className="h-3.5 w-3.5" />;
  if (isGeneratingHero) {
    icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  } else if (coverUrl) {
    icon = <RefreshCw className="h-3.5 w-3.5" />;
  }

  return (
    <div className="relative w-full sm:w-32 h-24 shrink-0">
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          className="w-full h-full object-cover rounded-md"
          loading="lazy"
        />
      ) : (
        <div
          className="w-full h-full rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-600"
          aria-label="No hero image yet"
        >
          <ImageIcon className="h-8 w-8" />
        </div>
      )}
      {canGenerateHero && (
        <button
          type="button"
          onClick={() => handleGenerateHero(item.id)}
          disabled={isGeneratingHero}
          title={coverUrl ? 'Regenerate hero image' : 'Generate hero image'}
          aria-label={coverUrl ? 'Regenerate hero image' : 'Generate hero image'}
          className="absolute bottom-1 right-1 h-7 w-7 rounded-full bg-slate-900/80 hover:bg-slate-900 text-white flex items-center justify-center shadow-md disabled:opacity-60"
        >
          {icon}
        </button>
      )}
    </div>
  );
}

function QueueItemDateMeta({ item }) {
  const dateInfo = formatPublishedDate(item);
  const domain = getRootDomain(item);

  return (
    <>
      {domain && <div className="font-mono text-[11px]">{domain}</div>}
      {dateInfo && (
        <div className={dateInfo.isFallback ? 'italic opacity-75' : ''}>{dateInfo.label}</div>
      )}
    </>
  );
}

function QueueItemBadges({ item }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge content={item} />
      <Badge variant="outline">{item['Cloud Provider'] || item.cloudProvider || 'Unknown'}</Badge>
      <Badge variant="secondary">{item.category || 'Uncategorized'}</Badge>
      {getSourceBadge(item)}
      {item.publishTarget && (
        <Badge className="gap-1">
          {item.publishTarget === 'blog' && <BookOpen className="h-3 w-3" />}
          {item.publishTarget}
        </Badge>
      )}
      <TaxonomyChips item={item} />
      {getForgeBadge(item)}
      {getDecayBadge(item)}
    </div>
  );
}

function QueueItemStats({ item }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {item.wordCount && <span>{item.wordCount} words</span>}
      {item.readTime && <span>• {item.readTime} read</span>}
      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline"
        >
          • View source
        </a>
      )}
    </div>
  );
}

/**
 * Individual queue item card component
 * Extracted from main component to reduce complexity
 */
export function QueueItemCard({
  item,
  statusFilter,
  actionLoading,
  actionError,
  handleApprove,
  handleReject,
  handleReinspect,
  handleRestore,
  handlePermanentDelete,
  handleGenerateHero,
  navigate,
  isSelected,
  toggleSelected,
}) {
  const baseCoverUrl = getCoverImageUrl(item);
  const cacheBust = item.__regenAt || getHeroCacheBust(item);
  const coverUrl = getQueueItemCoverUrl(baseCoverUrl, cacheBust);
  const isLoading = actionLoading[item.id];
  const itemError = actionError[item.id];
  const canSelectForReject = statusFilter !== 'rejected' && statusFilter !== 'published_live';

  return (
    <Card key={item.id} className="overflow-hidden">
      <div className="flex flex-col sm:flex-row gap-4 p-4">
        {canSelectForReject && (
          <div className="flex items-start pt-1">
            <input
              type="checkbox"
              aria-label="Select item"
              checked={Boolean(isSelected)}
              onChange={() => toggleSelected?.(item.id)}
              className="h-4 w-4 cursor-pointer"
            />
          </div>
        )}
        <QueueItemCover
          item={item}
          coverUrl={coverUrl}
          canGenerateHero={Boolean(handleGenerateHero)}
          isGeneratingHero={actionLoading[item.id] === 'generatingHero'}
          handleGenerateHero={handleGenerateHero}
        />

        <div className="flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-base line-clamp-2">
                {item.Title || item.title || 'Untitled'}
              </h3>
            </div>
            <div className="text-right text-xs text-muted-foreground shrink-0 leading-tight">
              <QueueItemDateMeta item={item} />
            </div>
          </div>
          <QueueItemBadges item={item} />

          <p className="text-sm text-muted-foreground line-clamp-2">
            {item.Summary || item.summary || 'No summary available'}
          </p>

          <QueueItemStats item={item} />

          <QueueItemActions
            item={item}
            statusFilter={statusFilter}
            isLoading={isLoading}
            handleApprove={handleApprove}
            handleReject={handleReject}
            handleReinspect={handleReinspect}
            handleRestore={handleRestore}
            handlePermanentDelete={handlePermanentDelete}
            navigate={navigate}
          />
          {itemError && <p className="text-xs text-destructive mt-1">{itemError}</p>}
        </div>
      </div>
    </Card>
  );
}
