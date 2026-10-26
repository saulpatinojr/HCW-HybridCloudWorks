/**
 * Calendar Alerts — the browser's side of the owner's dated alerts.
 *
 * The server (functions/src/lib/calendar-alerts) keeps the alerts and works
 * out where each one stands for the site's UTC day: every alert it answers
 * carries `state` (open, snoozed or done) and `daysUntilDue`, and the answer
 * carries `today`. This file only decides what to SHOW from that: which
 * alerts the sign-in pop-up lists, how a due date reads, which link is safe
 * to open, and whether the pop-up has already been shown today.
 *
 * It is admin-only. Nothing outside the admin portal imports it, and
 * calendarAlerts.public.test.js holds that.
 */
import { getJSON, sendJSON } from '@/lib/api';

export { safeAlertLink } from './calendarAlertsLink';

export const CALENDAR_ALERTS_ROUTE = 'cms/calendar-alerts';

/** The pop-up lists open alerts due within this many days, and every overdue one. */
export const DUE_SOON_DAYS = 7;

/** The snooze buttons: the days the server is asked for, and the words on the button. */
export const SNOOZE_CHOICES = Object.freeze([
  Object.freeze({ days: 1, label: '1 day', long: 'for 1 day' }),
  Object.freeze({ days: 3, label: '3 days', long: 'for 3 days' }),
  Object.freeze({ days: 7, label: 'Next week', long: 'until next week' }),
]);

export const FILTERS = Object.freeze([
  { id: 'open', label: 'Open' },
  { id: 'due-soon', label: 'Due soon' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
]);

// ── The API ──────────────────────────────────────────────────────────────────

/**
 * Every alert, soonest first, with the server's UTC `today`. Throws when the
 * answer is not the shape the server sends, so a proxy's error page cannot
 * read as "no alerts".
 *
 * @returns {Promise<{ today: string, alerts: object[] }>}
 */
export async function fetchCalendarAlerts() {
  const body = await getJSON(CALENDAR_ALERTS_ROUTE);
  if (!body || !Array.isArray(body.alerts) || typeof body.today !== 'string') {
    throw new Error('The calendar alerts answer was not in the expected shape.');
  }
  return { today: body.today, alerts: body.alerts };
}

const alertOf = (body) => {
  if (!body?.alert || typeof body.alert.id !== 'string') {
    throw new Error('The calendar alerts answer was not in the expected shape.');
  }
  return body.alert;
};

/** @returns {Promise<object>} the alert as saved */
export const createCalendarAlert = async (fields) =>
  alertOf(await sendJSON(CALENDAR_ALERTS_ROUTE, 'POST', fields));

/** @returns {Promise<object>} the alert as saved */
export const updateCalendarAlert = async (id, changes) =>
  alertOf(await sendJSON(`${CALENDAR_ALERTS_ROUTE}/${encodeURIComponent(id)}`, 'PATCH', changes));

export const deleteCalendarAlert = (id) =>
  sendJSON(`${CALENDAR_ALERTS_ROUTE}/${encodeURIComponent(id)}`, 'DELETE');

// ── Telling the other screens ────────────────────────────────────────────────

const alertsChanged = new EventTarget();

/**
 * Say that an alert was changed (created, edited, finished, snoozed, deleted)
 * by the screen `source`. The pop-up in the admin layout and the Calendar
 * page each hold their own copy of the list; this is how a change made in one
 * reaches the other.
 */
export function announceAlertsChanged(source) {
  alertsChanged.dispatchEvent(new CustomEvent('changed', { detail: source }));
}

/** Listen for changes made by any screen; returns the function that stops listening. */
export function onAlertsChanged(listener) {
  const handler = (event) => listener(event.detail);
  alertsChanged.addEventListener('changed', handler);
  return () => alertsChanged.removeEventListener('changed', handler);
}

// ── What to show ─────────────────────────────────────────────────────────────

/** Soonest day first, then time (an alert with no time first), then title. */
export function compareAlerts(a, b) {
  return (
    String(a.dueDate).localeCompare(String(b.dueDate)) ||
    String(a.dueTime ?? '').localeCompare(String(b.dueTime ?? '')) ||
    String(a.title).localeCompare(String(b.title))
  );
}

/** Whether an alert is open and due within `days` days, or overdue. */
export function isDueSoon(alert, days = DUE_SOON_DAYS) {
  return (
    alert.state === 'open' && Number.isFinite(alert.daysUntilDue) && alert.daysUntilDue <= days
  );
}

/** What the sign-in pop-up lists: open alerts due soon or overdue, soonest first. */
export const selectPromptAlerts = (alerts) =>
  alerts.filter((alert) => isDueSoon(alert)).sort(compareAlerts);

/** One filter of the page's list. Unknown ids show everything. */
export function filterAlerts(alerts, filter) {
  switch (filter) {
    case 'open':
      return alerts.filter((alert) => alert.state === 'open');
    case 'due-soon':
      return alerts.filter((alert) => isDueSoon(alert));
    case 'snoozed':
      return alerts.filter((alert) => alert.state === 'snoozed');
    case 'done':
      return alerts.filter((alert) => alert.state === 'done');
    default:
      return alerts;
  }
}

/** How many alerts each filter would show, for its label. */
export const countByFilter = (alerts) =>
  Object.fromEntries(FILTERS.map(({ id }) => [id, filterAlerts(alerts, id).length]));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A `YYYY-MM-DD` as "Fri, 30 Oct 2026", on the UTC day it names in every time zone. */
export function formatDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(day ?? '');
  // Built from the parts, because the punctuation of a locale-formatted date
  // (the comma after the weekday) is the runtime's to decide.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
}

