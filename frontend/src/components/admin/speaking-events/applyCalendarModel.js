/**
 * The Future Events calendar's rules: which events clash with what the owner
 * already has, the weeks of a month, and what each day of a month marks.
 * The rules for days and clashes are in applyModel.js's header.
 */
import { normalizeName } from '@/lib/speakingEvents';
import {
  DAY,
  addDays,
  applyStatusInfo,
  committedTalks,
  dayFromUtc,
  formatDay,
  formatRange,
  isDay,
  isDropped,
  isOffCalendar,
  isPlanned,
  knownEvents,
  pad,
  rangesOverlap,
} from './applyModel';

/**
 * What one event's dates meet, by the rule in the header.
 *
 * `clashes` is filled only for an event the owner planned (Interested,
 * Applied or Accepted). For an event with no status the same entries come
 * back as `wouldMeet`: worth knowing before applying, but not a clash. An
 * event marked Not going or Declined, or one that is cancelled or postponed,
 * gets nothing.
 *
 * @param {object} event - one known event (`knownEvents`)
 * @param {{ talks: object[], known: object[] }} against
 * @returns {{ clashes: Array<{ kind: 'talk'|'event', name: string, detail: string }>, wouldMeet: Array<{ kind: 'talk'|'event', name: string, detail: string }>, speakingHere: string|null }}
 */
export function overlapsFor(event, { talks, known }) {
  const result = { clashes: [], wouldMeet: [], speakingHere: null };
  if (!isLiveEvent(event)) return result;
  const fromTalks = talksMet(event, talks);
  result.speakingHere = fromTalks.speakingHere;
  const meets = [...fromTalks.meets, ...eventsMet(event, known)];
  if (isPlanned(event.status)) result.clashes = meets;
  else result.wouldMeet = meets;
  return result;
}

// An event whose dates still count: it has a range, is on the calendar, and
// was not marked Not going or Declined.
function isLiveEvent(event) {
  return Boolean(event?.range) && !event.offCalendar && !isDropped(event.status);
}

const dayIn = (day, range) => day >= range.start && day <= range.end;

// The owner's committed talks on the event's days. A talk at this very event
// is not a clash: it says the owner is speaking here.
function talksMet(event, talks) {
  const meets = [];
  let speakingHere = null;
  const ownName = normalizeName(event.title);
  for (const talk of committedTalks(talks)) {
    if (!dayIn(talk.day, event.range)) continue;
    if (ownName && normalizeName(talk.name) === ownName) {
      speakingHere = talk.statusLabel;
    } else {
      meets.push({
        kind: 'talk',
        name: talk.name,
        detail: `${talk.statusLabel} talk on ${formatDay(talk.day)}`,
      });
    }
  }
  return { meets, speakingHere };
}

// The other planned events whose dates meet this one's.
function eventsMet(event, known) {
  const meets = [];
  for (const other of known) {
    if (other.id === event.id || other.offCalendar || !isPlanned(other.status)) continue;
    if (rangesOverlap(event.range, other.range)) {
      meets.push({
        kind: 'event',
        name: other.title,
        detail: `${applyStatusInfo(other.status).label}, ${formatRange(other.range)}`,
      });
    }
  }
  return meets;
}

/** `overlapsFor` for every known event, by id. */
export function allOverlaps({ events, saved, talks }) {
  const known = knownEvents(events, saved);
  return new Map(known.map((event) => [event.id, overlapsFor(event, { talks, known })]));
}

/**
 * The weeks of one month, Sunday first: each week is seven cells, a cell is
 * `{ day, date }` or null for the blanks before the 1st and after the last.
 *
 * @param {number} year
 * @param {number} monthIndex - 0 for January
 */
