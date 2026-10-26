/**
 * The one calendar (ADR 0033 §2: "Calendar aggregates newsletter sends; the
 * hub keeps its month view as a filtered embed"). The Calendar page renders
 * it over every kind; the Newsletter Hub renders it with `kinds=['newsletter']`
 * and its own `onSelectItem`, so both read the same items the same way.
 *
 * It owns the view, the cursor and the filters, reads through
 * `useCalendarItems`, writes through `useCalendarWrites`, and REFETCHES after
 * every mutation — the top bug of the page it replaces was never doing so.
 * The preview dialog's actions report back through `onDone`, which is that
 * refetch.
 */
import React, { useMemo, useState } from 'react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { AlertTriangle, Loader2 } from 'lucide-react';
import CalendarToolbar from './CalendarToolbar';
import { AgendaView, MonthGrid, WeekView } from './CalendarViews';
import ItemPreviewDialog from './ItemPreviewDialog';
import ScheduleDialog from './ScheduleDialog';
import useCalendarItems from './useCalendarItems';
import useCalendarWrites from './useCalendarWrites';
import {
  KINDS,
  applyFilters,
  browserTimeZone,
  channelsOf,
  findConflicts,
  groupByDay,
  stepCursor,
} from './calendarModel';

export { planDrop } from './useCalendarWrites';

const EMPTY_FILTERS = Object.freeze({ kinds: [], status: '', channel: '' });

/** The grid for the view, or the empty states the agenda needs. */
function CalendarBody({ view, read, visible, viewProps, onMore }) {
  if (view === 'month') return <MonthGrid {...viewProps} onMore={onMore} />;
  if (view === 'week') return <WeekView {...viewProps} />;
  if (visible.length > 0) return <AgendaView {...viewProps} />;
  const filtered = read.items.length > 0;
  return (
    <EmptyState
      variant={filtered ? 'filtered' : 'empty'}
      title={filtered ? 'Nothing matches these filters' : 'Nothing in the next thirty days'}
      description={
        filtered
          ? 'Clear a filter to see the rest.'
          : 'Schedule content from the Unscheduled panel, or approve an issue in the Newsletter Hub.'
      }
    />
  );
}

/** Loading, error, or the body with its "everything filtered" footnote. */
function CalendarContent({ read, view, visible, viewProps, onMore }) {
  if (read.error) {
    return (
      <EmptyState
        variant="error"
        title="The calendar could not be read"
        description={read.error}
        onRetry={read.refresh}
      />
    );
  }
  if (read.loading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the calendar…
      </p>
    );
  }
  const allHidden = view !== 'agenda' && read.items.length > 0 && visible.length === 0;
  return (
    <div aria-busy={read.pending}>
      <CalendarBody
        view={view}
        read={read}
        visible={visible}
        viewProps={viewProps}
        onMore={onMore}
      />
      {allHidden && (
        <p className="pt-2 text-xs text-muted-foreground">
          Every item is hidden by the filters above.
        </p>
      )}
    </div>
  );
}

/**
 * The schedule dialog to show, if any: the write hook's own request first,
 * else a Schedule… press on the Unscheduled panel arriving as a prop.
 */
function activeDialog(scheduling, scheduleRequest, now) {
  if (scheduling) return scheduling;
  if (!scheduleRequest) return null;
  return { content: scheduleRequest.content, day: scheduleRequest.day || now, mode: 'schedule' };
}

/** Names the sources whose items are missing from this read. */
function SourceWarning({ warnings }) {
  if (warnings.length === 0) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Some sources could not be read, so their items are missing: {warnings.join('; ')}</span>
    </p>
  );
}

