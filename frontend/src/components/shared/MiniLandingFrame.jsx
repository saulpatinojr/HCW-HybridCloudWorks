/* eslint-disable complexity */
/**
 * Shared Mini Landing Page framing (#1084) for Architecture Designs and Labs.
 *
 * Every design (`/<provider>/architecture-designs/<slug>`) and framed lab
 * (#1080, #1082, #1083) opens as a one-screen landing view:
 *   1. Hero: the title and a one-line `promise`.
 *   2. Full-width diagram: interactive image with hotspots or structured SVG/node diagram.
 *   3. Up to four doorway panes under the diagram:
 *      - How it works (`howItWorks`: ordered steps)
 *      - Key services (`keyServices`: `{ name, icon, role }[]`)
 *      - Security and best practices (`practices`: checklist lines)
 *      - Outcome (`outcome`: string or lines)
 *
 * Each pane is a door that opens its deep dive (via `onOpenDeepDive(paneId)` or
 * an anchor `#<targetId>`), and any pane whose field is empty is omitted rather
 * than showing placeholder text.
 */
import React from 'react';
import { CheckCircle2, ArrowRight, Layers, ShieldCheck, Sparkles, GitCommit } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import InteractiveDiagram from '@/components/widgets/InteractiveDiagram';

/** Normalize a string or array of strings into non-empty trimmed lines. */
export function normalizeLines(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((line) => String(line || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

/** Normalize `keyServices` entries (`{ name, icon, role }`) and drop incomplete rows. */
export function normalizeKeyServices(services) {
  if (!Array.isArray(services)) return [];
  return services
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry.name || '').trim(),
      icon: String(entry.icon || 'layers').trim(),
      role: String(entry.role || '').trim(),
    }))
    .filter((entry) => entry.name && entry.role);
}

/**
 * Built-in SVG topology diagram for designs that provide `topology` metadata
 * (such as the reference Secure 2-Tier Application on Azure) when an external
 * raster `diagramUrl` is not supplied.
 */
export function TopologyDiagram({ topology, hotspots = [], onHotspotClick }) {
  const [selected, setSelected] = React.useState(null);
  if (!topology || !Array.isArray(topology.stages) || topology.stages.length === 0) {
    return null;
  }

  const activeDetail = selected || topology.stages[0] || hotspots[0] || null;
  const handleSelect = (entry, idx) => {
    setSelected(entry);
    onHotspotClick?.(entry, idx);
  };

  return (
    <div
      className="w-full rounded-xl border border-border bg-slate-950/80 p-4 sm:p-6 text-slate-100 shadow-inner"
      data-testid="topology-diagram"
    >
      {topology.caption && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <span className="text-xs font-mono uppercase tracking-wider text-primary">
            {topology.caption}
          </span>
          {Array.isArray(topology.surrounding) && topology.surrounding.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-testid="topology-surrounding">
              {topology.surrounding.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-xs text-slate-300"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        {topology.stages.map((stage, idx) => (
          <button
            key={stage.id || stage.title || idx}
            type="button"
            onClick={() => handleSelect(stage, idx)}
            className="group relative flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-900/90 p-3.5 text-left transition-colors hover:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary"
            data-testid="topology-stage"
          >
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                  {idx + 1}
                </span>
                {stage.boundary && (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                    {stage.boundary}
                  </span>
                )}
              </div>
              <p className="text-sm font-semibold text-white group-hover:text-primary transition-colors">
                {stage.title}
              </p>
              {stage.subtitle && (
                <p className="mt-1 text-xs text-slate-300 leading-snug">{stage.subtitle}</p>
              )}
              {stage.description && (
                <p className="mt-1.5 text-xs text-slate-400 leading-snug">{stage.description}</p>
              )}
            </div>
            {stage.guardrail && (
              <p className="mt-3 border-t border-slate-800/80 pt-2 font-mono text-[11px] text-emerald-300">
                {stage.guardrail}
              </p>
            )}
          </button>
        ))}
      </div>

      {hotspots.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
          {hotspots.map((spot, index) => (
            <button
              key={spot.id || spot.label || index}
              type="button"
              onClick={() => handleSelect(spot, index)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:border-primary"
            >
              <span className="font-mono text-primary">#{index + 1}</span>
              <span>{spot.label}</span>
            </button>
          ))}
        </div>
      )}

      {activeDetail &&
        (activeDetail.description || activeDetail.subtitle || activeDetail.guardrail) && (
          <div
            className="mt-4 rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300"
            data-testid="topology-detail"
          >
            <span className="font-semibold text-white">
              {activeDetail.title || activeDetail.label}:{' '}
            </span>
            <span>
              {activeDetail.description || activeDetail.subtitle || activeDetail.guardrail}
            </span>
          </div>
        )}
    </div>
  );
}

