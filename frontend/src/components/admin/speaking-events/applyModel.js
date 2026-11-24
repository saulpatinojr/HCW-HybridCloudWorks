/**
 * The pure rules of the Speaking hub's "Events to apply to" tab (#1823,
 * ADR 0045): days and ranges, which events overlap what the owner already has,
 * what the small calendar marks on each day, and the sums the rows show.
 * Nothing here reads the network or the clock by itself; every function is
 * given what it needs, so the tests can pin each rule.
 *
 * DAYS ARE CALENDAR DAYS, COMPARED AS WRITTEN. An event's dates come from the
 * outside API in the event's own local time, and the server keeps only the
 * day (`YYYY-MM-DD`). The owner's own speaking events are stored the same
 * way. This file never turns a day into an instant in some time zone: two
 * days are compared as the text they are (`'2027-03-06' < '2027-03-07'`),
 * which is correct for that form and cannot shift a day across midnight.
 * Day arithmetic (the calendar grid, "days left") is done in UTC for the same
 * reason. The one place the reader's clock is used is "today", for the days
 * left before a call closes; an event on the other side of the world may
 * therefore be a day out, and the page says "about".
 *
 * WHAT COUNTS AS A CLASH (the rule the calendar and the rows share). A clash
 * needs TWO things the owner cares about on the same day. The directory lists
 * hundreds of events around the world, so "some listed event is on that day"
 * is true of almost every day and says nothing. The things that count are:
 *
 *   - one of the owner's own talks that is sent or accepted (Speaking hub
 *     status Proposed or Accepted). The hub stores one day per talk.
 *   - an event from this tab that the owner marked Interested, Applied or
 *     Accepted ("planned" below).
 *
 * So a planned event clashes with a talk whose day falls on or between its
 * first and last day, and with another planned event when the two ranges
 * share at least one day. A calendar day is a clash day when two planned
 * events are on it, or a talk and a planned event. Two of the owner's own
 * talks on one day are not marked here: they are the Upcoming tab's business,
 * and this tab only knows one day per talk.
 *
 * WHAT IS QUIET.
 *
 *   - An event with no status yet never makes a clash. Its row still says, in
 *     plain grey words, what its dates would meet, because that is useful
 *     when deciding whether to apply; and it shows on the calendar as a small
 *     faint mark, apart from the planned ones.
 *   - An event marked Not going or Declined makes no clash, says nothing on
 *     its row, and is left off the calendar, with its closing day.
 *   - A cancelled or postponed event is the same: its dates no longer say
 *     when anything happens.
 *
 * When one of the owner's talks IS the listed event (the same name), that is
 * "you are already speaking here", not a clash.
 */
import { normalizeName, speakingStatusInfo, toInputDate } from '@/lib/speakingEvents';
import { manualRowStatus, safeString, sessionizeRowStatus } from './eventModel';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The owner's choices for an event on this tab, as the badge shows them. */
export const APPLY_STATUS_INFO = Object.freeze({
  '': { id: '', label: 'Not decided', tone: 'muted', help: 'Nothing recorded for this event yet.' },
  interested: {
    id: 'interested',
    label: 'Interested',
    tone: 'muted',
    help: 'Worth a look; nothing sent.',
  },
  applied: {
    id: 'applied',
    label: 'Applied',
    tone: 'warn',
    help: 'A proposal was sent; waiting on the organizers.',
  },
  accepted: { id: 'accepted', label: 'Accepted', tone: 'ok', help: 'The organizers said yes.' },
  declined: { id: 'declined', label: 'Declined', tone: 'bad', help: 'Not selected this time.' },
  not_going: {
    id: 'not_going',
    label: 'Not going',
    tone: 'off',
    help: 'Decided against this one.',
  },
});
export const APPLY_STATUSES = Object.freeze(Object.keys(APPLY_STATUS_INFO));
export const applyStatusInfo = (status) => APPLY_STATUS_INFO[status] ?? APPLY_STATUS_INFO[''];

