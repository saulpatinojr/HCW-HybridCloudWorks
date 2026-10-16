/**
 * The blog review board's content column (ADR 0033, PR #841): cover, source
 * URL, summary, key topics, image slots, the publish image manager and the
 * two markdown panes, plus the full-screen image overlay.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  ExternalLink,
  Newspaper,
  Loader2,
  Eye,
  Wand2,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { ImageOrderManager } from '@/components/admin/ImageOrderManager';
import { ImageGalleryPicker } from '@/components/admin/ImageGalleryPicker';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { safeUrl } from '@/lib/safeUrl';
import { describeImageSlot, truncate } from './blogReviewModel';

/** An outbound link whose text is cut at `maxLength` characters. */
export function ExternalAnchor({ href, maxLength }) {
  return (
    <a
      href={safeUrl(href)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 break-all"
    >
      {truncate(href, maxLength)}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

function SourceUrlCard({ sourceUrl }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Source URL</p>
        {sourceUrl ? (
          <ExternalAnchor href={sourceUrl} maxLength={80} />
        ) : (
          <span className="text-sm text-muted-foreground">No source URL available.</span>
        )}
      </CardContent>
    </Card>
  );
}

/** A card header that toggles its body, with the open/closed icon pair the card chose. */
function CollapsibleHeader({
  icon: Icon,
  title,
  titleClassName,
  expanded,
  onToggle,
  openIcon: OpenIcon,
  closedIcon: ClosedIcon,
  trailing,
}) {
  const Indicator = expanded ? OpenIcon : ClosedIcon;
  const indicator = <Indicator className="h-4 w-4 text-muted-foreground" />;
  return (
    <CardHeader
      className="py-3 cursor-pointer hover:bg-muted/50 transition-colors flex flex-row items-center justify-between"
      onClick={onToggle}
    >
      <CardTitle className={`${titleClassName} flex items-center gap-2`}>
        <Icon className="h-4 w-4" /> {title}
      </CardTitle>
      {trailing ? (
        <div className="flex items-center gap-2">
          {trailing}
          {indicator}
        </div>
      ) : (
        indicator
      )}
    </CardHeader>
  );
}

function SummaryCard({ summary, expanded, onToggle }) {
  return (
    <Card>
      <CollapsibleHeader
        icon={Newspaper}
        title="Summary"
        titleClassName="text-base"
        expanded={expanded}
        onToggle={onToggle}
        openIcon={ChevronUp}
        closedIcon={ChevronDown}
      />
      {expanded && (
        <CardContent className="pt-0 pb-4">
          <p className="text-sm leading-relaxed text-foreground/90">{summary}</p>
        </CardContent>
      )}
    </Card>
  );
}

function KeyTopicsCard({ keyTopics, newTopic, onNewTopicChange, onAdd, onRemove }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Key Topics</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {keyTopics.map((topic) => (
            <Badge
              key={topic}
              variant="secondary"
              className="text-xs cursor-pointer"
              onClick={() => onRemove(topic)}
            >
              {topic}
            </Badge>
          ))}
        </div>
        <input
          type="text"
          value={newTopic}
          onChange={(e) => onNewTopicChange(e.target.value)}
          onKeyDown={onAdd}
          placeholder="Add topic and press Enter"
          className="w-full px-3 py-2 text-sm border rounded-md bg-background"
        />
      </CardContent>
    </Card>
  );
}

function ImageSlotButton({ slot, index, onExpand }) {
  const { url, label } = slot;
  return (
    <button
      type="button"
      onClick={() => url && onExpand(url)}
      className="aspect-video rounded-md border bg-muted/30 overflow-hidden relative"
      disabled={!url}
      aria-label={url ? `View ${label} full screen` : `${label} not yet generated`}
    >
      {url ? (
        <img
          src={safeUrl(resolveMediaUrl(url))}
          alt={`${label} thumbnail`}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full flex flex-col items-center justify-center gap-1 px-2 text-center">
          <span className="text-xs font-medium text-foreground/80">{label}</span>
          <span className="text-xs text-muted-foreground line-clamp-4">
            {describeImageSlot(slot)}
          </span>
        </div>
      )}
      <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
        {index + 1}
      </span>
    </button>
  );
}

function CoverStatusLines({ blog, isCoverGenerating }) {
  if (isCoverGenerating) {
    return (
      <p className="text-xs text-blue-600 dark:text-blue-300">
        Hero cover regeneration is running. The new image will replace the Hero Cover slot when
        ready.
      </p>
    );
  }
  return (
    <>
      {blog.altCoverImageGeneratedAt && (
        <p className="text-xs text-green-600 dark:text-green-300">
          Latest AI cover is available in the Hero Cover slot.
        </p>
      )}
      {blog.altCoverImageError && (
        <p className="text-xs text-destructive">
          AI cover generation failed: {blog.altCoverImageError}
        </p>
      )}
    </>
  );
}

function ImageSlotsCard({ blog, slots, isCoverGenerating, onExpand }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Images</p>
        <div className="grid grid-cols-2 gap-2">
          {slots.map((slot, index) => (
            <ImageSlotButton key={slot.key} slot={slot} index={index} onExpand={onExpand} />
          ))}
        </div>
        <div className="mt-2 space-y-1">
          <CoverStatusLines blog={blog} isCoverGenerating={isCoverGenerating} />
        </div>
      </CardContent>
    </Card>
  );
}

