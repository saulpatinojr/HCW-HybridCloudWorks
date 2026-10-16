import { useState } from 'react';
import {
  Bot,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  History,
  Images,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { stripHtmlTags } from '@/lib/blogUtils';
import { useEditor } from '../context/EditorContext';
import { ImageOrderManager } from '@/components/admin/ImageOrderManager';
import { ImageGalleryPicker } from '@/components/admin/ImageGalleryPicker';
import { resolveMediaUrl } from '../../../lib/functionsBase';
import VersionHistoryDialog from './VersionHistoryDialog';

function CollapsibleSection({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-left hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {title}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-3">{children}</div>}
    </div>
  );
}

export function MetadataTab() {
  const {
    fields,
    setField,
    blog,
    coverUrl,
    currentTarget,
    destinationUrl,
    generateTitle,
    generateSummary,
    generatingTitle,
    generatingSummary,
    imageCandidates,
    orderedImages,
    updateOrderedImages,
    removeOrderedImage,
    attachOrderedImage,
  } = useEditor();

  const { title, summary, tags, authorName, publishedDate, sidebarContent, draft } = fields;
  const [historyOpen, setHistoryOpen] = useState(false);

  const wordCount = draft ? stripHtmlTags(draft).split(/\s+/).filter(Boolean).length : 0;
  const readMinutes = Math.max(1, Math.round(wordCount / 200));

  const scrapedImages = imageCandidates.filter((img) => img.source === 'scraped');

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Cover image */}
      {coverUrl && (
        <div className="rounded-md overflow-hidden border border-border">
          <img src={coverUrl} alt="Cover" className="w-full h-36 object-cover" />
        </div>
      )}

      {/* Article info */}
      <div className="rounded-md border border-border px-3 py-2 text-xs space-y-1 text-muted-foreground">
        <div className="flex items-center gap-2">
          {currentTarget && (
            <Badge variant="secondary" className="capitalize text-xs">
              {currentTarget}
            </Badge>
          )}
          <span>
            {wordCount} words · ~{readMinutes} min read
          </span>
          {/* Every save writes a version (ADR 0033 §1); this is where they are read. */}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => setHistoryOpen(true)}
            disabled={!blog?.id}
          >
            <History className="h-3 w-3 mr-1" aria-hidden="true" />
            History
          </Button>
        </div>
        {destinationUrl && (
          <a
            href={destinationUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            {destinationUrl}
          </a>
        )}
        {blog?.sourceUrl && (
          <a
            href={blog.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors truncate"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">Source: {blog.sourceUrl}</span>
          </a>
        )}
      </div>

      {/* Title */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="metadata-title" className="text-xs font-medium">
            Title
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={generateTitle}
            disabled={generatingTitle}
          >
            {generatingTitle ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Bot className="h-3 w-3 mr-1" />
            )}
            AI
          </Button>
        </div>
        <Input
          id="metadata-title"
          value={title}
          onChange={(e) => setField('title', e.target.value)}
          placeholder="Article title"
          className="text-sm"
        />
      </div>

      {/* Author + Date */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="metadata-author" className="text-xs font-medium">
            Author
          </label>
          <Input
            id="metadata-author"
            value={authorName}
            onChange={(e) => setField('authorName', e.target.value)}
            placeholder="Author name"
            className="text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="metadata-published-date" className="text-xs font-medium">
            Published Date
          </label>
          <Input
            type="date"
            id="metadata-published-date"
            value={publishedDate}
            onChange={(e) => setField('publishedDate', e.target.value)}
            className="text-sm"
          />
        </div>
      </div>

      {/* Tags */}
      <div className="space-y-1.5">
        <label htmlFor="metadata-tags" className="text-xs font-medium">
          Tags
        </label>
        <Input
          id="metadata-tags"
          value={tags}
          onChange={(e) => setField('tags', e.target.value)}
          placeholder="aws, kubernetes, terraform"
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">Comma-separated</p>
      </div>

      {/* Summary — collapsible with AI button */}
      <CollapsibleSection title="Summary" defaultOpen>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted-foreground">Used in article previews and cards</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={generateSummary}
            disabled={generatingSummary}
          >
            {generatingSummary ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Bot className="h-3 w-3 mr-1" />
            )}
            AI
          </Button>
        </div>
        <Textarea
          value={summary}
          onChange={(e) => setField('summary', e.target.value)}
          className="min-h-[80px] text-sm"
          placeholder="One to three sentences summarizing the article..."
        />
      </CollapsibleSection>

      {/* Sidebar content — collapsible */}
      <CollapsibleSection title="Sidebar Content">
        <p className="text-xs text-muted-foreground">
          Optional markdown displayed in the article sidebar.
        </p>
        <Textarea
          value={sidebarContent}
          onChange={(e) => setField('sidebarContent', e.target.value)}
          className="min-h-[80px] text-sm font-mono"
          placeholder="## Related\n- [Link](url)"
        />
      </CollapsibleSection>

      {/* Scraped images — collapsible */}
      <CollapsibleSection title={`Publish image order (${orderedImages.length})`} defaultOpen>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Drag to reorder. The first image becomes the hero image when you save.
          </p>
          <Button asChild variant="outline" size="sm" className="h-7 text-xs">
            <a href="/admin/image-gallery" target="_blank" rel="noreferrer">
              <Images className="h-3.5 w-3.5 mr-1" />
              Open Gallery
            </a>
          </Button>
        </div>
        <ImageOrderManager
          images={orderedImages}
          onChange={updateOrderedImages}
          onRemove={removeOrderedImage}
          emptyMessage="No selected images are attached to this draft yet."
        />
        <ImageGalleryPicker
          provider={blog?.['Cloud Provider'] || blog?.cloudProvider || ''}
          onSelect={(item) => attachOrderedImage(item.imageUrl)}
        />
        <p className="text-xs text-muted-foreground">
          Reordering and removals are stored with the next draft save or publish action.
        </p>
      </CollapsibleSection>

      <VersionHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />

      {scrapedImages.length > 0 && (
        <CollapsibleSection title={`Scraped images (${scrapedImages.length})`}>
          <p className="text-xs text-muted-foreground mb-1.5">
            Click an image to copy its URL for use in a picture module.
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {scrapedImages.map((img) => (
              <button
                key={img.id}
                type="button"
                className="rounded border border-border overflow-hidden hover:border-primary/60 transition-colors"
                onClick={() => navigator.clipboard?.writeText(img.imageUrl)}
                title={img.label}
              >
                <img
                  src={resolveMediaUrl(img.imageUrl)}
                  alt={img.label}
                  className="w-full h-14 object-cover"
                />
              </button>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
