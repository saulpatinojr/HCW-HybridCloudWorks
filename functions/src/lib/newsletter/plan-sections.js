/**
 * plan-sections.js — which newsletter sections a build collects, in what
 * order and with what item caps, from the saved Content list (issue.js
 * builds the issue and exports planSections again).
 */

/**
 * The registry sections a build collects, from the saved Content list: the
 * enabled ones in the saved order with their item caps. A registered section
 * the list does not name is collected after them at the default cap, the same
 * rule the settings normalizer applies, so a section passed in that the saved
 * list predates is never silently skipped.
 */
export function planSections(registry, entries = []) {
  const byId = new Map(registry.map((section) => [section.id, section]));
  const named = new Set();
  const sections = [];
  const maxItems = {};
  for (const entry of entries) {
    const section = byId.get(entry?.id);
    if (!section || named.has(section.id)) continue;
    named.add(section.id);
    if (!entry.enabled) continue;
    sections.push(section);
    if (Number.isInteger(entry.maxItems)) maxItems[section.id] = entry.maxItems;
  }
  for (const section of registry) {
    if (!named.has(section.id)) sections.push(section);
  }
  return { sections, maxItems };
}
