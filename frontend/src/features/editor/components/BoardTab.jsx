import { useMemo } from 'react';
import {
  GripVertical,
  Pencil,
  Trash2,
  Lightbulb,
  CheckCircle2,
  Link2,
  Image as ImageIcon,
  AlignLeft,
  FileCode2,
  Video,
  Minus,
  Hash,
  Quote,
  BarChart3,
  Table2,
  ListOrdered,
  Megaphone,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useEditor } from '../context/EditorContext';
import { useDragDrop } from '../hooks/useDragDrop';
import { buildBoardItems } from './boardModel';
import { getModulePreview } from './ModulePreview';

// ── Module type config ────────────────────────────────────────────────────────

const MODULE_ICONS = {
  fact: Lightbulb,
  recommendation: CheckCircle2,
  links: Link2,
  picture: ImageIcon,
  video: Video,
  text: AlignLeft,
  code: FileCode2,
  spacer: Minus,
  design: Workflow,
  pull_quote: Quote,
  stat_board: BarChart3,
  comparison: Table2,
  timeline: ListOrdered,
  callout: Megaphone,
};

const MODULE_COLORS = {
  fact: 'border-blue-500/40 bg-blue-500/5',
  recommendation: 'border-emerald-500/40 bg-emerald-500/5',
  links: 'border-blue-400/40 bg-blue-400/5',
  picture: 'border-purple-500/40 bg-purple-500/5',
  video: 'border-rose-500/40 bg-rose-500/5',
  text: 'border-sky-500/40 bg-sky-500/5',
  code: 'border-amber-500/40 bg-amber-500/5',
  spacer: 'border-slate-500/30 bg-slate-500/5',
  design: 'border-teal-500/40 bg-teal-500/5',
  pull_quote: 'border-violet-500/40 bg-violet-500/5',
  stat_board: 'border-cyan-500/40 bg-cyan-500/5',
  comparison: 'border-indigo-500/40 bg-indigo-500/5',
  timeline: 'border-orange-500/40 bg-orange-500/5',
  callout: 'border-yellow-500/40 bg-yellow-500/5',
};

// The board list builders live in boardModel.js, the previews in ModulePreview.jsx.

// ── Board cards ───────────────────────────────────────────────────────────────

function SectionBoardCard({
  item,
  boardIndex,
  dragHandlers,
  isDragging,
  isDraggingOver,
  onSelectSection,
}) {
  const dragProps = dragHandlers(boardIndex);
  let border = 'border-border';
  if (isDragging) border = 'opacity-40 border-primary/20 scale-95';
  else if (isDraggingOver) border = 'border-primary bg-primary/5 shadow-md';

  const firstLine = item.section.content.split('\n').find((l) => l.trim()) || '';
  const heading = firstLine.replace(/^#{1,6}\s+/, '').trim();
  const level = (firstLine.match(/^(#+)/) || ['', ''])[1].length || 0;

  return (
    <div
      {...dragProps}
      className={`rounded-lg border-2 bg-background px-4 py-3 transition-all duration-150 cursor-grab ${border}`}
    >
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
        <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm flex-1 truncate">{heading || item.section.title}</span>
        {level > 0 && (
          <Badge variant="outline" className="text-xs shrink-0">
            H{level}
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onSelectSection(item.sectionIndex);
          }}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function ModuleBoardCard({
  item,
  boardIndex,
  dragHandlers,
  isDragging,
  isDraggingOver,
  onEditModule,
  onDeleteModule,
  onAlignChange,
}) {
  const dragProps = dragHandlers(boardIndex);
  const Icon = MODULE_ICONS[item.module.type] || Lightbulb;
  const colorClass = MODULE_COLORS[item.module.type] || 'border-border bg-background';

  let border = colorClass;
  if (isDragging) border = `${colorClass} opacity-40 scale-95`;
  else if (isDraggingOver) border = 'border-primary bg-primary/5 shadow-md';

  const ALIGN_OPTIONS = ['left', 'right', 'all'];

  return (
    <div
      {...dragProps}
      className={`rounded-lg border ml-6 px-3 py-2.5 transition-all duration-150 cursor-grab ${border}`}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <Icon className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />

        <div className="flex-1 min-w-0 space-y-1">
          {/* Header row */}
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="capitalize text-xs shrink-0">
              {item.module.type}
            </Badge>
            {item.module.type !== 'spacer' && (
              <div className="flex items-center gap-0.5">
                {ALIGN_OPTIONS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAlignChange(item.globalModuleIndex, a);
                    }}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                      item.module.align === a
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {a.charAt(0).toUpperCase() + a.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Content preview */}
          <div className="pl-0.5">{getModulePreview(item.module)}</div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={(e) => {
              e.stopPropagation();
              onEditModule(item.globalModuleIndex);
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
              onDeleteModule(item.globalModuleIndex);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Drop zone between items ───────────────────────────────────────────────────

function _DropZone({ boardIndex, dragHandlers, isDraggingOver }) {
  const dragProps = dragHandlers(boardIndex);
  return (
    <div
      {...dragProps}
      className={`h-2 rounded transition-all duration-150 mx-2 ${
        isDraggingOver ? 'h-8 bg-primary/20 border border-dashed border-primary' : ''
      }`}
    />
  );
}

// ── Main Board Tab ────────────────────────────────────────────────────────────

export function BoardTab() {
  const {
    sections,
    moduleItems,
    sectionModuleOffsets,
    reorderBoardItems,
    editModule,
    deleteModule,
    setModuleAlignAtIndex,
    handleSectionSelect,
    setActiveTab,
  } = useEditor();

  const boardItems = useMemo(
    () => buildBoardItems(sections, moduleItems, sectionModuleOffsets),
    [sections, moduleItems, sectionModuleOffsets]
  );

  const boardDrag = useDragDrop(boardItems, reorderBoardItems);

  if (boardItems.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No content yet. Add sections and modules in the Content and Modules tabs.
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Board — {sections.length} section{sections.length !== 1 ? 's' : ''}, {moduleItems.length}{' '}
          module{moduleItems.length !== 1 ? 's' : ''}
        </p>
        <p className="text-xs text-muted-foreground">
          Drag to reorder. Modules can move between sections.
        </p>
      </div>

      {boardItems.map((item, boardIndex) => {
        if (item.kind === 'section') {
          return (
            <SectionBoardCard
              key={`section-${item.sectionIndex}`}
              item={item}
              boardIndex={boardIndex}
              dragHandlers={boardDrag.dragHandlers}
              isDragging={boardDrag.isDragging(boardIndex)}
              isDraggingOver={boardDrag.isDraggingOver(boardIndex)}
              onSelectSection={(sIdx) => {
                handleSectionSelect(sIdx);
                setActiveTab('content');
              }}
            />
          );
        }

        return (
          <ModuleBoardCard
            key={`module-${item.globalModuleIndex}`}
            item={item}
            boardIndex={boardIndex}
            dragHandlers={boardDrag.dragHandlers}
            isDragging={boardDrag.isDragging(boardIndex)}
            isDraggingOver={boardDrag.isDraggingOver(boardIndex)}
            onEditModule={(idx) => {
              editModule(idx);
              setActiveTab('modules');
            }}
            onDeleteModule={deleteModule}
            onAlignChange={setModuleAlignAtIndex}
          />
        );
      })}
    </div>
  );
}
