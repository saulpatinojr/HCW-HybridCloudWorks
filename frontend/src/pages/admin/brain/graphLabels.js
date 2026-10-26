import { nodeHeading } from './mapPreferences';

const overlaps = (a, b) =>
  a.left < b.right + 4 && a.right + 4 > b.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top;
export function labelLines(title) {
  const words = title.trim().split(/\s+/).slice(0, 4);
  if (words.length < 2) return [title.slice(0, 28)];
  let split = 1;
  for (let i = 2; i < words.length; i++) {
    const cost = (at) =>
      Math.max(words.slice(0, at).join(' ').length, words.slice(at).join(' ').length);
    if (cost(i) < cost(split)) split = i;
  }
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')].map((line) =>
    line.length > 28 ? `${line.slice(0, 27)}�` : line
  );
}

function priority(node, focusId, neighbors) {
  if (node.id === focusId) return 10000;
  if (neighbors.get(focusId)?.has(node.id)) return 1000;
  if (['topic', 'project'].includes(node.type)) return 500;
  if (['note', 'conflict'].includes(node.type)) return 200;
  return neighbors.get(node.id)?.size || 0;
}
// Lay out a bounded set of labels in canvas pixels, independently of the
// force engine. Full titles remain available in keyboard navigation/details.
export function graphLabels(
  nodes,
  {
    focusId,
    neighbors,
    showAll,
    width,
    height,
    fontSize = 11,
    viewport = { left: 0, top: 0, right: width, bottom: height },
  }
) {
  const occupied = [
    { left: 0, right: 170, top: 0, bottom: 76 },
    ...nodes.map((node) => ({
      left: node.x - 12,
      right: node.x + 12,
      top: node.y - 12,
      bottom: node.y + 12,
    })),
  ];
  const placements = new Map();
  const candidates = [...nodes].sort(
    (a, b) => priority(b, focusId, neighbors) - priority(a, focusId, neighbors)
  );
  for (const node of candidates.slice(0, 60)) {
    if (!showAll && node.id !== focusId && !neighbors.get(focusId)?.has(node.id)) continue;
    const lines = labelLines(nodeHeading(node));
    const text = lines.join(' ');
    const lineHeight = fontSize * 1.25;
    const extraHeight = (lines.length - 1) * lineHeight;
    const textWidth = Math.max(...lines.map((line) => line.length)) * fontSize * 0.61;
    const options = [
      { dx: 0, dy: -23 - extraHeight, anchor: 'middle' },
      { dx: 0, dy: 29, anchor: 'middle' },
      { dx: 22, dy: 4 - extraHeight / 2, anchor: 'start' },
      { dx: -22, dy: 4 - extraHeight / 2, anchor: 'end' },
    ]
      .map((label) => {
        const x = node.x + label.dx;
        let left = x;
        if (label.anchor === 'middle') left -= textWidth / 2;
        if (label.anchor === 'end') left -= textWidth;
        return {
          ...label,
          text,
          lines,
          lineHeight,
          fontSize,
          box: {
            left,
            right: left + textWidth,
            top: node.y + label.dy - fontSize,
            bottom: node.y + label.dy + extraHeight + 3,
          },
        };
      })
      .filter(
        ({ box }) =>
          box.left >= viewport.left + 6 &&
          box.right <= viewport.right - 6 &&
          box.top >= viewport.top + 6 &&
          box.bottom <= viewport.bottom - 6
      );
    const choice = options.find(({ box }) => occupied.every((other) => !overlaps(box, other)));
    const label = choice || (node.id === focusId ? options[0] : null);
    if (label) {
      placements.set(node.id, label);
      occupied.push(label.box);
    }
  }
  return placements;
}
