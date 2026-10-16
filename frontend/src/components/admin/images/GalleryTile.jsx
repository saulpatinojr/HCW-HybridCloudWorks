/**
 * One image in the gallery grid (ADR 0033): the picture first, the facts
 * as small chips, and the actions on hover or keyboard focus. Selection is a
 * real checkbox so bulk actions are reachable without a mouse.
 */
import React from 'react';
import { Archive, Copy, ExternalLink, Info, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { formatDimensions, getSourceLabel } from '@/lib/imageGallery';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { safeUrl } from '@/lib/safeUrl';

export function tileState(item) {
  if (item.softDeletedAt)
    return {
      id: 'trash',
      label: 'In trash',
      tone: 'bad',
      help: 'Hidden everywhere; restore or delete permanently.',
    };
  if (item.archivedAt)
    return {
      id: 'archived',
      label: 'Archived',
      tone: 'off',
      help: 'Kept but hidden from pickers.',
    };
  return null;
}

/** The actions shown on hover or keyboard focus. */
function TileActions({
  item,
  state,
  url,
  copied,
  onOpen,
  onCopy,
  onReuse,
  onArchive,
  onTrash,
  onRestore,
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-end gap-1 bg-linear-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => onOpen(item)}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" /> Details
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => onCopy(url, `url-${item.id}`)}
        disabled={!url}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" /> {copied ? 'Copied' : 'Copy URL'}
      </Button>
      {!state && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onReuse(item)}
          disabled={!url}
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> Use
        </Button>
      )}
      {!state && onArchive && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onArchive(item)}
          title="Archive: keep, but hide from pickers"
        >
          <Archive className="h-3.5 w-3.5" aria-hidden="true" /> Archive
        </Button>
      )}
      {state ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onRestore(item)}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onTrash(item)}
          title="Move to trash; restore from the Trash filter"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Trash
        </Button>
      )}
    </div>
  );
}

/** The facts under the picture: title, chips, folder and size, usage, the file link. */
function TileFooter({ item, url, resolved }) {
  const dims = formatDimensions(item);
  return (
    <div className="flex flex-1 flex-col gap-1.5 p-3">
      <p className="truncate text-sm font-medium" title={item.title}>
        {item.title}
      </p>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Badge variant="outline">{getSourceLabel(item.source)}</Badge>
        {item.provider && <Badge variant="outline">{String(item.provider).toUpperCase()}</Badge>}
        {item.slot && <Badge variant="secondary">{item.slot}</Badge>}
        {item.promptSet && (
          <Badge variant="secondary" title={`Image set: ${item.promptSet}`}>
            Set: {item.promptSet}
          </Badge>
        )}
        {item.customTags.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
        {item.customTags.length > 3 && (
          <span className="text-muted-foreground">+{item.customTags.length - 3}</span>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {item.folder}
          {dims ? ` · ${dims}` : ''}
        </span>
        <span title={item.usageCount ? 'Content using this image' : 'Not used by any content'}>
          {item.usageCount ? `Used in ${item.usageCount}` : 'Unused'}
        </span>
      </div>
      {url && (
        <a
          href={safeUrl(resolved)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Open file <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export default function GalleryTile({
  item,
  selected,
  busy,
  copied,
  onToggleSelect,
  onOpen,
  onReuse,
  onCopy,
  onArchive,
  onTrash,
  onRestore,
}) {
  const url = item.imageUrl || '';
  const resolved = resolveMediaUrl(url);
  const state = tileState(item);
  const alt = item.altText || item.title || item.articleId || 'Gallery image';
  const checkboxId = `gallery-select-${item.id}`;

  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring ${
        selected ? 'border-primary ring-1 ring-primary' : 'border-border'
      } ${busy ? 'opacity-60' : ''}`}
      aria-busy={busy || undefined}
    >
      <div className="relative aspect-video bg-muted/40">
        {url ? (
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="block h-full w-full focus:outline-none"
            aria-label={`Open details for ${item.title}`}
          >
            <img src={resolved} alt={alt} loading="lazy" className="h-full w-full object-cover" />
          </button>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            No image file recorded
          </div>
        )}
        <div className="absolute left-2 top-2 rounded bg-background/80 p-1 backdrop-blur">
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(item.id)}
            className="h-4 w-4 cursor-pointer align-middle"
            aria-label={`Select ${item.title}`}
          />
        </div>
        {(state || item.duplicateOf) && (
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
            {state && <StatusBadge status={state} size="xs" />}
            {item.duplicateOf && (
              <Badge
                variant="secondary"
                className="text-xs"
                title="Same bytes or URL as an earlier image in the gallery"
              >
                Duplicate
              </Badge>
            )}
          </div>
        )}
        <TileActions
          item={item}
          state={state}
          url={url}
          copied={copied}
          onOpen={onOpen}
          onCopy={onCopy}
          onReuse={onReuse}
          onArchive={onArchive}
          onTrash={onTrash}
          onRestore={onRestore}
        />
      </div>

      <TileFooter item={item} url={url} resolved={resolved} />
    </article>
  );
}
