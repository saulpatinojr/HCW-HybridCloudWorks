import { GripVertical, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * A single draggable section chip in the section strip.
 *
 * Props are passed explicitly (not from context) because the parent ContentTab
 * instantiates useDragDrop and distributes the handlers here.
 */
export function SectionCard({
  section,
  index,
  isSelected,
  isTextFrame,
  dragHandlers,
  isDragging,
  isDraggingOver,
  onSelect,
  onDisable,
}) {
  const dragProps = dragHandlers(index);

  let borderClass = 'border-border';
  if (isDragging) borderClass = 'opacity-40 border-primary/30 scale-95';
  else if (isDraggingOver) borderClass = 'border-primary bg-primary/10 shadow-md';

  return (
    <div
      {...dragProps}
      onClick={() => onSelect(index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(index);
        }
      }}
      role="button"
      tabIndex={0}
      className={`
        relative flex items-center gap-1.5 rounded-md border px-2.5 py-1.5
        text-xs cursor-pointer select-none transition-all duration-150
        ${borderClass}
        ${isSelected ? 'ring-1 ring-primary border-primary bg-primary/5' : 'hover:border-border/80 hover:bg-muted/40'}
      `}
    >
      <GripVertical className="h-3 w-3 text-muted-foreground shrink-0 cursor-grab" />

      <span className="font-medium truncate max-w-[120px]">
        {section.level > 0 && (
          <span className="text-muted-foreground mr-1">{'#'.repeat(section.level)}</span>
        )}
        {section.title}
      </span>

      {isTextFrame && (
        <Badge variant="outline" className="text-xs h-4 px-1 ml-0.5">
          Frame
        </Badge>
      )}

      <button
        type="button"
        aria-label="Hide section"
        className="ml-auto opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onDisable(index);
        }}
      >
        <EyeOff className="h-3 w-3" />
      </button>
    </div>
  );
}
