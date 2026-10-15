/**
 * The Calendar's pure rules (ADR 0033 §4, Amplify slice): what each kind
 * looks like, which window a view needs, how items fall on local days, and
 * when two of them collide. No React and no fetch, so the page can be read
 * for what it renders and these for what they decide.
 *
 * Every date here is LOCAL to the viewer: the API answers UTC instants and
 * the grid places them on the viewer's day, with the time zone named on the
 * toolbar so a reader in another zone knows what they are looking at.
 */
import {
  Award,
  BadgeCheck,
  CalendarDays,
  FileText,
  Headphones,
  Mail,
  Mic2,
  Share2,
} from 'lucide-react';

export const VIEWS = Object.freeze(['month', 'week', 'agenda']);

/**
 * Each kind: its word, its icon and its colours. Colour is never the only
 * signal — the icon and the label travel with it on every chip and legend.
 */
export const KIND_META = Object.freeze({
  content: {
    label: 'Content',
    Icon: FileText,
    chip: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
    dot: 'bg-sky-500',
  },
  newsletter: {
    label: 'Newsletter',
    Icon: Mail,
    chip: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200',
    dot: 'bg-violet-500',
  },
  social: {
    label: 'Social',
    Icon: Share2,
    chip: 'border-pink-300 bg-pink-50 text-pink-900 dark:border-pink-800 dark:bg-pink-950/40 dark:text-pink-200',
    dot: 'bg-pink-500',
  },
  speaking: {
    label: 'Speaking',
    Icon: Mic2,
    chip: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    dot: 'bg-amber-500',
  },
  certification: {
    label: 'Certification',
    Icon: Award,
    chip: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
    dot: 'bg-emerald-500',
  },
  ambassador: {
    label: 'Ambassador',
    Icon: BadgeCheck,
    chip: 'border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200',
    dot: 'bg-indigo-500',
  },
  audio: {
    label: 'Audio',
    Icon: Headphones,
    chip: 'border-teal-300 bg-teal-50 text-teal-900 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200',
    dot: 'bg-teal-500',
  },
});

export const KINDS = Object.freeze(Object.keys(KIND_META));

export const kindMeta = (kind) =>
  KIND_META[kind] || {
    label: kind,
    Icon: CalendarDays,
    chip: 'border-border bg-muted',
    dot: 'bg-slate-400',
  };

/** A calendar item's status as the shared StatusBadge reads it. */
export function itemStatus(item) {
  const status = String(item?.status || '').toLowerCase();
  const table = {
    scheduled: {
      id: 'scheduled',
      label: 'Scheduled',
      tone: 'warn',
      help: 'Will happen at the time shown.',
    },
    published: {
      id: 'published',
      label: 'Published',
      tone: 'ok',
      help: 'Went out; visitors can see it.',
    },
    sent: { id: 'sent', label: 'Sent', tone: 'ok', help: 'Resend delivered this issue.' },
    failed: {
      id: 'failed',
      label: 'Failed',
      tone: 'bad',
      help: 'Did not go out. Open it to retry.',
    },
    sending: {
      id: 'sending',
      label: 'Sending',
      tone: 'warn',
      help: 'Mid-send; check the hub before acting.',
    },
    deadline: {
      id: 'deadline',
      label: 'Deadline',
      tone: 'warn',
      help: 'A date to act by, not a publish.',
    },
    accepted: { id: 'accepted', label: 'Accepted', tone: 'ok', help: 'The talk was accepted.' },
    proposed: {
      id: 'proposed',
      label: 'Proposed',
      tone: 'warn',
      help: 'Submitted, not yet decided.',
    },
    declined: { id: 'declined', label: 'Declined', tone: 'bad', help: 'The talk was declined.' },
    delivered: { id: 'delivered', label: 'Delivered', tone: 'ok', help: 'The talk was given.' },
    idea: { id: 'idea', label: 'Idea', tone: 'muted', help: 'Not yet proposed.' },
    draft: { id: 'draft', label: 'Draft', tone: 'muted', help: 'Not yet released.' },
    hidden: { id: 'hidden', label: 'Hidden', tone: 'off', help: 'Not shown on the public site.' },
  };
  return (
    table[status] || {
      id: status || 'unknown',
      label: status ? status.replace(/_/g, ' ') : 'Unknown',
      tone: 'muted',
      help: '',
    }
  );
}