/** The statuses that put an event in the owner's plans: a maybe, a proposal out, or a yes. */
const PLANNED_APPLY = new Set(['interested', 'applied', 'accepted']);
/** The statuses that take an event out of them: decided against, or turned down. */
const DROPPED_APPLY = new Set(['not_going', 'declined']);
/** Whether the owner marked an event Interested, Applied or Accepted. */
export const isPlanned = (status) => PLANNED_APPLY.has(status);
/** Whether the owner marked an event Not going or Declined. */
export const isDropped = (status) => DROPPED_APPLY.has(status);
const COMMITTED_TALK = new Set(['proposed', 'accepted']);

export const COST_FIELDS = Object.freeze([
  { id: 'travel', label: 'Travel' },
  { id: 'lodging', label: 'Lodging' },
  { id: 'other', label: 'Ticket and other' },
]);

/** True for a real `YYYY-MM-DD`. */
export function isDay(value) {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

const pad = (n) => String(n).padStart(2, '0');
const dayFromUtc = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const utcOf = (day) => {
  const [, year, month, date] = DAY.exec(day).map(Number);
  return Date.UTC(year, month - 1, date);
};

/** The reader's own calendar day, as `YYYY-MM-DD`. */
export function todayDay(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `day` moved by `count` days (negative moves back). */
export function addDays(day, count) {
  return dayFromUtc(new Date(utcOf(day) + count * DAY_MS));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. Null when either is not a day. */
export function daysBetween(from, to) {
  if (!isDay(from) || !isDay(to)) return null;
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

/**
 * An event's first and last day, or null when it has no usable start. A
 * missing end, or one before the start, makes a one-day range.
 */
export function eventRange(event) {
  if (!isDay(event?.startDate)) return null;
  const end =
    isDay(event.endDate) && event.endDate >= event.startDate ? event.endDate : event.startDate;
  return { start: event.startDate, end };
}

/** Whether two ranges share at least one day. Touching on the same day counts. */
export function rangesOverlap(a, b) {
  return Boolean(a && b) && a.start <= b.end && b.start <= a.end;
}

/** Whether a cancelled or postponed event: its dates no longer hold. */
export const isOffCalendar = (event) => event?.cancelled === true || event?.postponed === true;

/**
 * The owner's own talks that hold a day, from the hub's merged rows
 * (Sessionize events with their stored override, and manual entries).
 *
 * @param {{ mergedEvents?: object[], manualEntries?: object[] }} rows
 * @param {Date} [now]
 * @returns {Array<{ key: string, name: string, day: string, status: string, statusLabel: string, cfpDeadline: string|null }>}
 */
export function ownTalks(rows, now = new Date()) {
  const talks = [
    ...(rows?.mergedEvents ?? []).map((event) => talkFromSessionize(event, now)),
    ...(rows?.manualEntries ?? []).map((entry) => talkFromStored(entry, now)),
  ];
  return talks.map((talk) => ({ ...talk, statusLabel: speakingStatusInfo(talk.status).label }));
}

/** A stored value as a real calendar day, or null. */
const dayOrNull = (value) => {
  const day = toInputDate(value);
  return isDay(day) ? day : null;
};

/** A Sessionize event with its stored override, as a talk. */
function talkFromSessionize(event, now) {
  const stored = event._storedDoc ?? {};
  return {
    key: `sessionize-${event.id}`,
    name: event.name || stored.eventName || 'Untitled event',
    day: dayOrNull(stored.date || event.date),
    status: sessionizeRowStatus(event, now),
    cfpDeadline: dayOrNull(stored.cfpDeadline),
    location: safeString(stored.location) || safeString(event.location) || '',
  };
}

/** A manual (stored-only) entry, as a talk. */
function talkFromStored(entry, now) {
  return {
    key: `stored-${entry._docId ?? entry.id}`,
    name: entry.eventName || entry.name || 'Untitled event',
    day: dayOrNull(entry.date),
    status: manualRowStatus(entry, now),
    cfpDeadline: dayOrNull(entry.cfpDeadline),
    location: safeString(entry.location) || '',
  };
}

/** The talks that hold the owner's calendar: sent or accepted, with a day. */
export const committedTalks = (talks) =>
  talks.filter((talk) => talk.day && COMMITTED_TALK.has(talk.status));

/**
 * Every event this tab knows with what the owner saved for it, as one list:
 * the listed ones, then the saved ones that are no longer listed (their call
 * closed). Each is `{ id, title, range, status, listed, offCalendar }`.
 */
export function knownEvents(events, saved) {
  const known = [];
  for (const event of events ?? []) {
    known.push({
      id: event.id,
      title: event.title,
      range: eventRange(event),
      status: event.note?.status ?? '',
      listed: true,
      offCalendar: isOffCalendar(event),
    });
  }
  for (const note of saved ?? []) {
    known.push({
      id: note.eventId,
      title: note.event?.title ?? 'Saved event',
      range: eventRange(note.event),
      status: note.status ?? '',
      listed: false,
      offCalendar: false,
    });
  }
  return known;
}

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
  if (!event?.range || event.offCalendar || isDropped(event.status)) return result;
  const meets = [];
  const ownName = normalizeName(event.title);
  for (const talk of committedTalks(talks)) {
    if (talk.day < event.range.start || talk.day > event.range.end) continue;
    if (ownName && normalizeName(talk.name) === ownName) {
      result.speakingHere = talk.statusLabel;
    } else {
      meets.push({
        kind: 'talk',
        name: talk.name,
        detail: `${talk.statusLabel} talk on ${formatDay(talk.day)}`,
      });
    }
  }
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
  if (isPlanned(event.status)) result.clashes = meets;
  else result.wouldMeet = meets;
  return result;
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
  isDay(event.callCloses) &&
  event.callCloses >= first &&
  event.callCloses <= last &&
  !event.cancelled &&
  !isDropped(event.note?.status);

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
  const at = (day) => {
    if (!marks.has(day))
      marks.set(day, { events: [], unmarked: [], talks: [], deadlines: [], overlap: false });
    return marks.get(day);
  };
  const known = knownEvents(events, saved);
  const committed = committedTalks(talks);

  for (const event of known) {
    if (!event.range || event.offCalendar || isDropped(event.status)) continue;
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
      if (planned) at(day).events.push(entry);
      else at(day).unmarked.push(entry);
    }
  }
  for (const talk of committed) {
    if (talk.day >= first && talk.day <= last)
      at(talk.day).talks.push({ name: talk.name, statusLabel: talk.statusLabel });
  }
  for (const event of events ?? []) {
    if (closesWithin(event, first, last))
      at(event.callCloses).deadlines.push({ title: event.title });
  }

  // A clash day needs two things the owner cares about: two planned events,
  // or one of the owner's talks and a planned event that is not that same
  // event. `mark.events` holds only planned events; an event with no status
  // (`mark.unmarked`) never makes a clash, however many share the day.
  for (const mark of marks.values()) {
    const talkMeetsPlanned = mark.talks.some((talk) =>
      mark.events.some((event) => normalizeName(event.title) !== normalizeName(talk.name))
    );
    mark.overlap = talkMeetsPlanned || mark.events.length > 1;
  }
  return marks;
}

/** The month the calendar opens on: the first listed event still to come, else this month. */
export function firstMonth(events, today) {
  const upcoming = (events ?? [])
    .filter((event) => !isOffCalendar(event) && isDay(event.startDate) && event.startDate >= today)
    .map((event) => event.startDate)
    .sort();
  return monthOf(upcoming[0] ?? today);
}

/** `Mar 6, 2027`, or a dash for no day. */
export function formatDay(day) {
  if (!isDay(day)) return '—';
  const [, year, month, date] = DAY.exec(day).map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

/** `Mar 6, 2027`, `Mar 6–7, 2027`, `Mar 31 – Apr 2, 2027` or `Dec 31, 2026 – Jan 2, 2027`. */
export function formatRange(range) {
  if (!range) return '—';
  if (range.start === range.end) return formatDay(range.start);
  const [, startYear, startMonth, startDate] = DAY.exec(range.start).map(Number);
  const [, endYear, endMonth, endDate] = DAY.exec(range.end).map(Number);
  if (startYear !== endYear) return `${formatDay(range.start)} – ${formatDay(range.end)}`;
  if (startMonth !== endMonth) {
    return `${MONTHS[startMonth - 1]} ${startDate} – ${MONTHS[endMonth - 1]} ${endDate}, ${endYear}`;
  }
  return `${MONTHS[startMonth - 1]} ${startDate}–${endDate}, ${endYear}`;
}

/**
 * How long until a call for speakers closes, in words. `tone` is `bad` once
 * it has closed, `warn` inside a week, else `muted`.
 */
export function callCloseInfo(callCloses, today) {
  const left = daysBetween(today, callCloses);
  if (left === null) return { label: 'No closing date given', tone: 'muted', left: null };
  if (left < 0) return { label: `Closed ${formatDay(callCloses)}`, tone: 'bad', left };
  if (left === 0) return { label: `Closes today (${formatDay(callCloses)})`, tone: 'warn', left };
  const about = `about ${left} day${left === 1 ? '' : 's'} left`;
  return {
    label: `Closes ${formatDay(callCloses)}, ${about}`,
    tone: left <= 7 ? 'warn' : 'muted',
    left,
  };
}

/** City, region and country on one line, with the kind of event in brackets. */
export function locationLine(event) {
  const place = [event?.city, event?.region, event?.country].filter(Boolean).join(', ');
  const kind = event?.eventType ? `(${event.eventType})` : '';
  return [place || (event?.eventType ? '' : 'Place not given'), kind].filter(Boolean).join(' ');
}

/** What it costs to attend, from the API's tiers. */
export function attendanceCost(costTiers) {
  return Array.isArray(costTiers) && costTiers.length > 0 ? costTiers.join(', ') : 'Not given';
}

/** A cost box's text as a number of 0 or more, or null for empty or not a number. */
export function parseCost(value) {
  if (value === '' || value === null || value === undefined) return null;
  const amount = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

/** The sum of the cost boxes that hold a number; null when none does. No currency: the owner's own unit. */
export function costTotal(costs) {
  const amounts = COST_FIELDS.map(({ id }) => parseCost(costs?.[id])).filter(
    (amount) => amount !== null
  );
  if (amounts.length === 0) return null;
  return Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
}

/** The form for one event's note: text boxes, so an empty cost stays empty. */
export function noteForm(note) {
  const costs = {};
  for (const { id } of COST_FIELDS) {
    const amount = note?.costs?.[id];
    costs[id] = typeof amount === 'number' ? String(amount) : '';
  }
  return { status: note?.status ?? '', notes: note?.notes ?? '', costs };
}

/** What a save sends for a form; `invalid` names the first cost box that is not a number. */
export function notePayload(form) {
  const costs = {};
  for (const { id, label } of COST_FIELDS) {
    const raw = String(form.costs?.[id] ?? '').trim();
    const amount = parseCost(raw);
    if (raw !== '' && amount === null)
      return { invalid: `${label} must be a number of 0 or more, or empty.` };
    costs[id] = amount;
  }
  return { payload: { status: form.status || '', notes: form.notes ?? '', costs } };
}

/** The listed events a search box and a status filter keep. */
export function filterEvents(events, { search = '', status = 'all' } = {}) {
  const query = search.trim().toLowerCase();
  return (events ?? []).filter((event) => {
    const own = event.note?.status ?? '';
    if (status === 'open' && (own === 'not_going' || own === 'declined')) return false;
    if (status !== 'all' && status !== 'open' && own !== status) return false;
    if (!query) return true;
    return [event.title, event.tagline, event.city, event.region, event.country, event.eventType]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}
