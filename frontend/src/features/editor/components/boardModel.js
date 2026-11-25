import { moduleDataToString } from '../../../lib/moduleParser';

// The Board tab's data: sections and modules as one flat list, and the
// sections rebuilt after that list is reordered.

// ── Board item builder ────────────────────────────────────────────────────────

/**
 * Builds a flat ordered list of {kind, ...} items from sections + modules.
 * Sections own their text. Modules sit immediately after the section
 * whose content contains their placeholder.
 */
export function buildBoardItems(sections, moduleItems, sectionModuleOffsets) {
  const items = [];
  sections.forEach((section, sIdx) => {
    items.push({ kind: 'section', sectionIndex: sIdx, section });
    const start = sectionModuleOffsets[sIdx] ?? 0;
    const end = sectionModuleOffsets[sIdx + 1] ?? moduleItems.length;
    for (let mIdx = start; mIdx < end; mIdx++) {
      items.push({ kind: 'module', globalModuleIndex: mIdx, module: moduleItems[mIdx] });
    }
  });
  return items;
}

/**
 * Given a reordered boardItems array, rebuild sections with their new module sets.
 * Returns the new sections array (content updated, structure preserved).
 *
 * Modules "float" — after a reorder, a module belongs to the last section
 * that preceded it in the board list. Modules before the first section are
 * prepended to section 0.
 */
export function applyBoardReorder(boardItems, originalSections, allModules) {
  // Assign each module to its nearest preceding section
  const sectionModuleLists = originalSections.map(() => []);
  let currentSectionIdx = 0;
  const preludeMods = []; // modules that appear before any section (edge case)

  boardItems.forEach((item) => {
    if (item.kind === 'section') {
      currentSectionIdx = item.sectionIndex;
    } else if (item.kind === 'module') {
      const target = sectionModuleLists[currentSectionIdx];
      if (target) {
        target.push(allModules[item.globalModuleIndex]);
      } else {
        preludeMods.push(allModules[item.globalModuleIndex]);
      }
    }
  });

  // For each section, strip its existing module placeholders and rebuild with new module list
  return originalSections.map((section, sIdx) => {
    const mods = sIdx === 0 ? [...preludeMods, ...sectionModuleLists[0]] : sectionModuleLists[sIdx];
    const strippedContent = section.content
      .replace(/<module[\s\S]*?<\/module>/g, '')
      .replace(/<!-- MODULE_\d+ -->/g, '')
      .trim();
    if (mods.length === 0) {
      return { ...section, content: strippedContent };
    }
    const modStrings = mods.map((m) => moduleDataToString(m)).join('\n\n');
    return { ...section, content: `${strippedContent}\n\n${modStrings}` };
  });
}
