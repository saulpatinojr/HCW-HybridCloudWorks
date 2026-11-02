/**
 * The small pieces every Cost tab draws: a dollar figure, a date in the
 * viewer's own format with the ISO date behind it, a budget bar that says its
 * percentage in words as well as colour, a labelled figure, and the card frame.
 *
 * Colour is never the only signal (ADR 0033 §2): every bar prints its
 * percentage, and every tone has a word beside it where it matters.
 */
import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { budgetTone, fmtUsd } from '@/lib/cost';

/** The bar colour for a budget tone (lib/cost budgetTone). */
export const BAR_CLASS = Object.freeze({
  ok: 'bg-emerald-500',
  info: 'bg-sky-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  muted: 'bg-slate-400',
});

/** The text colour for a tone, for a figure that stands beside a bar. */
export const TEXT_CLASS = Object.freeze({
  ok: 'text-emerald-700 dark:text-emerald-400',
  info: 'text-sky-700 dark:text-sky-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-rose-700 dark:text-rose-400',
  muted: 'text-muted-foreground',
});

/** A dollar figure, tabular so columns of them line up. */
export function Money({ value, className = '' }) {
  return <span className={`tabular-nums ${className}`}>{fmtUsd(value)}</span>;
}

/**
 * A `YYYY-MM-DD` (or ISO instant) in the viewer's own date format, with the
 * exact value in `title` for anyone who needs the ISO form. All-day dates are
 * shown on the day they name whatever the time zone.
 */
export function DateText({ value, withTime = false, fallback = '—' }) {
  if (!value) return <span>{fallback}</span>;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const date = new Date(dayOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return <span>{String(value)}</span>;
  const text = new Intl.DateTimeFormat(undefined, {
    ...(dayOnly ? { timeZone: 'UTC' } : {}),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime && !dayOnly ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date);
  return (
    <time dateTime={String(value)} title={String(value)}>
      {text}
    </time>
  );
}

/**
 * How far through a budget something is. The filled part is the percentage
 * used; a thin marker shows where the forecast lands; both are printed as
 * words under the bar, so the colour is never the only way to read it.
 *
 * @param {{ percent: number|null, forecastPercent?: number|null, label: string }} props
 */
export function BudgetBar({ percent, forecastPercent = null, label }) {
  const tone = budgetTone(percent);
  const used = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const forecast = Number.isFinite(forecastPercent)
    ? Math.max(0, Math.min(100, forecastPercent))
    : null;
  const words = Number.isFinite(percent)
    ? `${percent}% used${Number.isFinite(forecastPercent) ? `, ${forecastPercent}% forecast` : ''}`
    : 'no budget to compare with';
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number.isFinite(percent) ? Math.round(percent) : undefined}
        aria-valuetext={words}
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${BAR_CLASS[tone]}`} style={{ width: `${used}%` }} />
        {forecast !== null ? (
          <div
            aria-hidden="true"
            title={`Forecast: ${forecastPercent}% of the budget`}
            className="absolute top-0 h-full w-0.5 bg-foreground/70"
            style={{ left: `calc(${forecast}% - 1px)` }}
          />
        ) : null}
      </div>
      <p className={`text-xs ${TEXT_CLASS[tone]}`}>{words}</p>
    </div>
  );
}

/** One labelled figure in a row of them: the word small above, the value below. */
export function Figure({ label, value, note = null, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

/** A row of figures, as a description list so each label names its value. */
export function Figures({ children, className = '' }) {
  return <dl className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${className}`}>{children}</dl>;
}

/** The card every tab section sits in: a title, one sentence, and the content. */
export function SectionCard({
  title,
  description = null,
  action = null,
  children,
  className = '',
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {action}
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** The table styling every list on the page shares. */
export const TABLE_CLASS = 'w-full text-xs';
export const TH_CLASS = 'pb-1 font-medium text-muted-foreground';
export const TD_CLASS = 'py-1.5 border-b border-border/60';

/** The thousands-separated count of something. */
export const fmtCount = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
