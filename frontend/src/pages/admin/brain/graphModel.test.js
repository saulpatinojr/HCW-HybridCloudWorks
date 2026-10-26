import { describe, expect, it } from 'vitest';
import { graphModel, visibleGraph } from './graphModel';
const nodes = [
  { id: 'a', title: 'Docker release', tags: ['docker'] },
  { id: 'b', title: 'Pipeline research', tags: [] },
  { id: 'c', title: 'Unrelated', tags: [] },
];
const options = { query: '', focusId: null, localOnly: false, hideIsolated: false };
describe('knowledge graph projection', () => {
  it('deduplicates reciprocal edges and never presents suggestions as authored relationships', () => {
    const graph = graphModel(
      nodes,
      [
        { from: 'a', to: 'b', kind: 'explicit' },
        { from: 'b', to: 'a', kind: 'explicit' },
        { from: 'a', to: 'b', kind: 'suggested' },
        { from: 'a', to: 'a', kind: 'membership' },
        { from: 'a', to: 'missing', kind: 'membership' },
      ],
      ['explicit', 'membership', 'suggested']
    );
    expect(graph.links).toEqual([{ from: 'a', to: 'b', kind: 'explicit' }]);
    expect([...graph.neighbors.get('b')]).toEqual(['a']);
    expect(graph.neighbors.get('c').size).toBe(0);
  });
  it('searches titles and tags with immediate neighbors, and filters isolated nodes without inventing links', () => {
    const model = graphModel(nodes, [{ from: 'a', to: 'b', kind: 'explicit' }], ['explicit']);
    expect(visibleGraph(model, { ...options, query: 'docker' }).nodes.map((n) => n.id)).toEqual([
      'a',
      'b',
    ]);
    expect(visibleGraph(model, { ...options, query: 'absent' }).nodes).toEqual([]);
    expect(visibleGraph(model, { ...options, hideIsolated: true }).nodes.map((n) => n.id)).toEqual([
      'a',
      'b',
    ]);
    expect(
      visibleGraph(model, { ...options, localOnly: true, focusId: 'c' }).nodes.map((n) => n.id)
    ).toEqual(['c']);
  });
});
