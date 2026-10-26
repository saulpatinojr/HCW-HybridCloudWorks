import React, { useEffect, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { ZoomIn, ZoomOut, Scan, Focus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useForceGraph } from './useForceGraph';
import { graphLabels } from './graphLabels';

function GraphNode({ node, active, neighbor, dim, label, onFocus, drag, theme, colors }) {
  const gesture = useRef(null);
  function point(event) {
    const matrix = event.currentTarget.ownerSVGElement.getScreenCTM();
    return matrix
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
      : { x: node.x, y: node.y };
  }
  function move(event) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !gesture.current) return;
    if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4)
      gesture.current.moved = true;
    if (gesture.current.moved) drag(node.id, point(event));
  }
  const color = colors[node.type] || theme.nodes.reference;
  return (
    <g
      className="brain-node cursor-grab outline-none focus-visible:[&>circle]:stroke-[var(--brain-focus)] active:cursor-grabbing"
      style={{ '--brain-focus': theme.text }}
      role="button"
      tabIndex={0}
      aria-label={`Explore ${node.title}`}
      aria-pressed={active}
      transform={`translate(${node.x},${node.y})`}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onFocus(node.id);
        }
      }}
      onClick={() => {
        if (!gesture.current?.moved) onFocus(node.id);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        gesture.current = { x: event.clientX, y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (gesture.current?.moved) drag(node.id, point(event), true);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        drag(node.id, point(event), true);
        gesture.current = null;
      }}
      opacity={dim ? 0.2 : 1}
    >
      <title>{node.title}</title>
      <circle r="24" fill="transparent" />
      {(active || neighbor) && (
        <circle
          r={active ? 24 : 19}
          fill={color}
          fillOpacity="0.1"
          stroke={color}
          strokeOpacity={active ? 1 : 0.35}
        />
      )}
      <circle
        r={
          node.type === 'topic' || node.type === 'project'
            ? 11
            : 7 + Math.min(node.degree || 0, 12) * 0.45
        }
        fill={color}
        stroke={theme.background}
        strokeWidth="2"
      />
      {label && (
        <text
          x={label.dx}
          y={label.dy}
          textAnchor={label.anchor}
          fill={theme.text}
          stroke={theme.background}
          strokeWidth={label.fontSize * 0.25}
          paintOrder="stroke"
          className="pointer-events-none font-medium"
          style={{ fontSize: label.fontSize }}
        >
          {label.lines.map((line, i) => (
            <tspan key={i} x={label.dx} dy={i ? label.lineHeight : 0}>
              {line}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
}

function GraphLinks({ links, byId, focusId, theme, colors }) {
  return (
    <g>
      {links.map((edge) => {
        const a = byId.get(edge.from),
          b = byId.get(edge.to);
        if (!a || !b) return null;
        const connected = edge.from === focusId || edge.to === focusId;
        let opacity = edge.kind === 'suggested' ? 0.35 : 0.65;
        if (focusId && !connected) opacity = 0.09;
        return (
          <line
            key={`${edge.from}/${edge.to}/${edge.kind}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={
              { explicit: colors.note, membership: colors.topic, suggested: theme.edge }[edge.kind]
            }
            strokeWidth={connected ? 2.5 : 1}
            strokeOpacity={opacity}
            strokeDasharray={edge.kind === 'suggested' ? '4 7' : undefined}
          />
        );
      })}
    </g>
  );
}
function useCanvasSize() {
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ width: 720, height: 640 });
  useEffect(() => {
    let alive = true;
    const measure = () => {
      const box = canvasRef.current?.getBoundingClientRect();
      if (alive && box?.width && box.height)
        setSize((old) => {
          const next = { width: Math.round(box.width), height: Math.round(box.height) };
          return old.width === next.width && old.height === next.height ? old : next;
        });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (canvasRef.current) observer?.observe(canvasRef.current);
    window.addEventListener('resize', measure);
    Promise.resolve().then(measure);
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return { canvasRef, size };
}
export default function GraphCanvas({
  graph,
  model,
  focusId,
  onFocus,
  labels,
  animate,
  height = 560,
  appearance,
  theme,
}) {
  const { canvasRef, size } = useCanvasSize();
  const { positions, drag } = useForceGraph(graph, animate, size.width, size.height);
  const [camera, setCamera] = useState({ scale: 1, positionX: 0, positionY: 0 });
  const colors = { ...theme.nodes, ...appearance.colors };
  const byId = new Map(positions.map((n) => [n.id, n]));
  const visibleIds = new Set(graph.nodes.map((n) => n.id));
  const visible = positions.filter((node) => visibleIds.has(node.id));
  const placements = graphLabels(visible, {
    focusId,
    neighbors: model.neighbors,
    showAll: labels,
    ...size,
    fontSize: appearance.fontSize / camera.scale,
    viewport: {
      left: -camera.positionX / camera.scale,
      top: -camera.positionY / camera.scale,
      right: (size.width - camera.positionX) / camera.scale,
      bottom: (size.height - camera.positionY) / camera.scale,
    },
  });
  return (
    <div
      ref={canvasRef}
      className="relative shrink-0"
      role="region"
      aria-label="Knowledge canvas"
      style={{ height }}
    >
      <TransformWrapper
        minScale={0.35}
        maxScale={5}
        limitToBounds={false}
        centerOnInit
        wheel={{ activationKeys: ['Control', 'Meta'] }}
        doubleClick={{ disabled: true }}
        panning={{ excluded: ['brain-node'], velocityDisabled: true }}
        onTransform={(_, state) =>
          setCamera((old) =>
            old.scale === state.scale &&
            old.positionX === state.positionX &&
            old.positionY === state.positionY
              ? old
              : state
          )
        }
      >
        {({ zoomIn, zoomOut, resetTransform, setTransform }) => (
          <>
            <div
              className="absolute left-3 top-3 z-10 flex gap-1 rounded-lg border p-1 shadow-sm"
              style={{ background: theme.glow, borderColor: theme.border, color: theme.text }}
            >
              {[
                ['Zoom in', ZoomIn, zoomIn],
                ['Zoom out', ZoomOut, zoomOut],
                ['Reset map view', Scan, resetTransform],
                [
                  'Fit graph',
                  Focus,
                  () => {
                    if (!visible.length) return;
                    const xs = visible.map((n) => n.x),
                      ys = visible.map((n) => n.y);
                    const left = Math.min(...xs),
                      right = Math.max(...xs),
                      top = Math.min(...ys),
                      bottom = Math.max(...ys);
                    const scale = Math.max(
                      0.35,
                      Math.min(
                        2,
                        (size.width - 100) / Math.max(right - left, 100),
                        (size.height - 100) / Math.max(bottom - top, 100)
                      )
                    );
                    setTransform(
                      size.width / 2 - ((left + right) / 2) * scale,
                      size.height / 2 - ((top + bottom) / 2) * scale,
                      scale,
                      0
                    );
                  },
                ],
              ].map(([label, Icon, action]) => (
                <Button
                  key={label}
                  size="icon"
                  variant="ghost"
                  className="text-inherit hover:bg-black/5 hover:text-inherit"
                  aria-label={label}
                  onClick={() => action()}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              ))}
            </div>
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '100%', cursor: 'grab' }}
              contentStyle={{ width: '100%', height: '100%' }}
            >
              <svg
                viewBox={`0 0 ${size.width} ${size.height}`}
                className="h-full w-full"
                role="group"
                aria-label="Interactive knowledge graph"
              >
                <GraphLinks
                  links={graph.links}
                  byId={byId}
                  focusId={focusId}
                  theme={theme}
                  colors={colors}
                />
                {visible.map((node) => (
                  <GraphNode
                    key={node.id}
                    node={{ ...node, degree: model.neighbors.get(node.id)?.size }}
                    active={node.id === focusId}
                    neighbor={model.neighbors.get(focusId)?.has(node.id)}
                    dim={Boolean(
                      focusId && node.id !== focusId && !model.neighbors.get(focusId)?.has(node.id)
                    )}
                    label={placements.get(node.id)}
                    onFocus={onFocus}
                    drag={drag}
                    theme={theme}
                    colors={colors}
                  />
                ))}
              </svg>
            </TransformComponent>
            {!graph.nodes.length && (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center"
                style={{ color: theme.muted }}
              >
                No items match these filters. Clear your search or show more relationships.
              </div>
            )}
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
