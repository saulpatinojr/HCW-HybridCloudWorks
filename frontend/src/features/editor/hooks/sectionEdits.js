// Pure edits on the list of sections, used by useSections. Each returns a new
// list or new content and never changes its input.

const FRAME_ALIGNS = ['left', 'right', 'all'];

/**
 * The list with the item at `fromIndex` moved to `toIndex`, or null when
 * either index is outside the list or they are the same.
 */
export function movedList(list, fromIndex, toIndex) {
  const inRange = (i) => i >= 0 && i < list.length;
  if (fromIndex === toIndex || !inRange(fromIndex) || !inRange(toIndex)) return null;
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** The sections with the one at `index` given new content. */
export function withSectionContent(sections, index, content) {
  const next = [...sections];
  next[index] = { ...sections[index], content };
  return next;
}

function composeSectionWithFrame(details, frameMarkup) {
  if (details.hasHeading) return `${details.heading}\n\n${frameMarkup}`.trim();
  return frameMarkup;
}

/**
 * The section's content with its text frame taken off, or put on (left
 * aligned) when it has none. `details` is getSectionFrameDetails' answer.
 */
export function toggledFrameContent(details) {
  if (details.isTextFrame) {
    const plain = details.frameContent || '';
    return details.hasHeading ? `${details.heading}\n\n${plain}`.trim() : plain;
  }
  const base = details.body || 'Write framed text here.';
  const framed = `<module type="text" align="left">${base}</module>`;
  return composeSectionWithFrame(details, framed);
}

/**
 * The section's content with its text frame set to `align`, or null when the
 * alignment is not one we know or the section has no text frame.
 */
export function alignedFrameContent(details, align) {
  if (!FRAME_ALIGNS.includes(align) || !details.isTextFrame) return null;
  const framed = `<module type="text" align="${align}">${details.frameContent}</module>`;
  return composeSectionWithFrame(details, framed);
}
