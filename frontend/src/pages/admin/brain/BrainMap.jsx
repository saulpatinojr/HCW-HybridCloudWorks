import React, { useId, useMemo } from 'react';

const colors = {
  explicit: 'var(--color-primary, #2563eb)',
  membership: '#8b5cf6',
  suggested: '#64748b',
};
export default function BrainMap({ nodes, edges, onSelect }) {
  const descId = useId();
  const positions = useMemo(
    () =>
      new Map(
        nodes.map((node, i) => {
          const angle = (i * 2 * Math.PI) / Math.max(nodes.length, 1);
          let radius = nodes.length > 16 && i % 2 ? 135 : 225;
          if (nodes.length === 1) radius = 0;
          return [
            node.id,
            { x: 340 + radius * Math.cos(angle), y: 280 + radius * Math.sin(angle) },
          ];
        })
      ),
    [nodes]
  );
  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
      <div className="overflow-hidden rounded-xl border bg-muted/20">
        <svg viewBox="0 0 680 560" className="w-full" role="group" aria-labelledby={descId}>
          <title id={descId}>
            Connections between loaded notes and creator content. Use the item list to open any
            node.
          </title>
          {edges.map((edge, i) => {
            const a = positions.get(edge.from),
              b = positions.get(edge.to);
            return a && b ? (
              <line
                key={`${edge.from}-${edge.to}-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={colors[edge.kind]}
                strokeOpacity="0.45"
                strokeDasharray={edge.kind === 'suggested' ? '4 5' : undefined}
              />
            ) : null;
          })}
          {nodes.map((node) => {
            const p = positions.get(node.id);
            return (
              <g
                key={node.id}
                className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                aria-label={`Open ${node.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  onSelect(node.id);
                }}
              >
                <title>{node.title}</title>
                <rect
                  x={p.x - (nodes.length > 16 ? 10 : 65)}
                  y={p.y - (nodes.length > 16 ? 10 : 32)}
                  width={nodes.length > 16 ? 20 : 130}
                  height={nodes.length > 16 ? 20 : 52}
                  rx="6"
                  fill="transparent"
                  pointerEvents="all"
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={node.type === 'topic' || node.type === 'project' ? 9 : 6}
                  fill={node.type === 'reference' ? '#64748b' : '#2563eb'}
                />
                {nodes.length <= 16 && (
                  <text
                    x={p.x}
                    y={p.y - 13}
                    textAnchor="middle"
                    className="fill-foreground text-[10px]"
                  >
                    {node.title.slice(0, 22)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Blue: explicit links · Purple: collection membership · Dashed: suggested from shared tags
        </p>
      </div>
      <ul className="max-h-[38rem] space-y-2 overflow-y-auto" aria-label="Map items">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onSelect(node.id)}
              className="w-full rounded-lg border p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2"
            >
              <span className="block text-xs uppercase tracking-wide text-muted-foreground">
                {node.type}
              </span>
              <span className="text-sm font-medium">{node.title}</span>
            </button>
          </li>
        ))}
        {!nodes.length && (
          <li className="p-4 text-sm text-muted-foreground">
            Save notes or index content to start your map.
          </li>
        )}
      </ul>
    </div>
  );
}