function ImageManagerCard({ images, provider, saving, actions }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Publish Image Manager</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ImageOrderManager
          images={images}
          onChange={actions.handleReviewImageReorder}
          onRemove={actions.handleRemoveReviewImage}
          description="Drag to set the final image order before sending to Editor or Publish."
          emptyMessage="No images are attached to this content yet."
        />
        <ImageGalleryPicker
          provider={provider}
          title="Add From Image Gallery"
          onSelect={actions.handleAttachReviewImage}
        />
        <Button
          onClick={actions.handleSaveReviewImages}
          variant="outline"
          size="sm"
          className="w-full"
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving Image Order...
            </>
          ) : (
            'Save Image Order'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

/** A collapsible markdown pane with a character-count badge; `empty` renders when there is no body. */
function MarkdownCard({ icon, title, body, expanded, onToggle, contentClassName = '', empty }) {
  const badge = (
    <Badge variant="outline" className="text-xs font-normal">
      {body ? `${body.length} chars` : 'Empty'}
    </Badge>
  );
  return (
    <Card>
      <CollapsibleHeader
        icon={icon}
        title={title}
        titleClassName="text-sm"
        expanded={expanded}
        onToggle={onToggle}
        openIcon={Minimize2}
        closedIcon={Maximize2}
        trailing={badge}
      />
      {expanded && (
        <CardContent
          className={`prose prose-sm dark:prose-invert max-w-none border-t pt-4 ${contentClassName}`.trim()}
        >
          {body ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown> : empty}
        </CardContent>
      )}
    </Card>
  );
}

function GenerateNowEmpty({ onGenerate }) {
  return (
    <div className="flex flex-col gap-2 items-center justify-center p-8 text-center bg-muted/20 rounded-lg">
      <p className="text-muted-foreground italic text-sm">No AI generated content yet.</p>
      <Button variant="outline" size="sm" onClick={onGenerate}>
        <Wand2 className="h-3 w-3 mr-2" /> Generate Now
      </Button>
    </div>
  );
}

export function ExpandedImageOverlay({ url, onClose }) {
  if (!url) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      aria-hidden="true"
    >
      <img src={safeUrl(url)} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg" />
    </div>
  );
}

export function BlogReviewContent({
  blog,
  view,
  state,
  patch,
  toggle,
  imageSlots,
  isCoverGenerating,
  topics,
  images,
  onTriggerInspect,
}) {
  return (
    <div className="lg:col-span-2 space-y-6">
      {view.coverUrl && (
        <img
          src={safeUrl(view.coverUrl)}
          alt=""
          className="w-full rounded-lg max-h-80 object-cover shadow-sm"
        />
      )}

      <SourceUrlCard sourceUrl={view.sourceUrl} />

      {view.summary && (
        <SummaryCard
          summary={view.summary}
          expanded={state.summaryExpanded}
          onToggle={() => toggle('summaryExpanded')}
        />
      )}

      {/* AI Metadata: Topics + Images */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <KeyTopicsCard
          keyTopics={state.keyTopics}
          newTopic={state.newTopic}
          onNewTopicChange={(value) => patch({ newTopic: value })}
          onAdd={topics.handleAddTopic}
          onRemove={topics.handleRemoveTopic}
        />
        <ImageSlotsCard
          blog={blog}
          slots={imageSlots}
          isCoverGenerating={isCoverGenerating}
          onExpand={(url) => patch({ expandedImage: url })}
        />
      </div>

      <ImageManagerCard
        images={state.reviewImages}
        provider={view.selectedProvider}
        saving={state.savingImages}
        actions={images}
      />

      <MarkdownCard
        icon={Wand2}
        title="AI Generated Content"
        body={blog.postContent}
        expanded={state.aiExpanded}
        onToggle={() => toggle('aiExpanded')}
        empty={<GenerateNowEmpty onGenerate={onTriggerInspect} />}
      />

      <MarkdownCard
        icon={Eye}
        title="Original Content"
        body={view.content}
        expanded={state.originalExpanded}
        onToggle={() => toggle('originalExpanded')}
        contentClassName="max-h-150 overflow-y-auto"
        empty={<p className="text-muted-foreground italic">No content available.</p>}
      />
    </div>
  );
}
