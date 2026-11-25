import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ModuleContainer } from '@/components/modules/InlineModules';
import EditorDiffView from '@/components/admin/EditorDiffView';
import { Button } from '@/components/ui/button';
import { useEditor } from '../context/EditorContext';
import { canPairModules, isHeadingOnlyTextSegment } from '@/lib/modulePairing';
import { ARTICLE_PROSE_CLASS, HEADING_PROSE_CLASS } from '@/lib/articleStyles';
import { markdownCodeComponents } from '@/components/shared/CodeBlock';

function slugifyHeading(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Splits a section's content around its MODULE placeholders into text parts
// and module parts; a module part carries the module's index in the whole draft.
function splitSectionParts(content, moduleOffset) {
  const placeholderRegex = /<!-- MODULE_(\d+) -->/g;
  const renderParts = [];
  let lastIdx = 0;
  let localModuleCount = 0;
  let match;
  placeholderRegex.lastIndex = 0;

  while ((match = placeholderRegex.exec(content)) !== null) {
    if (match.index > lastIdx) {
      renderParts.push({ kind: 'text', content: content.slice(lastIdx, match.index) });
    }
    renderParts.push({ kind: 'module', globalIndex: moduleOffset + localModuleCount });
    localModuleCount++;
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < content.length) {
    renderParts.push({ kind: 'text', content: content.slice(lastIdx) });
  }
  return renderParts;
}

// The module a part points at, or null when the part is not a module.
function moduleOfPart(part, moduleItems) {
  return part?.kind === 'module' ? moduleItems[part.globalIndex] : null;
}

function ModulePairRow({ left, right, editFor }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 md:items-start">
      <ModuleContainer {...left.module} paired onEdit={editFor(left.globalIndex)} />
      <ModuleContainer {...right.module} paired onEdit={editFor(right.globalIndex)} />
    </div>
  );
}

// The rows for the module part at `i`, and how many parts they used up.
function moduleRows(renderParts, i, moduleItems, editFor) {
  const part = renderParts[i];
  const module = moduleItems[part.globalIndex];
  if (!module) return { rows: [], used: 1 };

  const nextPart = renderParts[i + 1];
  const moduleAfterText = renderParts[i + 2];
  const nextModule = moduleOfPart(nextPart, moduleItems);
  const headingBridgeModule = moduleOfPart(moduleAfterText, moduleItems);
  const current = { module, globalIndex: part.globalIndex };

  if (canPairModules(module, nextModule)) {
    const right = { module: nextModule, globalIndex: nextPart.globalIndex };
    return {
      rows: [<ModulePairRow key={`${i}-pair`} left={current} right={right} editFor={editFor} />],
      used: 2,
    };
  }

  if (
    nextPart?.kind === 'text' &&
    isHeadingOnlyTextSegment(nextPart.content) &&
    canPairModules(module, headingBridgeModule)
  ) {
    const right = { module: headingBridgeModule, globalIndex: moduleAfterText.globalIndex };
    return {
      rows: [
        <div key={`${i}-heading`} className={HEADING_PROSE_CLASS}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{nextPart.content}</ReactMarkdown>
        </div>,
        <ModulePairRow key={`${i}-heading-pair`} left={current} right={right} editFor={editFor} />,
      ],
      used: 3,
    };
  }

  return {
    rows: [<ModuleContainer key={i} {...module} onEdit={editFor(part.globalIndex)} />],
    used: 1,
  };
}

function buildPreviewRows(renderParts, moduleItems, onEditModule) {
  const editFor = (globalIndex) => (onEditModule ? () => onEditModule(globalIndex) : null);
  const rows = [];
  let i = 0;
  while (i < renderParts.length) {
    const part = renderParts[i];
    if (part.kind === 'text') {
      rows.push(
        <div key={i} className={ARTICLE_PROSE_CLASS}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
            {part.content}
          </ReactMarkdown>
        </div>
      );
      i += 1;
    } else {
      const { rows: added, used } = moduleRows(renderParts, i, moduleItems, editFor);
      rows.push(...added);
      i += used;
    }
  }
  return rows;
}

/**
 * Renders a section's content — splitting the text around MODULE placeholders
 * and rendering each module via ModuleContainer.
 */
function SectionPreview({ section, moduleItems, moduleOffset, onEditModule }) {
  const renderParts = splitSectionParts(section.content, moduleOffset);
  const anchorId = section.level > 0 ? slugifyHeading(section.title) : null;

  return (
    <div data-anchor-id={anchorId || undefined} className="mb-6">
      {buildPreviewRows(renderParts, moduleItems, onEditModule)}
    </div>
  );
}

// Scroll to the selected section's heading (or the top for an untitled one).
// Returns the effect cleanup when a scroll was scheduled.
function scrollToSelectedSection(containerRef, selectedSection, editorMode) {
  if (!selectedSection || editorMode === 'diff') return undefined;
  if (selectedSection.level <= 0) {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    return undefined;
  }
  const anchorId = slugifyHeading(selectedSection.title);
  if (!anchorId) return undefined;

  const timeoutId = window.setTimeout(() => {
    const node = containerRef.current?.querySelector(`[data-anchor-id="${anchorId}"]`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);

  return () => window.clearTimeout(timeoutId);
}

function pickSectionsToRender(showFull, sections, selectedSection) {
  if (showFull) return sections;
  if (selectedSection) return [selectedSection];
  return sections.slice(0, 1);
}

function renderPreviewContent({
  editorMode,
  baselineDraft,
  fields,
  sectionsToRender,
  showFull,
  selectedSectionIndex,
  moduleItems,
  offsetForSection,
  editModule,
}) {
  if (editorMode === 'diff') {
    return <EditorDiffView baseText={baselineDraft} editedText={fields.draft} />;
  }
  if (sectionsToRender.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>;
  }
  return sectionsToRender.map((section, i) => {
    const globalIndex = showFull ? i : selectedSectionIndex;
    return (
      <SectionPreview
        key={globalIndex}
        section={section}
        moduleItems={moduleItems}
        moduleOffset={offsetForSection(globalIndex)}
        onEditModule={editModule}
      />
    );
  });
}

export function PreviewPanel() {
  const {
    sections,
    selectedSectionIndex,
    selectedSection,
    moduleItems,
    sectionModuleOffsets,
    baselineDraft,
    fields,
    editorMode,
    editModule,
  } = useEditor();

  const [showFull, setShowFull] = useState(false);
  const containerRef = useRef(null);

  // Scroll to selected section heading when selection changes
  useEffect(
    () => scrollToSelectedSection(containerRef, selectedSection, editorMode),
    [editorMode, selectedSection]
  );

  const sectionsToRender = pickSectionsToRender(showFull, sections, selectedSection);

  // When showing single section, offset is the global offset of that section
  const offsetForSection = (index) =>
    sectionModuleOffsets[showFull ? index : selectedSectionIndex] || 0;

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Preview</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowFull((v) => !v)}
        >
          {showFull ? 'Current section' : 'Full draft'}
        </Button>
      </div>

      {/* Preview content */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4">
        {renderPreviewContent({
          editorMode,
          baselineDraft,
          fields,
          sectionsToRender,
          showFull,
          selectedSectionIndex,
          moduleItems,
          offsetForSection,
          editModule,
        })}
      </div>
    </div>
  );
}
