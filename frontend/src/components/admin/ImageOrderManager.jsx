import { useState } from 'react';
import { GripVertical, Trash2, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { safeUrl } from '@/lib/safeUrl';

function moveItem(items, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function ImageOrderManager({
  images,
  onChange,
  onRemove,
  title = 'Image Order',
  description = 'Drag and drop to set final image order.',
  emptyMessage = 'No images available.',
  readOnly = false,
}) {
  const [dragIndex, setDragIndex] = useState(-1);
  const [dragOverIndex, setDragOverIndex] = useState(-1);

  const handleDrop = (targetIndex) => {
    if (readOnly || dragIndex < 0 || targetIndex < 0) {
      setDragIndex(-1);
      setDragOverIndex(-1);
      return;
    }

    const next = moveItem(images, dragIndex, targetIndex);
    setDragIndex(-1);
    setDragOverIndex(-1);
    onChange(next);
  };

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="space-y-2">
          {images.map((image, index) => {
            const isHero = index === 0;
            const isDragging = dragIndex === index;
            const isDragOver = dragOverIndex === index && dragIndex !== index;
            return (
              <div
                key={image.id || `${index}-${image.url}`}
                draggable={!readOnly}
                onDragStart={() => setDragIndex(index)}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!readOnly) setDragOverIndex(index);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragEnd={() => {
                  setDragIndex(-1);
                  setDragOverIndex(-1);
                }}
                onDrop={() => handleDrop(index)}
                className={[
                  'flex items-center gap-3 rounded-md border p-2 transition-colors',
                  isDragging ? 'opacity-60 border-primary/40 bg-primary/5' : 'border-border',
                  isDragOver ? 'border-primary bg-primary/5' : '',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <GripVertical className="h-4 w-4" />
                  <span className="text-xs w-4 text-center">{index + 1}</span>
                </div>
                <img
                  src={safeUrl(image.url)}
                  alt={image.label || `Image ${index + 1}`}
                  className="h-14 w-20 rounded object-cover shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={isHero ? 'default' : 'secondary'} className="text-xs">
                      {isHero ? 'Hero' : `Secondary ${index}`}
                    </Badge>
                    {image.sourceLabel && (
                      <Badge variant="outline" className="text-xs">
                        {image.sourceLabel}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground truncate">{image.url}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                    <a
                      href={safeUrl(image.url)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open image"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                  {onRemove && !readOnly && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => onRemove(index)}
                      aria-label="Remove image"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ImageOrderManager;
