/**
 * Dashboard — orientation for whoever opens ContentForge (ADR 0033 §1 Home).
 *
 * One pipeline graphic, not two. The quick-action row and the "ContentForge
 * Pipeline" card showed the same four stages with the same counts; the card
 * stays because it is the one that reads as a flow, and it gains the two
 * stages the sidebar already had — Drafts before the queue, Live Pages after
 * publish — so the picture and the menu agree.
 *
 * Below it: what needs a decision, the count by content type, and an
 * "Explore" strip that introduces each group of the menu in one sentence,
 * for a user who has never seen the product.
 */
import React from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Zap,
  RefreshCw,
  Loader2,
  TrendingUp,
  FileText,
  Globe,
  BookOpen,
  Code2,
  ChevronRight,
  ArrowRight,
  AlertCircle,
  Layers,
} from 'lucide-react';
import useDashboardCounts from '@/hooks/useDashboardCounts';
import { NAV_GROUPS } from '@/config/adminNav';
import DecisionCenter from '@/components/admin/dashboard/DecisionCenter';
import StatTile from '@/components/admin/shared/StatTile';
import EmptyState from '@/components/admin/shared/EmptyState';
import { Badge } from '@/components/ui/badge';

// ── Small helpers ─────────────────────────────────────────────────────────────

