/**
 * The Calendar's controls: view, page, today, filters by kind, status and
 * channel, the time zone the grid is drawn in, and Refresh. Kind filters are
 * toggle buttons with the kind's icon, so the legend and the filter are one
 * thing (ADR 0033 Amplify slice).
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { KINDS, VIEWS, kindMeta, rangeLabel } from './calendarModel';

const VIEW_LABELS = { month: 'Month', week: 'Week', agenda: 'Agenda' };
const STATUSES = [
  'scheduled',
  'published',
  'sent',
  'failed',
  'deadline',
  // The owner's alerts
  'open',
  'snoozed',
  'done',
];

export default function CalendarToolbar({
  view,
  cursor,
  filters,
  channels,
  kinds = KINDS,
  timeZone,
  pending,
  showKindFilter = true,
  onView,
  onStep,
  onToday,
  onFilters,
  onRefresh,
}) {
  const toggleKind = (kind) => {
    const current = new Set(filters.kinds);
    if (current.has(kind)) current.delete(kind);
    else current.add(kind);
    onFilters({ ...filters, kinds: [...current] });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onToday}>
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onStep(-1)}
            aria-label={`Previous ${view}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onStep(1)}
            aria-label={`Next ${view}`}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="ml-2 text-base font-semibold" aria-live="polite">
            {rangeLabel(view, cursor)}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="View"
            className="flex rounded-md border border-border p-0.5"
          >
            {VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onView(id)}
                aria-pressed={view === id}
                className={`rounded px-2.5 py-1 text-xs font-medium ${
                  view === id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {VIEW_LABELS[id]}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={onRefresh}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {showKindFilter && (
          <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1">
            {kinds.map((kind) => {
              const meta = kindMeta(kind);
              const { Icon } = meta;
              const on = filters.kinds.length === 0 || filters.kinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  aria-pressed={filters.kinds.includes(kind)}
                  title={
                    filters.kinds.includes(kind)
                      ? `Showing only ${meta.label}`
                      : `Show only ${meta.label}`
                  }
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${meta.chip} ${on ? '' : 'opacity-40'}`}
                >
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {meta.label}
                </button>
              );
            })}
            {filters.kinds.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground underline"
                onClick={() => onFilters({ ...filters, kinds: [] })}
              >
                All kinds
              </button>
            )}
          </div>
        )}
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Status</span>
          <select
            value={filters.status}
            onChange={(event) => onFilters({ ...filters, status: event.target.value })}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            <option value="">Any</option>
            {STATUSES.map((status) => (
              <option key={status} value={status} className="capitalize">
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Channel</span>
          <select
            value={filters.channel}
            onChange={(event) => onFilters({ ...filters, channel: event.target.value })}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            <option value="">Any</option>
            {channels.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
        <span
          className="ml-auto text-muted-foreground"
          title="Every time on this calendar is shown in this time zone"
        >
          Times in {timeZone}
        </span>
      </div>
    </div>
  );
}