export default function MiniLandingFrame({
  title,
  promise,
  eyebrow,
  badges = [],
  tags = [],
  actions = null,
  diagram = null,
  diagramUrl = '',
  topology = null,
  hotspots = [],
  onHotspotClick,
  howItWorks = [],
  keyServices = [],
  practices = [],
  outcome = '',
  activePane = null,
  onOpenDeepDive,
  onSelectPane,
  deepDiveLabels = {},
  headingLevel = 'h1',
}) {
  const HeadingTag = headingLevel === 'h2' ? 'h2' : 'h1';
  const handleOpenDeepDive = onOpenDeepDive || onSelectPane;
  const steps = normalizeLines(howItWorks);
  const services = normalizeKeyServices(keyServices);
  const checklist = normalizeLines(practices);
  const outcomeLines = normalizeLines(outcome);

  const panes = [
    steps.length > 0 && {
      id: 'how-it-works',
      title: 'How it works',
      icon: GitCommit,
      cta: deepDiveLabels['how-it-works'] || 'Walk the flow',
      target: '#deep-dive-how-it-works',
      body: (
        <ol className="list-decimal pl-4 space-y-1.5 text-xs sm:text-sm text-muted-foreground">
          {steps.map((step, i) => (
            <li key={i} className="leading-snug">
              {step}
            </li>
          ))}
        </ol>
      ),
    },
    services.length > 0 && {
      id: 'key-services',
      title: 'Key services',
      icon: Layers,
      cta: deepDiveLabels['key-services'] || 'Inspect services',
      target: '#deep-dive-key-services',
      body: (
        <ul className="space-y-2 text-xs sm:text-sm">
          {services.map((svc) => (
            <li key={svc.name} className="flex items-start gap-2">
              <span
                className="material-symbols-outlined text-primary text-[16px] mt-0.5 shrink-0"
                aria-hidden="true"
              >
                {svc.icon}
              </span>
              <div>
                <span className="font-semibold text-foreground">{svc.name}:</span>{' '}
                <span className="text-muted-foreground">{svc.role}</span>
              </div>
            </li>
          ))}
        </ul>
      ),
    },
    checklist.length > 0 && {
      id: 'security',
      title: 'Security and best practices',
      icon: ShieldCheck,
      cta: deepDiveLabels.security || 'Open security deep dive',
      target: '#deep-dive-security',
      body: (
        <ul className="space-y-1.5 text-xs sm:text-sm text-muted-foreground">
          {checklist.map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircle2
                className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <span className="leading-snug">{item}</span>
            </li>
          ))}
        </ul>
      ),
    },
    outcomeLines.length > 0 && {
      id: 'outcome',
      title: 'Outcome',
      icon: Sparkles,
      cta: deepDiveLabels.outcome || 'Open implementation & cost',
      target: '#deep-dive-outcome',
      body: (
        <div className="space-y-2 text-xs sm:text-sm text-muted-foreground">
          {outcomeLines.slice(0, 2).map((line, i) => (
            <p key={i} className="leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      ),
    },
  ].filter(Boolean);

  const hasDiagram = Boolean(diagram || diagramUrl || topology);

  return (
    <section className="space-y-6" data-testid="mini-landing-frame">
      {/* Hero */}
      <header className="space-y-3" data-testid="mini-landing-hero">
        {(eyebrow || badges.length > 0 || tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {eyebrow && (
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-primary">
                {eyebrow}
              </span>
            )}
            {badges.map((badge) => (
              <Badge key={badge.label} variant={badge.variant || 'default'}>
                {badge.label}
              </Badge>
            ))}
            {tags.map((tag, i) => (
              <Badge key={`${tag}-${i}`} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {title && (
          <HeadingTag className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight leading-tight">
            {title}
          </HeadingTag>
        )}

        {promise && (
          <p
            className="text-base sm:text-lg text-muted-foreground max-w-4xl leading-relaxed"
            data-testid="mini-landing-promise"
          >
            {promise}
          </p>
        )}

        {actions && <div className="pt-1 flex flex-wrap gap-3">{actions}</div>}
      </header>

      {/* Full-width Diagram */}
      {hasDiagram && (
        <div className="w-full" data-testid="mini-landing-diagram">
          {diagram ||
            (diagramUrl ? (
              <div className="rounded-xl border border-border bg-card/40 overflow-hidden">
                <InteractiveDiagram
                  imageUrl={diagramUrl}
                  hotspots={hotspots}
                  onHotspotClick={onHotspotClick || (() => {})}
                />
              </div>
            ) : (
              <TopologyDiagram
                topology={topology}
                hotspots={hotspots}
                onHotspotClick={onHotspotClick}
              />
            ))}
        </div>
      )}

      {/* Four Doorway Panes (only non-empty panes render) */}
      {panes.length > 0 && (
        <div
          className={`grid grid-cols-1 md:grid-cols-2 ${
            { 4: 'xl:grid-cols-4', 3: 'xl:grid-cols-3' }[Math.min(panes.length, 4)] ||
            'xl:grid-cols-2'
          } gap-4`}
          data-testid="mini-landing-panes"
        >
          {panes.map((pane) => {
            const Icon = pane.icon;
            const isSelected = activePane === pane.id;
            return (
              <div
                key={pane.id}
                data-testid={`landing-pane-${pane.id}`}
                className={`flex flex-col justify-between rounded-xl border p-5 transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 shadow-sm'
                    : 'border-border bg-card/50 hover:border-primary/50'
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                    <h2 className="text-sm font-bold tracking-tight">{pane.title}</h2>
                  </div>
                  {pane.body}
                </div>

                <div className="mt-4 pt-3 border-t border-border/60">
                  <a
                    href={pane.target}
                    onClick={(event) => {
                      if (handleOpenDeepDive) {
                        event.preventDefault();
                        handleOpenDeepDive(pane.id);
                      }
                    }}
                    data-testid={`landing-pane-door-${pane.id}`}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline underline-offset-4"
                  >
                    <span>{pane.cta}</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