function pluralize(n, word) {
  return `${n} ${word}${n !== 1 ? 's' : ''}`;
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/**
 * The stages, in order, each pointing at the page where that stage is worked.
 * `countKey` names the badge from useDashboardCounts; a stage without one
 * shows no number rather than an invented one.
 */
export const PIPELINE_STAGES = Object.freeze([
  {
    id: 'new',
    label: 'New Content',
    description: 'Import or start',
    to: '/admin/submit',
    color:
      'border-sky-200 bg-sky-50/40 text-sky-700 dark:border-sky-900 dark:bg-sky-950/20 dark:text-sky-300',
  },
  {
    id: 'drafts',
    label: 'Drafts',
    description: 'Still being written',
    to: '/admin/drafts',
    color:
      'border-slate-200 bg-slate-50/40 text-slate-700 dark:border-slate-800 dark:bg-slate-950/20 dark:text-slate-300',
  },
  {
    id: 'review',
    label: 'Review Queue',
    description: 'Decide: approve or reject',
    to: '/admin/queue',
    countKey: 'queue',
    color:
      'border-amber-200 bg-amber-50/40 text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300',
  },
  {
    id: 'editor',
    label: 'Editor',
    description: 'Polish approved drafts',
    to: '/admin/editor',
    countKey: 'editor',
    color:
      'border-violet-200 bg-violet-50/40 text-violet-700 dark:border-violet-900 dark:bg-violet-950/20 dark:text-violet-300',
  },
  {
    id: 'publish',
    label: 'Publish',
    description: 'Go live, now or scheduled',
    to: '/admin/published',
    countKey: 'publish',
    color:
      'border-emerald-200 bg-emerald-50/40 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300',
  },
  {
    id: 'live',
    label: 'Live Pages',
    description: 'What visitors see',
    to: '/admin/live-pages',
    countKey: 'live',
    color:
      'border-teal-200 bg-teal-50/40 text-teal-700 dark:border-teal-900 dark:bg-teal-950/20 dark:text-teal-300',
  },
]);

/**
 * One stage: the step number and its count on the top row, the label and a
 * two-line description below.
 *
 * STACKED, NOT SIDE BY SIDE. The row used to put the step circle, the text
 * and the count in one line inside a `flex-1 min-w-38` box: at xl the six
 * boxes, five chevrons and gaps needed about 1072 px of a 926 px card, so
 * Live Pages ran past the card's edge and five of the six descriptions were
 * cut to a few letters. Here the text has the whole box width, the count
 * sits beside the step number where it cannot squeeze the label, and the
 * description wraps to two lines instead of truncating to one.
 */
function PipelineStage({ step, stage, count, isLast }) {
  return (
    <li className="relative min-w-0">
      <Link
        to={stage.to}
        data-testid="pipeline-stage"
        className={`flex h-full flex-col gap-2 rounded-xl border px-3 py-3 transition-all hover:shadow-sm hover:-translate-y-0.5 ${stage.color}`}
        aria-label={`${stage.label}: ${stage.description}${count ? `, ${count} items` : ''}`}
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold"
            aria-hidden="true"
          >
            {step}
          </span>
          {count > 0 && (
            <span className="flex h-5 min-w-5.5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">
              {count > 999 ? '999+' : count}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold leading-5">{stage.label}</span>
          <span
            data-testid="pipeline-stage-description"
            className="line-clamp-2 text-xs leading-4 text-muted-foreground"
          >
            {stage.description}
          </span>
        </span>
      </Link>
      {/* The connector costs no width: it sits in the gap beside the step
          number, and only when the six stages share one row. On two or three
          columns the step numbers carry the order instead. */}
      {!isLast && (
        <ChevronRight
          className="pointer-events-none absolute top-6.75 -right-3.5 hidden h-3 w-3 -translate-y-1/2 text-muted-foreground/50 @4xl:block"
          aria-hidden="true"
        />
      )}
    </li>
  );
}

/**
 * The six stages on an equal grid, sized by the card, not the window
 * (container queries): the content column's width depends on the sidebar as
 * much as on the viewport. Six columns from 56rem (896 px, which the 926 px
 * card at xl clears), three from 28rem, two below. `auto-rows-fr` makes every
 * box the height of the tallest, so all six are the same size whichever row
 * they land on.
 */
function DashboardPipeline({ counts }) {
  return (
    <Section
      testId="pipeline-card"
      title="The pipeline"
      icon={TrendingUp}
      iconColor="text-primary"
      hint="Every piece of content moves left to right. A number is how many items are waiting at that stage; open a stage to work it."
    >
      <div className="@container">
        <ol
          data-testid="pipeline"
          className="m-0 grid list-none auto-rows-fr grid-cols-2 gap-4 p-0 @md:grid-cols-3 @4xl:grid-cols-6"
        >
          {PIPELINE_STAGES.map((stage, index) => (
            <PipelineStage
              key={stage.id}
              step={index + 1}
              stage={stage}
              count={stage.countKey ? counts[stage.countKey] : 0}
              isLast={index === PIPELINE_STAGES.length - 1}
            />
          ))}
        </ol>
      </div>
    </Section>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function Section({ title, icon: Icon, iconColor, to, children, hint, testId }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Icon className={`h-4 w-4 ${iconColor}`} aria-hidden="true" />
            {title}
          </CardTitle>
          {hint && <p className="mt-1 mb-0 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {to && (
          <Link
            to={to}
            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors shrink-0"
          >
            View all <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A count in running text that opens the page listing what it counts. */
function CountLink({ to, children }) {
  return (
    <Link
      to={to}
      className="underline-offset-2 hover:text-primary hover:underline focus-visible:underline"
    >
      {children}
    </Link>
  );
}

function DashboardHeader({
  today,
  counts,
  loadError,
  stale,
  onRetry,
  recalculating,
  onRecalculate,
  onNewContent,
}) {
  // The actions wrap below the text when the column is narrower than both:
  // side by side on a phone, they squeezed the headline onto four lines.
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {today}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {counts.queue > 0 ? (
            <CountLink to="/admin/queue?status=needs_review">
              {`${pluralize(counts.queue, 'item')} waiting for you`}
            </CountLink>
          ) : (
            "You're all caught up 🎉"
          )}
        </h1>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">
          <CountLink to="/admin/live-pages">{counts.live} pieces live</CountLink>
          {' · '}
          <CountLink to="/admin/editor">{counts.editor} in editor</CountLink>
          {counts.rejected > 0 && (
            <>
              {' · '}
              <CountLink to="/admin/queue?status=rejected">{counts.rejected} rejected</CountLink>
            </>
          )}
        </p>
        {loadError && (
          // A failed re-read keeps the last numbers on screen and says they
          // may be stale, with the way to try again beside the reason
          // (AP-F5, #929). The numbers are not wrong, only old.
          <div
            className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{loadError}</span>
            {stale && (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                Numbers may be stale
              </Badge>
            )}
            {onRetry && (
              <Button variant="outline" size="sm" className="h-7" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onRecalculate}
          disabled={recalculating}
          title="Recount every item from the content store. Use it when a number here looks wrong."
        >
          {recalculating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          )}
          {recalculating ? 'Recounting…' : 'Recount'}
        </Button>
        <Button size="sm" onClick={onNewContent}>
          <Zap className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          New Content
        </Button>
      </div>
    </div>
  );
}

/**
 * The content types, each counted across every stage, and Rejected.
 *
 * WHAT A TILE OPENS, AND WHY ITS NOTE SAYS SO. A type's number is its total
 * across every stage (the stats document's `total`). No list in the admin
 * shows that set: the Review Queue and the Frameworks and Coder Corner lists
 * have no all-statuses view, and each opens on its needs-review filter. The
 * Blogs tile used to show the total and land on that filter with nothing to
 * say so. Now the section says the number is every stage, the tile's link
 * names the filter it opens (`status=needs_review`, explicit rather than the
 * page's default), and the note says how many are waiting there, which is
 * the count the destination shows. Rejected opens the rejected list.
 */
const TYPE_TILES = Object.freeze([
  {
    label: 'Blogs',
    noun: 'blog',
    types: ['blog', 'news'],
    to: '/admin/queue?contentType=blog&status=needs_review',
    icon: FileText,
    iconClassName: 'text-blue-500',
  },
  {
    label: 'Architecture',
    noun: 'architecture',
    types: ['architecture'],
    to: '/admin/queue?contentType=architecture&status=needs_review',
    icon: Globe,
    iconClassName: 'text-purple-500',
  },
  {
    label: 'Frameworks',
    noun: 'framework',
    types: ['framework'],
    to: '/admin/frameworks?status=needs_review',
    icon: BookOpen,
    iconClassName: 'text-sky-500',
  },
  {
    label: 'Coder Corner',
    noun: 'Coder Corner',
    types: ['coder_corner'],
    to: '/admin/coder-corner?status=needs_review',
    icon: Code2,
    iconClassName: 'text-amber-500',
  },
]);

/** A type tile from countsFromSnapshot's byType, which holds every type. */
function typeTile({ types, noun, ...tile }, byType) {
  const sum = (bucket) => types.reduce((n, type) => n + byType[type][bucket], 0);
  const total = sum('total');
  const waiting = sum('needsReview');
  return {
    ...tile,
    value: total,
    note: `${waiting} to review`,
    ariaLabel: `${tile.label}: ${total} across every stage, ${waiting} waiting for review. Opens the ${noun} review list.`,
  };
}

function DashboardStats({ counts }) {
  const tiles = [
    ...TYPE_TILES.map((tile) => typeTile(tile, counts.byType)),
    {
      label: 'Rejected',
      icon: AlertCircle,
      iconClassName: 'text-destructive',
      value: counts.rejected,
      to: '/admin/queue?status=rejected',
      note: counts.rejected > 0 ? 'Auto-deletes in 24h' : null,
      noteClassName: 'text-red-700 dark:text-red-300',
      ariaLabel: `Rejected: ${counts.rejected}.${counts.rejected > 0 ? ' Auto-deletes in 24h.' : ''} Opens the rejected list.`,
    },
  ];

  return (
    <Section
      title="Content by type"
      icon={Layers}
      iconColor="text-primary"
      hint="Each type's total across every stage. A tile opens that type's review list, and its note says how many are waiting there."
    >
      {/* Sized by the card, like the pipeline: five from 48rem (the 926 px
          card at xl), three from 32rem, two below. Not `@2xl`: index.css
          sets `--container-2xl` to 1400px, so `@2xl` would never apply. */}
      <div className="@container">
        <div className="grid auto-rows-fr grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-5">
          {tiles.map(({ label, ...tile }) => (
            <StatTile key={label} label={label} {...tile} />
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * One card per menu group after Home, each carrying the registry's sentence
 * and its items — the whole product explained on the first screen.
 */
function DashboardExplore() {
  const groups = NAV_GROUPS.filter((group) => group.id !== 'home');
  return (
    <section aria-labelledby="explore-heading" className="space-y-3">
      <div>
        <h2 id="explore-heading" className="text-base font-semibold">
          Explore ContentForge
        </h2>
        <p className="mt-1 mb-0 text-xs text-muted-foreground">
          What each part of the menu is for. Hover any menu item for the same sentence.
        </p>
      </div>
      {/* `grid-cols-1`, not the implicit column (AP-F1). An implicit track is
          sized to its content, and each item's one-line, truncated description
          made that the full sentence: on a Pixel 5 the cards were 675 px wide
          in a 393 px column and the dashboard scrolled sideways. An explicit
          column is `minmax(0, 1fr)`, so the description truncates as meant.
          e2e/admin-authenticated.spec.js holds the line on a phone. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <Card key={group.id} className="h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                {group.label}
              </CardTitle>
              <p className="mb-0 text-xs text-muted-foreground">{group.description}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60 transition-colors"
                        title={item.description}
                      >
                        <Icon
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{item.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { authReady } = useAuthReady();
  const navigate = useNavigate();
  const { snapshot, counts, loading, error, refresh, recalculate } = useDashboardCounts({
    enabled: authReady,
    refetchOnNavigate: false,
  });
  const [recalculating, setRecalculating] = React.useState(false);
  const [recalcError, setRecalcError] = React.useState('');

  const handleRecalculate = async () => {
    setRecalculating(true);
    setRecalcError('');
    try {
      await recalculate();
    } catch (err) {
      setRecalcError(err?.message || 'Failed to recalculate.');
    } finally {
      setRecalculating(false);
    }
  };

  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  if (loading && !snapshot) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
          <p className="text-sm">Loading your dashboard…</p>
        </div>
      </div>
    );
  }

  // A first read that failed is an outage, not an empty inbox (AP-F5, #929).
  // This used to fall through to the celebratory heading over zero counts,
  // with a small red line beneath, so a backend outage read as "no work":
  // the unknown-versus-zero confusion the codebase has fixed elsewhere.
  if (error && !snapshot) {
    return (
      <div className="space-y-6">
        <p className="mb-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {today}
        </p>
        <EmptyState
          variant="error"
          title="The dashboard could not be loaded"
          description={error}
          onRetry={refresh}
        />
      </div>
    );
  }

  // One gap token between sections (24 px). Each section owns its inside
  // spacing; nothing here carries a margin of its own, and the paragraphs
  // that close a block set `mb-0` over the `p` default in index.css.
  return (
    <div className="space-y-6">
      <DashboardHeader
        today={today}
        counts={counts}
        loadError={error || recalcError}
        stale={Boolean(error && snapshot)}
        onRetry={error ? refresh : null}
        recalculating={recalculating}
        onRecalculate={handleRecalculate}
        onNewContent={() => navigate('/admin/submit')}
      />
      <DashboardPipeline counts={counts} />
      <DashboardStats counts={counts} />
      <DecisionCenter enabled={authReady} />
      <DashboardExplore />
    </div>
  );
}
