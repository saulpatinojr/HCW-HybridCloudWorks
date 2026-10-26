import { describe, expect, it } from 'vitest';
import { graphLabels, labelLines } from './graphLabels';
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
  it('balances a short heading over at most two lines', () => {
    expect(labelLines('State Recovery Practice')).toEqual(['State Recovery', 'Practice']);
    expect(labelLines('Terraform')).toEqual(['Terraform']);
    const headingNode = {
      ...nodes[0],
      properties: { heading: 'State Recovery Practice' },
      title: 'A long synthetic title that must remain intact',
    };
    const label = graphLabels([headingNode], {
      focusId: 'a',
      neighbors,
      showAll: true,
      width: 550,
      height: 400,
    }).get('a');
    expect(label.lines).toEqual(['State Recovery', 'Practice']);
    expect(headingNode.title).toBe('A long synthetic title that must remain intact');
  });
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
