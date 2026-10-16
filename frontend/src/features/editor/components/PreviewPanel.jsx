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

/**
 * Renders a section's content — splitting the text around MODULE placeholders
 * and rendering each module via ModuleContainer.
 */
function SectionPreview({ section, moduleItems, moduleOffset, onEditModule }) {
  const placeholderRegex = /<!-- MODULE_(\d+) -->/g;
  const renderParts = [];
  let lastIdx = 0;
  let localModuleCount = 0;
  let match;
  placeholderRegex.lastIndex = 0;

  while ((match = placeholderRegex.exec(section.content)) !== null) {
    if (match.index > lastIdx) {
      renderParts.push({ kind: 'text', content: section.content.slice(lastIdx, match.index) });
    }
    renderParts.push({ kind: 'module', globalIndex: moduleOffset + localModuleCount });
    localModuleCount++;
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < section.content.length) {
    renderParts.push({ kind: 'text', content: section.content.slice(lastIdx) });
  }

  const anchorId = section.level > 0 ? slugifyHeading(section.title) : null;

  return (
    <div data-anchor-id={anchorId || undefined} className="mb-6">
      {(() => {
        const rows = [];
        for (let i = 0; i < renderParts.length; i += 1) {
          const part = renderParts[i];
          if (part.kind === 'text') {
            rows.push(
              <div key={i} className={ARTICLE_PROSE_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                  {part.content}
                </ReactMarkdown>
              </div>
            );
            continue;
          }

          const module = moduleItems[part.globalIndex];
          const nextPart = renderParts[i + 1];
          const partBetween = renderParts[i + 1];
          const moduleAfterText = renderParts[i + 2];
          const nextModule = nextPart?.kind === 'module' ? moduleItems[nextPart.globalIndex] : null;
          const headingBridgeModule =
            moduleAfterText?.kind === 'module' ? moduleItems[moduleAfterText.globalIndex] : null;

          if (!module) continue;

          if (canPairModules(module, nextModule)) {
            rows.push(
              <div key={`${i}-pair`} className="grid gap-4 md:grid-cols-2 md:items-start">
                <ModuleContainer
                  {...module}
                  paired
                  onEdit={onEditModule ? () => onEditModule(part.globalIndex) : null}
                />
                <ModuleContainer
                  {...nextModule}
                  paired
                  onEdit={onEditModule ? () => onEditModule(nextPart.globalIndex) : null}
                />
              </div>
            );
            i += 1;
            continue;
          }

          if (
            partBetween?.kind === 'text' &&
            isHeadingOnlyTextSegment(partBetween.content) &&
            canPairModules(module, headingBridgeModule)
          ) {
            rows.push(
              <div key={`${i}-heading`} className={HEADING_PROSE_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{partBetween.content}</ReactMarkdown>
              </div>
            );
            rows.push(
              <div key={`${i}-heading-pair`} className="grid gap-4 md:grid-cols-2 md:items-start">
                <ModuleContainer
                  {...module}
                  paired
                  onEdit={onEditModule ? () => onEditModule(part.globalIndex) : null}
                />
                <ModuleContainer
                  {...headingBridgeModule}
                  paired
                  onEdit={onEditModule ? () => onEditModule(moduleAfterText.globalIndex) : null}
                />
              </div>
            );
            i += 2;
            continue;
          }

          rows.push(
            <ModuleContainer
              key={i}
              {...module}
              onEdit={onEditModule ? () => onEditModule(part.globalIndex) : null}
            />
          );
        }
        return rows;
      })()}
    </div>
  );
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
    return <EditorDiffView baseline={baselineDraft} current={fields.draft} />;
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
  useEffect(() => {
    if (!selectedSection || editorMode === 'diff') return;
    if (selectedSection.level <= 0) {
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const anchorId = slugifyHeading(selectedSection.title);
    if (!anchorId) return;

    const timeoutId = window.setTimeout(() => {
      const node = containerRef.current?.querySelector(`[data-anchor-id="${anchorId}"]`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [editorMode, selectedSection]);

  let sectionsToRender;
  if (showFull) {
    sectionsToRender = sections;
  } else if (selectedSection) {
    sectionsToRender = [selectedSection];
  } else {
    sectionsToRender = sections.slice(0, 1);
  }

  const offsetForSection = (index) => {
    if (showFull) return sectionModuleOffsets[index] || 0;
    // When showing single section, offset is the global offset of that section
    return sectionModuleOffsets[selectedSectionIndex] || 0;
  };

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
