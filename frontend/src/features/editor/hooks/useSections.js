import { useState, useMemo, useCallback } from 'react';
import { parseModulesFromMarkdown } from '@/lib/moduleParser';
import {
  alignedFrameContent,
  movedList,
  toggledFrameContent,
  withSectionContent,
} from './sectionEdits';

// ── Pure helpers (module-private) ────────────────────────────────────────────

export function splitDraftIntoSections(text = '') {
  const lines = String(text).split('\n');
  const headingIndexes = [];

  lines.forEach((line, index) => {
    if (/^#{1,6}\s+/.test(line)) headingIndexes.push(index);
  });

  if (headingIndexes.length === 0) {
    return [{ title: 'Body', level: 0, content: String(text || '') }];
  }

  const sections = [];
  if (headingIndexes[0] > 0) {
    const intro = lines.slice(0, headingIndexes[0]).join('\n').trim();
    if (intro) sections.push({ title: 'Intro', level: 0, content: intro });
  }

  headingIndexes.forEach((startIndex, position) => {
    const endIndex = headingIndexes[position + 1] ?? lines.length;
    const sectionLines = lines.slice(startIndex, endIndex);
    const heading = sectionLines[0] || '';
    const level = (heading.match(/^#+/) || [''])[0].length;
    const title = heading.replace(/^#{1,6}\s+/, '').trim() || `Section ${position + 1}`;
    sections.push({ title, level, content: sectionLines.join('\n').trimEnd() });
  });

  return sections.length > 0
    ? sections
    : [{ title: 'Body', level: 0, content: String(text || '') }];
}

export function joinSectionsToDraft(sections = []) {
  return sections
    .map((s) => String(s.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

const TEXT_FRAME_REGEX =
  /^<module\s+type="text"(?:\s+align="(left|right|all)")?\s*>([\s\S]*?)<\/module>\s*$/;

export function getSectionFrameDetails(sectionContent = '') {
  const content = String(sectionContent || '').trim();
  const lines = content.split('\n');
  const hasHeading = /^#{1,6}\s+/.test(lines[0] || '');
  const heading = hasHeading ? lines[0] : '';
  const body = hasHeading ? lines.slice(1).join('\n').trim() : content;
  const match = body.match(TEXT_FRAME_REGEX);

  if (!match) {
    return { isTextFrame: false, align: 'left', heading, body, frameContent: '', hasHeading };
  }

  return {
    isTextFrame: true,
    align: match[1] || 'left',
    heading,
    body,
    frameContent: match[2] || '',
    hasHeading,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Manages section-level state derived from the draft.
 *
 * @param {string}   draft     - Current markdown draft (owned by useEditorState)
 * @param {Function} setDraft  - Stable setter from useEditorState
 */
export function useSections(draft, setDraft) {
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(0);
  const [disabledSections, setDisabledSections] = useState([]);
  const [deletedSections, setDeletedSections] = useState([]);

  const sections = useMemo(() => splitDraftIntoSections(draft), [draft]);

  // Clamp selectedSectionIndex when sections shrink (derived, no effect needed)
  const clampedIndex = Math.min(selectedSectionIndex, Math.max(0, sections.length - 1));
  const selectedSection = sections[clampedIndex] || null;

  const sectionFrameStates = useMemo(
    () => sections.map((s) => getSectionFrameDetails(s.content)),
    [sections]
  );

  const sectionModuleOffsets = useMemo(() => {
    const offsets = [];
    sections.reduce((acc, s) => {
      offsets.push(acc);
      const { modules } = parseModulesFromMarkdown(s.content);
      return acc + modules.length;
    }, 0);
    return offsets;
  }, [sections]);

  // ── Callbacks ──────────────────────────────────────────────────────────────

  const handleSectionSelect = useCallback((index) => {
    setSelectedSectionIndex(index);
  }, []);

  const reorderSections = useCallback(
    (fromIndex, toIndex) => {
      const next = movedList(sections, fromIndex, toIndex);
      if (next) {
        setDraft(joinSectionsToDraft(next));
        setSelectedSectionIndex(toIndex);
      }
    },
    [sections, setDraft]
  );

  const updateSectionAtIndex = useCallback(
    (sectionIndex, updatedContent) => {
      const next = sections.map((s, i) =>
        i === sectionIndex ? { ...s, content: updatedContent } : s
      );
      setDraft(joinSectionsToDraft(next));
      setSelectedSectionIndex(sectionIndex);
    },
    [sections, setDraft]
  );

  const updateSelectedSection = useCallback(
    (updatedContent) => {
      if (selectedSection) updateSectionAtIndex(clampedIndex, updatedContent);
    },
    [selectedSection, clampedIndex, updateSectionAtIndex]
  );

  const moveSelectedSection = useCallback(
    (direction) => {
      // reorderSections ignores a target outside the list.
      if (selectedSection) reorderSections(clampedIndex, clampedIndex + direction);
    },
    [reorderSections, selectedSection, clampedIndex]
  );

  const addSectionAfterSelected = useCallback(() => {
    const next = [...sections];
    const insertAt = selectedSection ? clampedIndex + 1 : next.length;
    next.splice(insertAt, 0, {
      title: 'New Section',
      level: 2,
      content: '## New Section\n\nWrite content here...',
    });
    setDraft(joinSectionsToDraft(next));
    setSelectedSectionIndex(insertAt);
  }, [sections, selectedSection, clampedIndex, setDraft]);

  const removeSelectedSection = useCallback(() => {
    if (selectedSection && sections.length > 1) {
      const next = sections.filter((_, i) => i !== clampedIndex);
      setDraft(joinSectionsToDraft(next));
      setSelectedSectionIndex(Math.max(0, clampedIndex - 1));
      setDeletedSections((prev) => [...prev, selectedSection]);
    }
  }, [sections, selectedSection, clampedIndex, setDraft]);

  const restoreDeletedSection = useCallback(
    (delIdx) => {
      const toRestore = deletedSections[delIdx];
      if (toRestore) {
        const next = [...sections, toRestore];
        setDraft(joinSectionsToDraft(next));
        setSelectedSectionIndex(next.length - 1);
        setDeletedSections((prev) => prev.filter((_, i) => i !== delIdx));
      }
    },
    [deletedSections, sections, setDraft]
  );

  const disableSectionAtIndex = useCallback(
    (index) => {
      const toDisable = sections[index];
      if (toDisable) {
        const next = sections.filter((_, i) => i !== index);
        setDraft(joinSectionsToDraft(next));
        setSelectedSectionIndex(Math.max(0, index > 0 ? index - 1 : 0));
        setDisabledSections((prev) => [...prev, toDisable]);
      }
    },
    [sections, setDraft]
  );

  const enableDisabledSection = useCallback(
    (disIdx) => {
      const toEnable = disabledSections[disIdx];
      if (toEnable) {
        const next = [...sections, toEnable];
        setDraft(joinSectionsToDraft(next));
        setSelectedSectionIndex(next.length - 1);
        setDisabledSections((prev) => prev.filter((_, i) => i !== disIdx));
      }
    },
    [disabledSections, sections, setDraft]
  );

  const toggleSelectedSectionTextFrame = useCallback(() => {
    if (selectedSection) {
      const content = toggledFrameContent(getSectionFrameDetails(selectedSection.content));
      setDraft(joinSectionsToDraft(withSectionContent(sections, clampedIndex, content)));
    }
  }, [sections, selectedSection, clampedIndex, setDraft]);

  const toggleSelectedSectionFrameAlign = useCallback(
    (align) => {
      if (!selectedSection) return;
      const details = getSectionFrameDetails(selectedSection.content);
      const content = alignedFrameContent(details, align);
      if (content !== null) {
        setDraft(joinSectionsToDraft(withSectionContent(sections, clampedIndex, content)));
      }
    },
    [sections, selectedSection, clampedIndex, setDraft]
  );

  return {
    sections,
    selectedSection,
    selectedSectionIndex: clampedIndex,
    sectionFrameStates,
    sectionModuleOffsets,
    disabledSections,
    deletedSections,
    handleSectionSelect,
    reorderSections,
    updateSectionAtIndex,
    updateSelectedSection,
    moveSelectedSection,
    addSectionAfterSelected,
    removeSelectedSection,
    restoreDeletedSection,
    disableSectionAtIndex,
    enableDisabledSection,
    toggleSelectedSectionTextFrame,
    toggleSelectedSectionFrameAlign,
  };
}
