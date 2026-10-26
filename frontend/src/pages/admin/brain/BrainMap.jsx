import React, { useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Pause, Play, Maximize2, Search, Network, ArrowUpRight, X, Expand } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { graphModel, visibleGraph, NODE_TYPES, EDGE_TYPES } from './graphModel';
import GraphCanvas from './GraphCanvas';
import MapAppearance from './MapAppearance';
import { PALETTES, loadAppearance, saveAppearance, nodeHeading } from './mapPreferences';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

function Connections({ model, focusId, onFocus }) {
  const connected = model.links.filter((e) => e.from === focusId || e.to === focusId);
  return (
    <div className="border-t pt-4">
      <h4 className="mb-2 text-sm font-semibold">Connections · {connected.length}</h4>
      {!connected.length && (
        <p className="text-sm text-muted-foreground">
          No visible links yet. Open the note to link research or add it to a topic. Proximity alone
          is not a relationship.
        </p>
      )}
      <ul className="space-y-2">
        {connected.map((edge) => {
          const other = model.byId.get(edge.from === focusId ? edge.to : edge.from);
          return (
            <li key={`${other.id}/${edge.kind}`}>
              <button
                className="w-full rounded-lg border p-3 text-left hover:bg-muted"
                onClick={() => onFocus(other.id)}
              >
                <span className="mb-1 block text-[11px] text-muted-foreground">
                  {EDGE_TYPES[edge.kind].label}
                </span>
                <span className="text-sm">{other.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
function MapInspector({ model, focusId, onFocus, onSelect, colors }) {
  const item = model.byId.get(focusId);
  return (
    <aside
      className="space-y-4 rounded-xl border bg-card p-4 xl:max-h-[44rem] xl:overflow-y-auto"
      aria-label="Map details"
    >
      {item ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              {NODE_TYPES[item.type]?.label}
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Clear selected node"
              onClick={() => onFocus(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <h3 className="text-lg font-semibold leading-snug">{nodeHeading(item)}</h3>
          {nodeHeading(item) !== item.title && (
            <p className="text-xs leading-relaxed text-muted-foreground">{item.title}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {item.excerpt ||
              item.summary ||
              'Open this item to read its text and manage its links.'}
          </p>
          <div className="flex flex-wrap gap-1">
            {(item.tags || []).map((tag) => (
              <span className="rounded-full bg-muted px-2 py-1 text-xs" key={tag}>
                #{tag}
              </span>
            ))}
          </div>
          <Button onClick={() => onSelect(item.id)}>
            Open {item.type === 'reference' ? 'content' : 'note'}
            <ArrowUpRight className="ml-2 h-4 w-4" />
          </Button>
          <Connections model={model} focusId={focusId} onFocus={onFocus} />
        </>
      ) : (
        <div className="space-y-3 py-3">
          <Network className="h-7 w-7 text-primary" />
          <h3 className="font-semibold">Follow an idea</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Select a node to explore its connections. Drag nodes to rearrange them, pan the
            background, and pinch or Ctrl + scroll to zoom.
          </p>
          <p className="text-sm text-muted-foreground">
            Solid links are authored relationships. Dashed links are suggestions from shared tags.
          </p>
        </div>
      )}
      <details open={!item} className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-semibold">
          Browse loaded items · {model.nodes.length}
        </summary>
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto" aria-label="Map items">
          {model.nodes.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                aria-label={`Open ${node.title}`}
                onClick={() => {
                  onFocus(node.id);
                  onSelect(node.id);
                }}
                className="w-full rounded-lg p-2 text-left text-sm hover:bg-muted"
              >
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full"
                  style={{ background: colors[node.type] }}
                />
                {node.title}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
function mapGridClass(fullscreen, expanded) {
  if (fullscreen)
    return 'flex-1 auto-rows-max content-start overflow-auto lg:grid-cols-[minmax(0,1fr)_18rem]';
  return expanded ? 'grid-cols-1' : 'items-start xl:grid-cols-[minmax(0,1fr)_19rem]';
}
function mapHeight(fullscreen, expanded) {
  if (fullscreen) return 'calc(100dvh - 275px)';
  return expanded ? 1120 : 560;
}
export default function BrainMap({ nodes, edges, onSelect }) {
  const [focusId, setFocusId] = useState(null);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState(Object.keys(EDGE_TYPES));
  const [localOnly, setLocalOnly] = useState(false);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [labels, setLabels] = useState(true);
  const [animate, setAnimate] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [appearance, setAppearance] = useState(loadAppearance);
  const fullScreenButton = useRef(null);
  const theme = PALETTES[appearance.palette];
  const colors = { ...theme.nodes, ...appearance.colors };
  const edgeColors = { explicit: colors.note, membership: colors.topic, suggested: theme.edge };
  const changeAppearance = (next) => {
    setAppearance(next);
    saveAppearance(next);
  };
  const reducedMotion = useReducedMotion();
  const model = useMemo(() => graphModel(nodes, edges, kinds), [nodes, edges, kinds]);
  const neighborhoodId = localOnly ? focusId : null;
  const graph = useMemo(
    () => visibleGraph(model, { query, focusId: neighborhoodId, localOnly, hideIsolated }),
    [model, query, neighborhoodId, localOnly, hideIsolated]
  );
  const workspace = (
    <div className={fullscreen ? 'flex min-h-0 flex-1 flex-col gap-3' : 'space-y-4'}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-48 flex-1">
          <Search
            className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="sr-only">Find in map</span>
          <input
            className="w-full rounded-lg border bg-background py-2 pl-9 pr-3 text-sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an idea, title, or tag…"
          />
        </label>
        <Button
          variant="outline"
          onClick={() => setAnimate((v) => !v)}
          disabled={Boolean(reducedMotion)}
        >
          {animate && !reducedMotion ? (
            <Pause className="mr-2 h-4 w-4" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {animate && !reducedMotion ? 'Pause layout' : 'Animate layout'}
        </Button>
        {!fullscreen && (
          <Button variant="outline" onClick={() => setExpanded((v) => !v)}>
            <Maximize2 className="mr-2 h-4 w-4" />
            {expanded ? 'Compact canvas' : 'Expand canvas'}
          </Button>
        )}
        {!fullscreen && (
          <Button ref={fullScreenButton} variant="outline" onClick={() => setFullscreen(true)}>
            <Expand className="mr-2 h-4 w-4" />
            Full screen
          </Button>
        )}
      </div>
      <MapAppearance value={appearance} onChange={changeAppearance} />
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {Object.entries(EDGE_TYPES).map(([kind, info]) => (
          <label key={kind} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              onChange={(e) =>
                setKinds((old) =>
                  e.target.checked ? [...old, kind] : old.filter((k) => k !== kind)
                )
              }
            />
            <span className="h-0.5 w-4" style={{ background: edgeColors[kind] }} />
            {info.label}
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
          Labels
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={hideIsolated}
            onChange={(e) => setHideIsolated(e.target.checked)}
          />
          Hide unconnected
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          Selected neighborhood
        </label>
      </div>
      <div className={`grid min-h-0 gap-4 ${mapGridClass(fullscreen, expanded)}`}>
        <div
          className="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border shadow-inner"
          style={{
            background: `radial-gradient(circle at 50% 45%, ${theme.glow}, ${theme.background} 85%)`,
            borderColor: theme.border,
          }}
        >
          <GraphCanvas
            graph={graph}
            model={model}
            focusId={focusId}
            onFocus={setFocusId}
            labels={labels}
            animate={animate && !reducedMotion}
            height={mapHeight(fullscreen, expanded)}
            appearance={appearance}
            theme={theme}
          />
          <div
            className="flex flex-wrap gap-x-4 gap-y-2 border-t px-4 py-3 text-xs"
            style={{ borderColor: theme.border, color: theme.muted }}
          >
            {Object.entries(NODE_TYPES).map(([type, info]) => (
              <span className="flex items-center gap-1.5" key={type}>
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: appearance.colors[type] || theme.nodes[type] }}
                />
                {info.label}
              </span>
            ))}
            <span className="ml-auto">
              {graph.nodes.length} items · {graph.links.length} links
            </span>
          </div>
        </div>
        <MapInspector
          model={model}
          focusId={focusId}
          onFocus={setFocusId}
          colors={colors}
          onSelect={(id) => {
            setFullscreen(false);
            onSelect(id);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Exploring the loaded graph; use Expand map below when more items are available. Layout
        settles automatically.{' '}
        {reducedMotion && 'Motion is paused for your reduced-motion preference.'}
      </p>
    </div>
  );
  return (
    <Dialog open={fullscreen} onOpenChange={setFullscreen}>
      {!fullscreen && workspace}
      <DialogContent
        className="left-3 top-3 flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden p-4 sm:rounded-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          fullScreenButton.current?.focus();
        }}
      >
        <DialogTitle>Knowledge map</DialogTitle>
        <DialogDescription className="sr-only">
          Explore your notes and connections. Close with the X button or Escape to return to the
          page.
        </DialogDescription>
        {fullscreen && workspace}
      </DialogContent>
    </Dialog>
  );
}
