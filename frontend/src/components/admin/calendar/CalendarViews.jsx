/**
 * The three views over one grouped item map (ADR 0033 Amplify slice).
 *
 *   MonthGrid  seven columns, up to six weeks; each day is a drop target and
 *              has an "Add" button — the keyboard route to quick create
 *   WeekView   seven columns of the week's items, timed and all-day
 *   AgendaView the next thirty days as a list, days with nothing omitted
 *
 * Every day cell is a region a drag can land on; the handler decides whether
 * the drop is allowed (past days are refused) and what to do with it. Quick
 * create is the cell's Add button — a real button, so it is the same for a
 * mouse and a keyboard — rather than a double-click nothing announces.
 */
import React from 'react';
import { Plus } from 'lucide-react';
import { DRAG_TYPE, addDays, dayKeyOf, isPastDay, monthGridDays, weekDays } from './calendarModel';
import CalendarItemChip from './CalendarItemChip';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_MAX_CHIPS = 3;

function dropProps(day, onDrop) {
  return {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      if (isPastDay(day)) {
        event.dataTransfer.dropEffect = 'none';
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event) => {
      const raw = event.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      event.preventDefault();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      onDrop(day, payload);
    },
  };
}

function DayHeading({ day, today, onAdd }) {
  const past = isPastDay(day, today);
  const label = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(day);
  return (
    <div className="flex items-center justify-between">
      <span
        className={`text-xs font-medium ${dayKeyOf(day) === dayKeyOf(today) ? 'rounded-full bg-primary px-1.5 text-primary-foreground' : ''}`}
      >
        {day.getDate()}
      </span>
      {!past && onAdd && (
        <button
          type="button"
          onClick={() => onAdd(day)}
          aria-label={`Schedule something on ${label}`}
          title="Schedule content on this day"
          className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function MonthGrid({ cursor, days, conflicts, today, onSelect, onAdd, onDrop, onMore }) {
  const grid = monthGridDays(cursor);
  return (
    <div className="grid grid-cols-7 gap-1" role="grid" aria-label="Month">
      {WEEKDAYS.map((name) => (
        <div
          key={name}
          role="columnheader"
          className="py-1 text-center text-xs font-semibold text-muted-foreground"
        >
          {name}
        </div>
      ))}
      {grid.map((day) => {
        const key = dayKeyOf(day);
        const items = days.get(key) || [];
        const inMonth = day.getMonth() === cursor.getMonth();
        const past = isPastDay(day, today);
        return (
          <div
            key={key}
            role="gridcell"
            aria-label={`${new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(day)}: ${items.length} item(s)`}
            {...dropProps(day, onDrop)}
            className={`group min-h-24 rounded-md border p-1 ${inMonth ? 'bg-background' : 'bg-muted/30 opacity-70'} ${
              past ? 'border-border/60' : 'border-border'
            }`}
          >
            <DayHeading day={day} today={today} onAdd={onAdd} />
            <div className="mt-1 space-y-0.5">
              {items.slice(0, MONTH_MAX_CHIPS).map((item) => (
                <CalendarItemChip
                  key={item.id}
                  item={item}
                  compact
                  conflict={conflicts.has(item.id)}
                  onSelect={onSelect}
                />
              ))}
              {items.length > MONTH_MAX_CHIPS && (
                <button
                  type="button"
                  onClick={() => onMore?.(day)}
                  className="text-xs text-muted-foreground underline"
                >
                  +{items.length - MONTH_MAX_CHIPS} more
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WeekView({ cursor, days, conflicts, today, onSelect, onAdd, onDrop }) {
  return (
    <div className="grid grid-cols-7 gap-1" role="grid" aria-label="Week">
      {weekDays(cursor).map((day) => {
        const key = dayKeyOf(day);
        const items = days.get(key) || [];
        return (
          <div
            key={key}
            role="gridcell"
            {...dropProps(day, onDrop)}
            className="group min-h-[28rem] rounded-md border border-border p-1.5"
          >
            <p className="text-xs font-semibold text-muted-foreground">{WEEKDAYS[day.getDay()]}</p>
            <DayHeading day={day} today={today} onAdd={onAdd} />
            <div className="mt-2 space-y-1">
              {items.length === 0 && (
                <p className="text-xs text-muted-foreground">Nothing scheduled</p>
              )}
              {items.map((item) => (
                <CalendarItemChip
                  key={item.id}
                  item={item}
                  conflict={conflicts.has(item.id)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgendaView({ cursor, days, conflicts, onSelect }) {
  const list = [];
  for (let i = 0; i < 30; i += 1) {
    const day = addDays(cursor, i);
    const items = days.get(dayKeyOf(day)) || [];
    if (items.length) list.push({ day, items });
  }
  if (list.length === 0) return null;
  return (
    <ol className="space-y-3" aria-label="Agenda">
      {list.map(({ day, items }) => (
        <li key={dayKeyOf(day)} className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <p className="text-sm font-medium">
            {new Intl.DateTimeFormat('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            }).format(day)}
          </p>
          <div className="space-y-1">
            {items.map((item) => (
              <CalendarItemChip
                key={item.id}
                item={item}
                conflict={conflicts.has(item.id)}
                onSelect={onSelect}
              />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
