import { useState } from 'react';
import { useEditor } from '../context/EditorContext';
import { useDragDrop } from '../hooks/useDragDrop';
import { ModuleCard } from './ModuleCard';
import { ModuleForm } from './ModuleForm';

function getSectionSubtitle(showAll, sectionModuleCount) {
  if (showAll) return 'Drag to reorder, click edit to modify.';
  if (sectionModuleCount === 0) return 'No modules in this section yet.';
  return 'Showing modules embedded in this section only.';
}

export function ModulesTab() {
  const {
    moduleItems,
    editingModuleIndex,
    editModule,
    deleteModule,
    setModuleAlignAtIndex,
    reorderModules,
    selectedSection,
    selectedSectionIndex,
    sectionModuleOffsets,
  } = useEditor();

  const [showAll, setShowAll] = useState(false);

  // Compute which global module indices belong to the currently selected section.
  // sectionModuleOffsets[i] is the global index where section i's modules start.
  // The end is sectionModuleOffsets[i+1] (or moduleItems.length for the last section).
  const sectionStart = sectionModuleOffsets[selectedSectionIndex] ?? 0;
  const sectionEnd = sectionModuleOffsets[selectedSectionIndex + 1] ?? moduleItems.length;
  const sectionModuleCount = sectionEnd - sectionStart;

  // Decide which modules to show
  const visibleItems = showAll ? moduleItems : moduleItems.slice(sectionStart, sectionEnd);

  const visibleOffset = showAll ? 0 : sectionStart;

  const moduleDrag = useDragDrop(moduleItems, reorderModules, { stopPropagation: true });

  const sectionLabel = selectedSection ? `"${selectedSection.title}"` : 'selected section';

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Header with section filter toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {showAll
              ? `All modules — ${moduleItems.length}/10`
              : `Modules in ${sectionLabel} — ${sectionModuleCount}`}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {getSectionSubtitle(showAll, sectionModuleCount)}
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors shrink-0"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Filter to section' : 'Show all'}
        </button>
      </div>

      {/* Module list */}
      <div>
        {visibleItems.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {showAll
              ? 'No modules yet. Use the form below to add one.'
              : `No modules in ${sectionLabel}. Add one below or switch to "Show all".`}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleItems.map((module, localIndex) => {
              const globalIndex = visibleOffset + localIndex;
              return (
                <ModuleCard
                  key={globalIndex}
                  module={module}
                  index={globalIndex}
                  isEditing={editingModuleIndex === globalIndex}
                  dragHandlers={moduleDrag.dragHandlers}
                  isDragging={moduleDrag.isDragging(globalIndex)}
                  isDraggingOver={moduleDrag.isDraggingOver(globalIndex)}
                  onEdit={editModule}
                  onDelete={deleteModule}
                  onAlignChange={setModuleAlignAtIndex}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Module editor form */}
      <ModuleForm />
    </div>
  );
}
