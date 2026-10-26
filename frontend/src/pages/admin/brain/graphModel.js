export const EDGE_TYPES = {
  explicit: { label: 'Explicit links', color: '#38bdf8' },
  membership: { label: 'Topics & projects', color: '#c084fc' },
  suggested: { label: 'Suggested links', color: '#64748b' },
};
export const NODE_TYPES = {
  note: { label: 'Note', color: '#38bdf8' },
  conflict: { label: 'Recovery note', color: '#fb923c' },
  topic: { label: 'Topic', color: '#c084fc' },
  project: { label: 'Project', color: '#34d399' },
  reference: { label: 'Content', color: '#94a3b8' },
};
const pairKey = (a, b) => [a, b].sort().join('\u0000');
export function graphModel(nodes, edges, kinds) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const authoredPairs = new Set(
    edges.filter((e) => e.kind !== 'suggested').map((e) => pairKey(e.from, e.to))
  );
  const links = edges.filter((edge) => {
    const key = `${pairKey(edge.from, edge.to)}/${edge.kind}`;
    if (
      !byId.has(edge.from) ||
      !byId.has(edge.to) ||
      edge.from === edge.to ||
      !kinds.includes(edge.kind) ||
      seen.has(key)
    )
      return false;
    if (edge.kind === 'suggested' && authoredPairs.has(pairKey(edge.from, edge.to))) return false;
    seen.add(key);
    return true;
  });
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of links) {
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
  }
  return { nodes, links, byId, neighbors };
}
export function visibleGraph(model, { query, focusId, localOnly, hideIsolated }) {
  const needle = query.trim().toLowerCase();
  const matches = new Set(
    model.nodes
      .filter((n) => `${n.title} ${(n.tags || []).join(' ')}`.toLowerCase().includes(needle))
      .map((n) => n.id)
  );
  const allowed = new Set(matches);
  if (needle)
    for (const id of matches) for (const linked of model.neighbors.get(id)) allowed.add(linked);
  const nodes = model.nodes.filter((node) => {
    if (needle && !allowed.has(node.id)) return false;
    if (hideIsolated && !model.neighbors.get(node.id).size) return false;
    return (
      !localOnly || !focusId || node.id === focusId || model.neighbors.get(focusId)?.has(node.id)
    );
  });
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: model.links.filter((e) => ids.has(e.from) && ids.has(e.to)), matches };
}