/** The ScheduleDialog keyed on its content and day, so a new request starts a fresh form. */
function CalendarScheduleDialog({ dialog, unscheduled, items, busy, onSubmit, onClose }) {
  return (
    <ScheduleDialog
      open
      key={`${dialog.content?.id ?? 'pick'}:${dialog.day?.getTime?.() ?? ''}`}
      content={dialog.content}
      choices={unscheduled}
      initialDay={dialog.day}
      initialTime={dialog.time || '09:00'}
      items={items}
      excludeId={dialog.excludeId || null}
      mode={dialog.mode}
      busy={busy}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}

/**
 * @param {object} props
 * @param {string[]|null} [props.kinds] server-side narrowing; null is every kind
 * @param {'month'|'week'|'agenda'} [props.initialView]
 * @param {Date} [props.initialCursor]
 * @param {(item: object) => void} [props.onSelectItem] replaces the preview dialog
 * @param {object[]} [props.unscheduled] content the Unscheduled panel offers, for the dialog's picker
 * @param {() => void} [props.onChanged] told after every write, so a sibling panel can refetch too
 * @param {boolean} [props.enabled]
 * @param {number} [props.refreshToken] changes when something outside the grid changed what it shows
 * @param {object|null} [props.scheduleRequest] `{ content, day? }` from outside (the panel's Schedule…); cleared via onScheduleHandled
 * @param {() => void} [props.onScheduleHandled]
 * @param {Date} [props.today] injected for tests
 */
export default function SharedCalendar({
  kinds = null,
  initialView = 'month',
  initialCursor,
  onSelectItem,
  unscheduled = [],
  onChanged,
  enabled = true,
  refreshToken = 0,
  scheduleRequest = null,
  onScheduleHandled,
  today,
}) {
  const now = today || new Date();
  const [view, setView] = useState(initialView);
  const [cursor, setCursor] = useState(initialCursor || now);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState(null);

  const read = useCalendarItems({ view, cursor, kinds, enabled, refreshToken });
  // Every write ends here: the refetch, and the word to a sibling panel.
  const changed = () => {
    read.refresh();
    onChanged?.();
  };
  const writes = useCalendarWrites({ unscheduled, onChanged: changed });
  const visible = useMemo(() => applyFilters(read.items, filters), [read.items, filters]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const conflicts = useMemo(() => findConflicts(read.items), [read.items]);
  const channels = useMemo(() => channelsOf(read.items), [read.items]);

  const dialog = activeDialog(writes.scheduling, scheduleRequest, now);
  const closeDialog = () => {
    writes.setScheduling(null);
    onScheduleHandled?.();
  };

  const select = (item) => (onSelectItem ? onSelectItem(item) : setSelected(item));
  const showWeekOf = (day) => {
    setCursor(day);
    setView('week');
  };

  const viewProps = {
    cursor,
    days,
    conflicts,
    today: now,
    onSelect: select,
    onAdd: writes.quickCreate,
    onDrop: writes.onDrop,
  };

  return (
    <div className="space-y-3">
      <CalendarToolbar
        view={view}
        cursor={cursor}
        filters={filters}
        channels={channels}
        kinds={kinds || KINDS}
        showKindFilter={!kinds || kinds.length > 1}
        timeZone={browserTimeZone()}
        pending={read.pending}
        onView={setView}
        onStep={(delta) => setCursor((current) => stepCursor(view, current, delta))}
        onToday={() => setCursor(now)}
        onFilters={setFilters}
        onRefresh={read.refresh}
      />

      <SourceWarning warnings={read.warnings} />

      <CalendarContent
        read={read}
        view={view}
        visible={visible}
        viewProps={viewProps}
        onMore={showWeekOf}
      />

      {!onSelectItem && (
        <ItemPreviewDialog
          item={selected}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            changed();
          }}
          onReschedule={(item) => {
            setSelected(null);
            writes.reschedule(item);
          }}
        />
      )}

      {dialog && (
        <CalendarScheduleDialog
          dialog={dialog}
          unscheduled={unscheduled}
          items={read.items}
          busy={writes.busy}
          onSubmit={async (picked) => {
            if (await writes.submitSchedule(picked)) closeDialog();
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
