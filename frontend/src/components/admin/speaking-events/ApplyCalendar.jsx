/**
 * The small month calendar on the "Events to apply to" tab (#1823, ADR 0045).
 *
 * It marks, for one month: the days each listed event runs (and each event
 * the owner saved a status for), the days of the owner's own talks that are
 * sent or accepted, the days a call for speakers closes, and the days where
 * two of those clash. What counts as a clash is applyModel.js's rule, the
 * same one the rows use.
 *
 * NOT COLOUR ALONE. Each kind of mark is a different shape with its word in
 * the legend, a clash day carries a warning icon and the word "clash" in its
 * label, and every marked day is a button whose label reads out what is on
 * it. Choosing a day lists that day's entries under the calendar, so the
 * marks never have to be read from their shape.
 */
import React, { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MONTH_NAMES, WEEKDAYS, formatDay, monthGrid, shiftMonth } from './applyModel';

/** What a day holds, as one sentence for a screen reader and the tooltip. */
export function describeDay(day, mark) {
  if (!mark) return formatDay(day);
  const parts = [];
  if (mark.overlap) parts.push('clash');
  if (mark.events.length)
    parts.push(`${mark.events.length} event${mark.events.length === 1 ? '' : 's'}`);
  if (mark.talks.length) parts.push(`${mark.talks.length} of your talks`);
  if (mark.deadlines.length)
    parts.push(`${mark.deadlines.length} call${mark.deadlines.length === 1 ? '' : 's'} closing`);
  return `${formatDay(day)}: ${parts.join(', ')}`;
}

const SHAPES = {
  event: 'h-1.5 w-1.5 rounded-sm bg-sky-600 dark:bg-sky-400',
  talk: 'h-1.5 w-1.5 rotate-45 bg-emerald-600 dark:bg-emerald-400',
  deadline: 'h-1.5 w-1.5 rounded-full border border-amber-600 dark:border-amber-400',
};

function Legend() {
  const item = (shape, label) => (
    <li className="flex items-center gap-1.5">
      <span className={shape} aria-hidden="true" /> {label}
    </li>
  );
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      aria-label="Calendar legend"
    >
      {item(SHAPES.event, 'Event from this list (square)')}
      {item(SHAPES.talk, 'Your talk, sent or accepted (diamond)')}
      {item(SHAPES.deadline, 'A call closes (ring)')}
      <li className="flex items-center gap-1.5">
        <AlertTriangle className="h-3 w-3 text-rose-600 dark:text-rose-400" aria-hidden="true" />{' '}
        Clash (warning sign)
      </li>
    </ul>
  );
}

function DayDetails({ day, mark }) {
  if (!day) {
    return (
      <p className="text-xs text-muted-foreground">Choose a marked day to see what is on it.</p>
    );
  }
  return (
    <div className="space-y-1 text-xs" aria-live="polite">
      <p className="font-medium">
        {formatDay(day)}
        {mark?.overlap ? ' (clash)' : ''}
      </p>
      {!mark && <p className="text-muted-foreground">Nothing on this day.</p>}
      <ul className="space-y-0.5">
        {mark?.events.map((event) => (
          <li key={`e-${event.id}`}>
            Event: {event.title}
            {event.listed ? '' : ' (saved, no longer listed)'}
          </li>
        ))}
        {mark?.talks.map((talk) => (
          <li key={`t-${talk.name}`}>
            Your talk: {talk.name} ({talk.statusLabel})
          </li>
        ))}
        {mark?.deadlines.map((deadline) => (
          <li key={`d-${deadline.title}`}>Call closes: {deadline.title}</li>
        ))}
      </ul>
    </div>
  );
}

/** The border and background of one day's box: a clash first, then today. */
function frameClass(mark, isToday) {
  if (mark?.overlap) return 'border-rose-500 bg-rose-50 dark:bg-rose-950/40';
  return isToday ? 'border-foreground/60' : 'border-transparent';
}

/** One day: a button when something is on it, plain text when nothing is. */
function DayCell({ cell, mark, isToday, selected, onSelect }) {
  const box = `flex h-10 w-full flex-col items-center justify-center gap-0.5 rounded-md border ${frameClass(mark, isToday)}`;
  const inner = (
    <>
      <span className={isToday ? 'font-semibold underline' : ''}>{cell.date}</span>
      <span className="flex h-2.5 items-center justify-center gap-0.5" aria-hidden="true">
        {mark?.overlap && (
          <AlertTriangle className="h-2.5 w-2.5 text-rose-600 dark:text-rose-400" />
        )}
        {mark?.events.length > 0 && <span className={SHAPES.event} />}
        {mark?.talks.length > 0 && <span className={SHAPES.talk} />}
        {mark?.deadlines.length > 0 && <span className={SHAPES.deadline} />}
      </span>
    </>
  );
  if (!mark) {
    return (
      <div className={box} aria-current={isToday ? 'date' : undefined}>
        {inner}
      </div>
    );
  }
  const label = describeDay(cell.day, mark);
  return (
    <button
      type="button"
      className={`${box} hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
        selected ? 'bg-muted' : ''
      }`}
      aria-label={label}
      aria-pressed={selected}
      aria-current={isToday ? 'date' : undefined}
      title={label}
      data-overlap={mark.overlap ? 'true' : undefined}
      onClick={() => onSelect(cell.day)}
    >
      {inner}
    </button>
  );
}

/**
 * @param {object} props
 * @param {{ year: number, monthIndex: number }} props.month
 * @param {(month: { year: number, monthIndex: number }) => void} props.onMonth
 * @param {Map<string, object>} props.marks - applyModel.marksForMonth for `month`
 * @param {string} props.today - the reader's day, `YYYY-MM-DD`
 */
export default function ApplyCalendar({ month, onMonth, marks, today }) {
  const [selected, setSelected] = useState(null);
  const weeks = monthGrid(month.year, month.monthIndex);
  const title = `${MONTH_NAMES[month.monthIndex]} ${month.year}`;
  const move = (by) => {
    setSelected(null);
    onMonth(shiftMonth(month, by));
  };
  return (
    <section
      className="space-y-3 rounded-xl border border-border p-4"
      aria-label="Calendar of events and your talks"
    >
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => move(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-sm font-semibold" aria-live="polite">
          {title}
        </h3>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => move(1)}
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <table className="w-full table-fixed border-collapse text-center text-xs">
        <caption className="sr-only">
          {title}: events to apply to, your talks and closing calls
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday} scope="col" className="pb-1 font-medium text-muted-foreground">
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean).day}>
              {week.map((cell, index) =>
                cell ? (
                  <td key={cell.day} className="p-0.5">
                    <DayCell
                      cell={cell}
                      mark={marks.get(cell.day)}
                      isToday={cell.day === today}
                      selected={selected === cell.day}
                      onSelect={setSelected}
                    />
                  </td>
                ) : (
                  // Index only for the blanks, which have no day of their own.
                  <td key={`blank-${index}`} />
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <Legend />
      <DayDetails day={selected} mark={selected ? marks.get(selected) : null} />
      <p className="text-xs text-muted-foreground">
        Days are each event’s own local days, compared as written. A cancelled or postponed event is
        left off.
      </p>
    </section>
  );
}
