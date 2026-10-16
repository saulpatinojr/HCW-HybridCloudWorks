/**
 * One image set in the Image Prompts grid (ADR 0033): its name, what it is
 * for, the shared style, how many prompts and images it has, which pages
 * use it, and up to three of its latest images as thumbnails.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { resolveMediaUrl } from '@/lib/functionsBase';

export default function PromptSetCard({ set, selected, onOpen }) {
  const thumbs = set.images.filter((image) => image.imageUrl && !image.softDeletedAt).slice(0, 3);
  const live = set.images.filter((image) => !image.softDeletedAt && !image.archivedAt).length;
  return (
    <button
      type="button"
      onClick={() => onOpen(set)}
      aria-pressed={selected}
      className={`flex h-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring ${
        selected ? 'border-primary ring-1 ring-primary' : 'border-border'
      } ${set.archivedAt ? 'opacity-70' : ''}`}
    >
      <div className="grid aspect-[3/1] grid-cols-3 gap-px bg-muted/40">
        {thumbs.map((image) => (
          <img
            key={image.id}
            src={resolveMediaUrl(image.imageUrl)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ))}
        {thumbs.length === 0 && (
          <div className="col-span-3 flex items-center justify-center text-xs text-muted-foreground">
            No images generated from this set yet
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold" title={set.name}>
            {set.name}
          </h3>
          <span className="shrink-0 text-xs text-muted-foreground">v{set.version}</span>
        </div>
        {set.purpose && <p className="line-clamp-2 text-xs text-muted-foreground">{set.purpose}</p>}
        {set.theme && (
          <p className="line-clamp-1 text-xs italic text-muted-foreground">Theme: {set.theme}</p>
        )}
        <div className="flex flex-wrap gap-1 text-xs">
          {set.archivedAt && (
            <StatusBadge
              status={{
                id: 'archived',
                label: 'Archived',
                tone: 'off',
                help: 'Hidden from generators and page assignment.',
              }}
              size="xs"
            />
          )}
          {set.legacy && (
            <Badge variant="outline" title="Configured on a single page before sets were global">
              Legacy
            </Badge>
          )}
          {set.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="mt-auto pt-1 text-xs text-muted-foreground">
          {set.prompts.length} prompt{set.prompts.length === 1 ? '' : 's'} · {live} image
          {live === 1 ? '' : 's'} · {set.pages.length} page{set.pages.length === 1 ? '' : 's'}
        </p>
      </div>
    </button>
  );
}
