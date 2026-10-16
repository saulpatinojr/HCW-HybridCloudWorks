import React from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { TrendingUp, ChevronRight, ArrowRight } from 'lucide-react';
import { visibleNavFor } from '@/config/adminNav';

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
    to: '/admin/new-content',
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
    to: '/admin/review-queue',
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
    to: '/admin/publish',
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

export function Section({ title, icon: Icon, iconColor, to, children, hint, testId }) {
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

/**
 * One stage: the step number and its count on the top row, the label and a
 * two-line description below.
 */
export function PipelineStage({ step, stage, count, isLast }) {
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
            <span className="flex h-5 min-w-5.5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">
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
      {!isLast && (
        <ChevronRight
          data-testid="pipeline-connector"
          className="pointer-events-none absolute top-6.75 -right-3.5 hidden h-3 w-3 -translate-y-1/2 text-muted-foreground/50 @4xl:block"
          aria-hidden="true"
        />
      )}
    </li>
  );
}

/**
 * The six stages on an equal grid, sized by the card, not the window.
 */
export default function DashboardPipeline({ counts, role }) {
  const stages = React.useMemo(() => {
    const offered = new Set(
      visibleNavFor(role).flatMap((group) => group.items.map((item) => item.to))
    );
    return PIPELINE_STAGES.filter((stage) => offered.has(stage.to));
  }, [role]);
  if (stages.length === 0) return null;
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
          {stages.map((stage, index) => (
            <PipelineStage
              key={stage.id}
              step={index + 1}
              stage={stage}
              count={stage.countKey ? counts[stage.countKey] : 0}
              isLast={index === stages.length - 1}
            />
          ))}
        </ol>
      </div>
    </Section>
  );
}