/**
 * Where an alert stands, in words: `{ text, tone }`. `tone` is one of
 * overdue, today, soon, later, snoozed or done; the page colours by it and
 * always prints the words too, so colour is never the only signal.
 */
export function describeDue(alert) {
  if (alert.state === 'done') return { text: 'Done', tone: 'done' };
  if (alert.state === 'snoozed') {
    return { text: `Snoozed until ${formatDay(alert.snoozedUntil)}`, tone: 'snoozed' };
  }
  const days = alert.daysUntilDue;
  if (!Number.isFinite(days)) return { text: 'No date', tone: 'later' };
  if (days < 0) return { text: `${plural(-days, 'day')} overdue`, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', tone: 'today' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  return { text: `Due in ${plural(days, 'day')}`, tone: days <= DUE_SOON_DAYS ? 'soon' : 'later' };
}

/**
 * A Calendar item of kind `alert` (functions/src/lib/calendar-alerts/
 * collector.js) as the alert shape the alert screens draw. The Calendar read
 * carries the alert's state today as the item's status; the days left are
 * counted here from the UTC day, as the server counts them.
 */
export function alertFromCalendarItem(item, now = new Date()) {
  const dueDate = String(item.start).slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const days = Math.round(
    (Date.parse(`${dueDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000
  );
  return {
    id: item.sourceId,
    title: item.title,
    dueDate,
    dueTime: item.meta?.dueTime ?? null,
    link: item.meta?.link ?? '',
    note: item.meta?.note ?? '',
    status: item.status,
    state: item.status,
    snoozedUntil: item.meta?.snoozedUntil ?? null,
    daysUntilDue: Number.isFinite(days) ? days : null,
  };
}

/** "Fri, 30 Oct 2026" or "Fri, 30 Oct 2026, 14:30 UTC". */
export const describeWhen = (alert) =>
  alert.dueTime ? `${formatDay(alert.dueDate)}, ${alert.dueTime} UTC` : formatDay(alert.dueDate);

// ── Once a session, once a day ───────────────────────────────────────────────

export const PROMPT_SESSION_KEY = 'hcw-calendar-alerts-shown-this-session';
export const PROMPT_DAY_KEY = 'hcw-calendar-alerts-last-shown-day';

/** The fallback when the browser will not let this page store anything. */
let shownInThisPageLoad = false;

/** Run a storage call, answering `fallback` when the browser refuses it (private windows, blocked storage). */
function withStorage(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Whether the sign-in pop-up may open now: not yet in this browser session,
 * and not yet on this UTC day (`today`, from the server). Storage that is
 * blocked costs only the "no more than once" memory: it falls back to once
 * per page load, so a blocked browser is never nagged on every navigation.
 */
export function shouldShowPrompt(today) {
  if (shownInThisPageLoad) return false;
  const thisSession = withStorage(() => window.sessionStorage.getItem(PROMPT_SESSION_KEY), null);
  if (thisSession) return false;
  const lastDay = withStorage(() => window.localStorage.getItem(PROMPT_DAY_KEY), null);
  return lastDay !== today;
}

/** Remember that the pop-up was shown: for this session, and for this day. */
export function markPromptShown(today) {
  shownInThisPageLoad = true;
  withStorage(() => window.sessionStorage.setItem(PROMPT_SESSION_KEY, '1'), null);
  withStorage(() => window.localStorage.setItem(PROMPT_DAY_KEY, today), null);
}

/** Forget only what the page itself remembers, as a reload does and no more. For tests. */
export function simulatePageReload() {
  shownInThisPageLoad = false;
}

/** Forget everything that was shown, the browser's storage too. For tests. */
export function resetPromptMemory() {
  shownInThisPageLoad = false;
  withStorage(() => window.sessionStorage.removeItem(PROMPT_SESSION_KEY), null);
  withStorage(() => window.localStorage.removeItem(PROMPT_DAY_KEY), null);
}