const pad = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a local Date. */
export const dayKeyOf = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The viewer's local day an item falls on. All-day items are placed on their UTC date, whatever the zone. */
export function itemDayKey(item) {
  if (item.allDay) return String(item.start).slice(0, 10);
  const date = new Date(item.start);
  return Number.isNaN(date.getTime()) ? null : dayKeyOf(date);
}

/** Midnight local of a `YYYY-MM-DD`. */
export function dateOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const addDays = (date, days) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** The first Sunday on or before the month's first day, and the Saturday closing its last week. */
export function monthGridDays(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  const days = [];
  for (let i = 0; i < 42; i += 1) days.push(addDays(start, i));
  // Six rows only when the month needs them.
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  return days.filter((_, index) => index < 35 || days[35] <= last);
}

export function weekDays(cursor) {
  const start = addDays(startOfDay(cursor), -cursor.getDay());
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The [from, to) window the API is asked for, in local time, for the view at `cursor`. */
export function rangeFor(view, cursor) {
  if (view === 'week') {
    const days = weekDays(cursor);
    return { from: days[0], to: addDays(days[6], 1) };
  }
  if (view === 'agenda') {
    const from = startOfDay(cursor);
    return { from, to: addDays(from, 30) };
  }
  const days = monthGridDays(cursor);
  return { from: days[0], to: addDays(days[days.length - 1], 1) };
}

/** Where the cursor goes for the previous or next page of a view. */
export function stepCursor(view, cursor, delta) {
  if (view === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  if (view === 'week') return addDays(cursor, 7 * delta);
  return addDays(cursor, 30 * delta);
}

export function rangeLabel(view, cursor) {
  const long = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
  if (view === 'month') return long.format(cursor);
  const { from, to } = rangeFor(view, cursor);
  const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return `${short.format(from)} – ${short.format(addDays(to, -1))}, ${to.getFullYear()}`;
}

/** Items grouped by local day key, each day's list by start time. */
export function groupByDay(items) {
  const days = new Map();
  for (const item of items || []) {
    const key = itemDayKey(item);
    if (!key) continue;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(item);
  }
  for (const list of days.values()) list.sort(byStart);
  return days;
}

/** All-day items first, then by start. */
function byStart(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return String(a.start).localeCompare(String(b.start));
}

// The toolbar's narrowing and the grid's collision rule live in sibling modules
// (PR #841); re-exported here so the public API of calendarModel is unchanged.
export { applyFilters, channelsOf } from './calendarFilters';
export { SLOT_MS, findConflicts } from './calendarConflicts';

/** True when `day` (local midnight) is before today. */
export const isPastDay = (day, now = new Date()) =>
  startOfDay(day).getTime() < startOfDay(now).getTime();

/** A local day plus `HH:MM` as an instant, or null when the time does not parse. */
export function combineDateTime(day, time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!match) return null;
  const date = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number(match[1]),
    Number(match[2]),
    0,
    0
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `HH:MM` local of an instant, for a time input. */
export function timeInputValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '09:00';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function formatWhen(iso, allDay = false) {
  const date = allDay ? dateOfKey(String(iso).slice(0, 10)) : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
  }).format(date);
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** A content record the Unscheduled panel offers: approved or forge-ready, not live, no schedule. */
export function isUnscheduled(item) {
  const status = String(item?.contentStatus || '');
  if (item?.Live === true || item?.scheduledPublishDate) return false;
  return ['approved', 'forge_ready', 'ready_to_publish', 'approved_blog'].includes(status);
}

/** Content items a schedule may be dragged onto a day: scheduled content, not published, not failed-and-live. */
export const isReschedulable = (item) =>
  item?.kind === 'content' && ['scheduled', 'failed'].includes(item.status);

/** The drag payload type both the panel and the grid agree on. */
export const DRAG_TYPE = 'application/x-contentforge-calendar';

/** The query string Share and Schedule Social carry so the composer preselects the content. */
export const socialComposeHref = (contentId) =>
  `/admin/social-hub?tab=compose${contentId ? `&contentId=${encodeURIComponent(contentId)}` : ''}`;
