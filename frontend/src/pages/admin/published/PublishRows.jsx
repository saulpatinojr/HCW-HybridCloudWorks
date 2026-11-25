/**
 * The Publish page's two kinds of row: a staged item waiting to go live (with
 * its publish button and image-order panel) and an item already live (with
 * its URL and podcast transcript controls). They lived inside
 * PublishedPage.jsx until it grew too long to follow.
 */
import React from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getCoverImageUrl, formatPostDate } from '@/lib/blogUtils';
import { PenSquare, Loader2, Images, Headphones } from 'lucide-react';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getLiveUrl } from '@/lib/livePages';
import { ADMIN_ROUTES } from '@/config/admin';
import { ImageOrderManager } from '@/components/admin/ImageOrderManager';
import { ImageGalleryPicker } from '@/components/admin/ImageGalleryPicker';
import PipelineStepper from '@/components/admin/PipelineStepper';
import RoleGate from '@/components/admin/RoleGate';
import {
  getReviewPath,
  getItemProvider,
  getItemTypeLabel,
  getPublishButtonContent,
} from '@/components/admin/published/publishHelpers';
import SetSlugPanel, { SetSlugButton } from '../SetSlugPanel';

const getPublicUrl = getLiveUrl;

/** The row's cover image, or a grey box when it has none. */
function CoverThumb({ item }) {
  const coverUrl = getCoverImageUrl(item);
  return coverUrl ? (
    <img
      src={coverUrl}
      alt=""
      className="h-14 w-20 object-cover rounded-md shrink-0"
      loading="lazy"
    />
  ) : (
    <div className="h-14 w-20 rounded-md bg-muted shrink-0" />
  );
}

/** "View Live", when the item has a public address. */
function ViewLiveButton({ item }) {
  const publicUrl = getPublicUrl(item);
  return (
    publicUrl && (
      <Button size="sm" variant="outline" asChild>
        <a href={publicUrl} target="_blank" rel="noreferrer">
          View Live
        </a>
      </Button>
    )
  );
}

/** A staged row's image-order editor: reorder, add from the gallery, apply. */
function StagedImagesPanel({ item, displayItem, images }) {
  return (
    <div className="border-t pt-3">
      <ImageOrderManager
        images={images.getDraftImages(displayItem)}
        onChange={(nextImages) => images.setDraftImages(item.id, nextImages)}
        onRemove={(index) => images.removeDraftImage(item.id, index, displayItem)}
        description="Drag to set the final publish order. The first image becomes the hero image."
        emptyMessage="No images are attached to this item yet."
      />
      <div className="mt-3">
        <ImageGalleryPicker
          provider={getItemProvider(displayItem)}
          title="Add From Image Gallery"
          onSelect={(galleryItem) =>
            images.attachDraftImage(item.id, displayItem, galleryItem.imageUrl)
          }
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => images.persistImageOrder(displayItem)}
          disabled={images.savingImageId === item.id}
        >
          {images.savingImageId === item.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Apply Image Order
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to={ADMIN_ROUTES.EDITOR.replace(':id', item.id)}>Open Editor</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * One item staged for publishing. `workflow` is the publish workflow's state
 * and handlers; `images` the image-order drafts; `isItemLive` reads the row's
 * live flag with any local change applied.
 */
export function StagedRow({
  item,
  images,
  workflow,
  isItemLive,
  imagesOpen,
  onToggleImages,
  onReview,
}) {
  const displayItem = images.withImageOverride(item);
  const isLive = isItemLive(displayItem);
  const working = workflow.publishingId === item.id || workflow.validatingId === item.id;
  return (
    <div className="rounded-lg border p-3 space-y-3 hover:bg-muted/40">
      <div className="flex items-center gap-4">
        <CoverThumb item={displayItem} />

        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{displayItem.Title || displayItem.title}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <StatusBadge content={displayItem} />
            <Badge variant="outline" className="text-xs">
              {getItemProvider(displayItem)}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {getItemTypeLabel(displayItem)}
            </Badge>
            <TaxonomyChips item={displayItem} />
          </div>
          <PipelineStepper item={displayItem} className="mt-2" />
        </div>

        <div className="flex gap-2 shrink-0">
          <ViewLiveButton item={displayItem} />
          <Button size="sm" variant="outline" onClick={onReview}>
            Review
          </Button>
          <Button size="sm" variant="outline" onClick={onToggleImages}>
            <Images className="h-4 w-4 mr-2" />
            Images
          </Button>
          {/* publishContent and unpublishContentToInspected are
              publisher routes (lib/cms/publish.js,
              lib/content-workflow.js); below that role the
              button says so instead of answering with a 403. */}
          <RoleGate
            minRole="publisher"
            reason="Publishing and unpublishing need the publisher role."
          >
            <Button
              size="sm"
              variant={isLive ? 'outline' : 'default'}
              onClick={() =>
                isLive ? workflow.handleUnpublish(item) : workflow.handlePublishRequest(item)
              }
              disabled={working}
            >
              {getPublishButtonContent(working, isLive)}
            </Button>
          </RoleGate>
        </div>
      </div>

      {imagesOpen && <StagedImagesPanel item={item} displayItem={displayItem} images={images} />}
    </div>
  );
}

/** One live item, with its URL control and the podcast transcript button. */
export function PublishedRow({ blog, slugOpen, onToggleSlug, onSlugApplied, transcript }) {
  const queuing = transcript.queuingTranscriptId === blog.id;
  return (
    <div className="rounded-lg border hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-4 p-4">
        <CoverThumb item={blog} />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{blog.Title || blog.title}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <StatusBadge content={blog} />
            <Badge variant="outline" className="text-xs">
              {getItemProvider(blog)}
            </Badge>
            <TaxonomyChips item={blog} />
            <span className="text-xs text-muted-foreground">
              {formatPostDate(blog.blogPublishedAt)}
            </span>
          </div>
          <PipelineStepper item={blog} className="mt-2" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ViewLiveButton item={blog} />
          {/* #400: the URL control, beside the link it changes. */}
          <SetSlugButton open={slugOpen} onToggle={onToggleSlug} />
          {/* #435: read this article aloud for the podcast. Live rows only. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => transcript.setTranscriptTarget(blog)}
            disabled={queuing}
          >
            {queuing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Headphones className="h-4 w-4 mr-2" />
            )}
            Podcast transcript
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to={`${getReviewPath(blog.id)}?source=content`}>
              <PenSquare className="h-4 w-4 mr-2" />
              Review
            </Link>
          </Button>
        </div>
      </div>

      {slugOpen && (
        <div className="px-4 pb-4">
          <SetSlugPanel item={blog} onApplied={onSlugApplied} />
        </div>
      )}
    </div>
  );
}