export function monthGrid(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Array.from({ length: first.getUTCDay() }, () => null);
  for (let date = 1; date <= days; date += 1) {
    cells.push({ day: `${year}-${pad(monthIndex + 1)}-${pad(date)}`, date });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** The month after or before `{ year, monthIndex }`, across a year's end. */
export function shiftMonth({ year, monthIndex }, by) {
  const moved = new Date(Date.UTC(year, monthIndex + by, 1));
  return { year: moved.getUTCFullYear(), monthIndex: moved.getUTCMonth() };
}

/** The month a day is in. */
export const monthOf = (day) => {
  const [, year, month] = DAY.exec(day).map(Number);
  return { year, monthIndex: month - 1 };
};

/**
 * Whether an event's call for speakers closes on a day from `first` to `last`
 * and is still worth a mark: not cancelled, and not one the owner marked Not
 * going or Declined.
 */
const closesWithin = (event, first, last) =>
  closesBetween(event.callCloses, first, last) &&
  !event.cancelled &&
  !isDropped(event.note?.status);

const closesBetween = (day, first, last) => isDay(day) && day >= first && day <= last;

/**
 * What the calendar marks on each day of one month.
 *
 * Returns a Map from day to `{ events, unmarked, talks, deadlines, overlap }`:
 *
 *   events     the events held that day that the owner planned (Interested,
 *              Applied or Accepted)
 *   unmarked   the events held that day that have no status yet; the calendar
 *              draws these as one faint mark
 *   talks      the owner's committed talks that day
 *   deadlines  the calls for speakers that close that day
 *   overlap    whether that day is a clash day (the header's rule)
 *
 * Cancelled and postponed events are left out, and so are events marked Not
 * going or Declined, with their closing days. A multi-day event marks each of
 * its days that fall in the month, so an event that runs across a month's end
 * shows in both months.
 */
export function marksForMonth({ year, monthIndex }, { events, saved, talks }) {
  const first = `${year}-${pad(monthIndex + 1)}-01`;
  const last = dayFromUtc(new Date(Date.UTC(year, monthIndex + 1, 0)));
  const marks = new Map();
  const month = { first, last };
  markEventDays(marks, knownEvents(events, saved), month);
  markTalks(marks, committedTalks(talks), month);
  markDeadlines(marks, events, month);
  markClashes(marks);
  return marks;
}

/** The marks of one day, made empty the first time it is asked for. */
function markAt(marks, day) {
  if (!marks.has(day))
    marks.set(day, { events: [], unmarked: [], talks: [], deadlines: [], overlap: false });
  return marks.get(day);
}

// Each day of each live event that falls in the month.
function markEventDays(marks, known, { first, last }) {
  for (const event of known) {
    if (!isLiveEvent(event)) continue;
    const planned = isPlanned(event.status);
    const from = event.range.start < first ? first : event.range.start;
    const to = event.range.end > last ? last : event.range.end;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const entry = {
        id: event.id,
        title: event.title,
        status: event.status,
        listed: event.listed,
      };
      if (planned) markAt(marks, day).events.push(entry);
      else markAt(marks, day).unmarked.push(entry);
    }
  }
}

function markTalks(marks, committed, { first, last }) {
  for (const talk of committed) {
    if (talk.day >= first && talk.day <= last)
      markAt(marks, talk.day).talks.push({ name: talk.name, statusLabel: talk.statusLabel });
  }
}

function markDeadlines(marks, events, { first, last }) {
  for (const event of events ?? []) {
    if (closesWithin(event, first, last))
      markAt(marks, event.callCloses).deadlines.push({ title: event.title });
  }
}

// A clash day needs two things the owner cares about: two planned events,
// or one of the owner's talks and a planned event that is not that same
// event. `mark.events` holds only planned events; an event with no status
// (`mark.unmarked`) never makes a clash, however many share the day.
function markClashes(marks) {
  for (const mark of marks.values()) {
    const talkMeetsPlanned = mark.talks.some((talk) =>
      mark.events.some((event) => normalizeName(event.title) !== normalizeName(talk.name))
    );
    mark.overlap = talkMeetsPlanned || mark.events.length > 1;
  }
}

/** The month the calendar opens on: the first listed event still to come, else this month. */
export function firstMonth(events, today) {
  const upcoming = (events ?? [])
    .filter((event) => !isOffCalendar(event) && isDay(event.startDate) && event.startDate >= today)
    .map((event) => event.startDate)
    .sort();
  return monthOf(upcoming[0] ?? today);
}
