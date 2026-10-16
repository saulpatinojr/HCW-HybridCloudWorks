import {
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  PanelLeft,
  RotateCcw,
  Eye,
  Code,
  GitCompare,
  AlignJustify,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { stripHtmlTags } from '@/lib/blogUtils';
import { useEditor } from '../context/EditorContext';
import { useDragDrop } from '../hooks/useDragDrop';
import { SectionCard } from './SectionCard';

function renderEditingSurface({
  editorMode,
  fields,
  setField,
  selectedSection,
  selectedSectionIndex,
  sections,
  updateSelectedSection,
}) {
  if (editorMode === 'raw') {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground uppercase tracking-wide">Full raw draft</p>
        <Textarea
          value={fields.draft}
          onChange={(e) => setField('draft', e.target.value)}
          className="min-h-[400px] text-sm font-mono resize-y"
          placeholder="Full markdown draft..."
        />
      </div>
    );
  }
  if (editorMode === 'diff') {
    return (
      <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        Diff view is shown in the Preview panel on the right.
      </div>
    );
  }
  if (selectedSection) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          Editing: <span className="text-foreground font-medium">{selectedSection.title}</span> ·
          Section {selectedSectionIndex + 1} of {sections.length}
        </p>
        <Textarea
          value={selectedSection.content}
          onChange={(e) => updateSelectedSection(e.target.value)}
          className="min-h-[320px] text-sm font-mono resize-y"
          placeholder="Write section content in Markdown..."
        />
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground text-sm">
      Select a section above to start editing.
    </div>
  );
}

export function ContentTab() {
  const {
    sections,
    selectedSection,
    selectedSectionIndex,
    sectionFrameStates,
    disabledSections,
    deletedSections,
    handleSectionSelect,
    reorderSections,
    updateSelectedSection,
    moveSelectedSection,
    addSectionAfterSelected,
    removeSelectedSection,
    restoreDeletedSection,
    disableSectionAtIndex,
    enableDisabledSection,
    toggleSelectedSectionTextFrame,
    toggleSelectedSectionFrameAlign,
    fields,
    setField,
    editorMode,
    setEditorMode,
  } = useEditor();

  const sectionDrag = useDragDrop(sections, reorderSections);

  const frameState = selectedSection
    ? sectionFrameStates[selectedSectionIndex] || { isTextFrame: false, align: 'left' }
    : null;

  const wordCount = fields.draft
    ? stripHtmlTags(fields.draft).split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Top bar: sections label + word count + view mode toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Sections ({sections.length}) · {wordCount} words
        </p>
        <div className="flex items-center gap-1">
          {[
            { key: 'visual', icon: Eye, label: 'Preview' },
            { key: 'sections', icon: AlignJustify, label: 'Sections' },
            { key: 'raw', icon: Code, label: 'Raw' },
            { key: 'diff', icon: GitCompare, label: 'Diff' },
          ].map(({ key, icon: Icon, label }) => (
            <Button
              key={key}
              type="button"
              variant={editorMode === key ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setEditorMode(key)}
              title={label}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="ml-1 hidden sm:inline">{label}</span>
            </Button>
          ))}
        </div>
      </div>

      {/* Section strip */}
      <div>
        <div className="mb-2"></div>

        <div className="flex flex-wrap gap-1.5">
          {sections.map((section, index) => (
            <SectionCard
              key={`section-${index}`}
              section={section}
              index={index}
              isSelected={selectedSectionIndex === index}
              isTextFrame={sectionFrameStates[index]?.isTextFrame || false}
              dragHandlers={sectionDrag.dragHandlers}
              isDragging={sectionDrag.isDragging(index)}
              isDraggingOver={sectionDrag.isDraggingOver(index)}
              onSelect={handleSectionSelect}
              onDisable={disableSectionAtIndex}
            />
          ))}
        </div>
      </div>

      {/* Section action toolbar */}
      {selectedSection && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => moveSelectedSection(-1)}
            disabled={selectedSectionIndex === 0}
          >
            <ArrowUp className="h-3 w-3 mr-1" />
            Up
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => moveSelectedSection(1)}
            disabled={selectedSectionIndex === sections.length - 1}
          >
            <ArrowDown className="h-3 w-3 mr-1" />
            Down
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={addSectionAfterSelected}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Below
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={removeSelectedSection}
            disabled={sections.length <= 1}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Delete
          </Button>

          {/* Text frame toggle */}
          <div className="flex items-center gap-1 ml-1">
            <Button
              variant={frameState?.isTextFrame ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={toggleSelectedSectionTextFrame}
            >
              <PanelLeft className="h-3 w-3 mr-1" />
              {frameState?.isTextFrame ? 'Unframe' : 'Frame'}
            </Button>
            {frameState?.isTextFrame && (
              <>
                {['left', 'right', 'all'].map((a) => (
                  <Button
                    key={a}
                    variant={frameState.align === a ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => toggleSelectedSectionFrameAlign(a)}
                  >
                    {a.charAt(0).toUpperCase() + a.slice(1)}
                  </Button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Main editing surface — mode-driven */}
      {renderEditingSurface({
        editorMode,
        fields,
        setField,
        selectedSection,
        selectedSectionIndex,
        sections,
        updateSelectedSection,
      })}

      {/* Disabled sections */}
      {disabledSections.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Hidden sections (click to restore)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {disabledSections.map((section, disIdx) => (
              <button
                key={disIdx}
                type="button"
                className="rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground transition-colors"
                onClick={() => enableDisabledSection(disIdx)}
                title="Click to re-enable"
              >
                {section.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Deleted sections */}
      {deletedSections.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Deleted sections</p>
          <div className="flex flex-wrap gap-1.5">
            {deletedSections.map((section, delIdx) => (
              <Button
                key={delIdx}
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => restoreDeletedSection(delIdx)}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {section.title}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
