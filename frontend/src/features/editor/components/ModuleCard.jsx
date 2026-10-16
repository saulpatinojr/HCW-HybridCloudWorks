import { GripVertical, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const ALIGN_OPTIONS = ['left', 'right', 'all'];

/**
 * A single draggable module row in the module list.
 * Drag handlers are passed from the parent (ModulesTab) which owns the useDragDrop instance.
 */
export function ModuleCard({
  module,
  index,
  isEditing,
  dragHandlers,
  isDragging,
  isDraggingOver,
  onEdit,
  onDelete,
  onAlignChange,
}) {
  const dragProps = dragHandlers(index);

  let borderClass = 'border-border';
  if (isDragging) borderClass = 'opacity-40 border-primary/30 scale-95';
  else if (isDraggingOver) borderClass = 'border-primary bg-primary/5 shadow-sm';

  // Preview snippet for the card
  let preview = '';
  if (module.type === 'links') {
    preview = `${(module.links || []).length} link(s)`;
  } else if (module.type === 'picture') {
    preview = module.caption || module.imageUrl || '—';
  } else if (module.type === 'video') {
    preview = module.caption || module.videoUrl || 'YouTube video';
  } else if (module.type === 'spacer') {
    preview = module.style || 'gradient';
  } else {
    const text = String(module.content || '');
    preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  return (
    <div
      {...dragProps}
      className={`
        rounded-md border px-3 py-2 text-xs transition-all duration-150
        ${borderClass}
        ${isEditing ? 'ring-1 ring-primary/50 border-primary/50' : ''}
      `}
    >
      <div className="flex items-center gap-2">
        {/* Drag handle */}
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-grab" />

        {/* Active indicator */}
        {isEditing && <ChevronRight className="h-3.5 w-3.5 text-primary shrink-0" />}

        {/* Type badge */}
        <Badge variant="outline" className="capitalize shrink-0">
          {module.type}
        </Badge>

        {/* Preview text */}
        <span className="text-muted-foreground truncate flex-1 min-w-0">{preview}</span>

        {/* Align buttons (not for spacer) */}
        {module.type !== 'spacer' && (
          <div className="flex items-center gap-1 shrink-0">
            {ALIGN_OPTIONS.map((align) => (
              <Button
                key={align}
                type="button"
                variant={module.align === align ? 'default' : 'outline'}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onAlignChange(index, align);
                }}
              >
                {align.charAt(0).toUpperCase() + align.slice(1)}
              </Button>
            ))}
          </div>
        )}

        {/* Edit / Delete */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant={isEditing ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(index);
            }}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-destructive hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(index);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
