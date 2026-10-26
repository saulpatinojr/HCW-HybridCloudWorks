import { describe, expect, it } from 'vitest';
import { graphLabels } from './graphLabels';
const nodes = [
  { id: 'a', title: 'Docker delivery', type: 'note', x: 150, y: 180 },
  { id: 'b', title: 'Pipeline research', type: 'reference', x: 210, y: 180 },
  { id: 'c', title: 'Unrelated research', type: 'reference', x: 400, y: 290 },
];
const neighbors = new Map([
  ['a', new Set(['b'])],
  ['b', new Set(['a'])],
  ['c', new Set()],
]);
describe('graph label readability', () => {
  it('keeps labels within the canvas and avoids overlapping label rectangles', () => {
    const placements = graphLabels(nodes, {
      focusId: 'a',
      neighbors,
      showAll: true,
      width: 550,
      height: 400,
    });
    expect(placements.has('a')).toBe(true);
    const boxes = [...placements.values()].map((p) => p.box);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(6);
      expect(box.right).toBeLessThanOrEqual(544);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        expect(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).toBe(
          false
        );
      }
  });
  it('keeps selected context readable when general labels are disabled', () => {
    const placements = graphLabels(nodes, {
      focusId: 'a',
      neighbors,
      showAll: false,
      width: 550,
      height: 400,
    });
    expect(placements.has('a')).toBe(true);
    expect(placements.has('c')).toBe(false);
  });
});
