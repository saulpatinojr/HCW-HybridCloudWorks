/**
 * calendar-alerts/model.js — the owner's calendar alerts: what one looks like,
 * how a request is checked into one, and when one is due to be shown.
 *
 * Owner request 2026-10-26: "Calendar Alerts when I log into the Admin
 * portal". A calendar alert is a dated note to the owner (a title, a day, an
 * optional time, an optional link and a short note) that the admin portal
 * puts in a pop-up on sign-in once it is due within a week. It is separate
 * from the reminders sheet on purpose: the sheet (reminders/settings.js) is
 * said on Telegram by a daily timer and its rows carry that timer's stamps,
 * while an alert is only ever shown in the portal and can be snoozed.
 * Everything about dates here reuses the sheet's calendar
 * (reminders/calendar.js), so both read "today" as the UTC day.
 *
 * How a request body is checked field by field is in fields.js, and the
 * errors a check throws are in errors.js; this file re-exports both.
 *
 * PRIVATE. The alerts live in one `admin_config` document (store.js) that no
 * public route reads. presentAlert names the fields it returns, so a field
 * added to the stored row later is withheld until someone lists it here.
 *
 * Stored row (one entry of the document's `alerts` list):
 *
 *   id            1-64 letters, digits, - or _
 *   title         required, up to MAX_TITLE_LENGTH characters
 *   dueDate       a real UTC day as YYYY-MM-DD
 *   dueTime       HH:MM in UTC, or null when the alert is for the whole day
 *   link          '' or an https URL or an admin route (/admin/...)
 *   note          up to MAX_NOTE_LENGTH characters, may be empty
 *   status        open | snoozed | done
 *   snoozedUntil  the UTC day a snoozed alert comes back, else null
 *   doneAt        ISO instant it was marked done, else null
 *   createdAt, updatedAt
 *
 * A snoozed alert whose day has come is open again without anyone touching
 * the row: `state` in presentAlert is worked out from the clock, `status` is
 * what was last saved.
 */
import { dateOnly, daysUntil, parseDateOnly } from '../reminders/calendar.js';
import { fail } from './errors.js';
import {
  ANY_CONTROL_CHARACTER,
  CONTROL_CHARACTERS,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  TIME_PATTERN,
  isPlainObject,
  normalizeLink,
} from './fields.js';

export { dateOnly, daysUntil };
export { CalendarAlertNotFoundError, CalendarAlertTooLargeError, CalendarAlertValidationError } from './errors.js';
export {
  MAX_LINK_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SNOOZE_DAYS,
  MAX_TITLE_LENGTH,
  parseCreateBody,
  parsePatchBody,
} from './fields.js';

export const CALENDAR_ALERTS_DOC_ID = 'calendar_alerts';
export const CALENDAR_ALERTS_DOC_TYPE = 'calendar_alerts';

/** Rows one document may hold. A year of daily alerts fits; the page says what to do when full. */
export const MAX_ALERTS = 300;
/** The pop-up lists open alerts due within this many days, and every overdue one. */
export const DUE_SOON_DAYS = 7;
export const STATUSES = Object.freeze(['open', 'snoozed', 'done']);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The most the whole list may weigh when it is written back, in characters of
 * JSON. A Cosmos item is capped near 2 MB; the row caps alone allow a list of
 * non-ASCII text to come close, and a write past the cap fails as an opaque
 * 500. This stops a save a little short of it, with a sentence that says what
 * to do, and a delete (which shrinks the list) is never refused by it.
 */
export const MAX_LIST_CHARACTERS = 1_200_000;

/** Refuse a state too heavy to be stored. @throws {CalendarAlertValidationError} */
export function assertListWeight(state) {
  if (JSON.stringify(state).length > MAX_LIST_CHARACTERS) {
    fail('The alerts are too large to save any more. Delete some finished ones first.');
  }
}

/**
 * Refuse one more alert: the list is at its row cap, or is too heavy to take
 * more. `state` is the list before the new row is added.
 *
 * @throws {CalendarAlertValidationError}
 */
export function assertRoomFor(state) {
  if (state.alerts.length >= MAX_ALERTS) {
    fail(`There are already ${MAX_ALERTS} alerts. Delete some finished ones first.`);
  }
  assertListWeight(state);
}

/** Whether `id` can be an alert's id (and so a path segment). */
export const isAlertId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

/** A new open alert from a checked create body. */
export function newAlert(fields, { id, at }) {
  return {
    id,
    title: fields.title,
    dueDate: fields.dueDate,
    dueTime: fields.dueTime ?? null,
    link: fields.link ?? '',
    note: fields.note ?? '',
    status: 'open',
    snoozedUntil: null,
    doneAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The UTC day `days` after `today`. */
function addDays(today, days) {
  return dateOnly(parseDateOnly(today) + days * 24 * 60 * 60 * 1000);
}

/**
 * The stored row with a checked patch applied. Pure: `today` (a UTC day) and
 * `at` (an ISO instant) come from the caller's clock.
 *
 * @throws {CalendarAlertValidationError} when asked to snooze a finished alert
 */
export function applyPatch(row, patch, { today, at }) {
  const next = { ...row, ...patch.edits, updatedAt: at };
  if (patch.done === true) {
    next.status = 'done';
    next.doneAt = at;
    next.snoozedUntil = null;
  } else if (patch.done === false) {
    next.status = 'open';
    next.doneAt = null;
    next.snoozedUntil = null;
  }
  if (patch.snoozeDays === 0 && patch.done === true) {
    // "Finish it and clear any snooze": finishing already cleared it, and the
    // alert must stay done, not be opened again by the zero.
  } else if (patch.snoozeDays !== undefined) {
    if (next.status === 'done') fail('A finished alert cannot be snoozed; reopen it first');
    if (patch.snoozeDays === 0) {
      next.status = 'open';
      next.snoozedUntil = null;
    } else {
      next.status = 'snoozed';
      next.snoozedUntil = addDays(today, patch.snoozeDays);
    }
  }
  return next;
}

/** Whether a stored entry has the shape every other function here relies on. */
export function isStoredAlert(row) {
  return isPlainObject(row) && isAlertId(row.id) && hasAlertFields(row);
}

/** A title, a due date and a known status. */
function hasAlertFields(row) {
  return (
    typeof row.title === 'string' &&
    row.title !== '' &&
    parseDateOnly(row.dueDate) !== null &&
    STATUSES.includes(row.status)
  );
}

/**
 * Where an alert stands today: done; snoozed while its snooze day has not
 * come; otherwise open. A snooze that has run out reads as open without the
 * row being rewritten.
 */
export function alertState(row, today) {
  if (row.status === 'done') return 'done';
  if (row.status === 'snoozed' && parseDateOnly(row.snoozedUntil) !== null && row.snoozedUntil > today) {
    return 'snoozed';
  }
  return 'open';
}

/**
 * A stored link as it may be sent on: the same check a typed one passes, so a
 * row edited by hand in the database cannot hand the portal (or the .ics file
 * built from it) an address the form would have refused.
 */
function storedLink(value) {
  try {
    return normalizeLink(value);
  } catch {
    return '';
  }
}

/**
 * One stored row as the portal receives it: the fields named here, and
 * nothing else, plus `state` and `daysUntilDue` worked out for `today`. Each
 * is checked again on the way out (a time, a link, a snooze day, the control
 * characters in the words), because the stored row is a document that can be
 * edited by hand.
 */
export function presentAlert(row, today) {
  return {
    id: row.id,
    title: row.title.slice(0, MAX_TITLE_LENGTH).replace(new RegExp(ANY_CONTROL_CHARACTER, 'g'), ' '),
    dueDate: row.dueDate,
    dueTime: TIME_PATTERN.test(row.dueTime) ? row.dueTime : null,
    link: storedLink(row.link),
    note:
      typeof row.note === 'string'
        ? row.note.slice(0, MAX_NOTE_LENGTH).replace(new RegExp(CONTROL_CHARACTERS, 'g'), ' ')
        : '',
    status: row.status,
    snoozedUntil: parseDateOnly(row.snoozedUntil) === null ? null : row.snoozedUntil,
    doneAt: typeof row.doneAt === 'string' ? row.doneAt : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    state: alertState(row, today),
    daysUntilDue: daysUntil(row.dueDate, today),
  };
}

/** Earliest day first, then earliest time (no time first), then oldest, then by id. */
export function compareAlerts(a, b) {
  return (
    String(a.dueDate).localeCompare(String(b.dueDate)) ||
    String(a.dueTime ?? '').localeCompare(String(b.dueTime ?? '')) ||
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/**
 * The alerts that exist from the first deploy, without anyone typing them.
 * Each has a fixed id; applySeeds creates it once and never again.
 *
 * THESE ARE PUBLIC. This file is in a public repository and the runbook
 * quotes the first one, so a seed carries nothing private: a title, a due
 * day and links to public pages. A private alert is typed in the portal.
 */
export const SEED_ALERTS = Object.freeze([
  Object.freeze({
    id: 'docker-dsos-application',
    title: 'Submit the Docker-Sponsored Open Source application',
    dueDate: '2026-10-30',
    dueTime: null,
    link: 'https://www.docker.com/community/open-source/application/',
    note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
  }),
]);

const SEED_IDS = new Set(SEED_ALERTS.map((seed) => seed.id));

/** Whether `id` is one of the alerts the code creates by itself. */
export const isSeedId = (id) => SEED_IDS.has(id);

/** The document's contents as `{ alerts, seeded }`, tolerant of a missing or malformed document. */
export function readState(doc) {
  return {
    alerts: Array.isArray(doc?.alerts) ? doc.alerts : [],
    seeded: Array.isArray(doc?.seeded)
      ? doc.seeded.filter((id) => typeof id === 'string')
      : [],
  };
}

/**
 * Create each seed that has never been created: not in `seeded` (the record
 * of every seed this document has ever made) and not already a row. A seed
 * the owner marked done is still a row, and one the owner deleted is still in
 * `seeded`, so neither comes back. Pure.
 *
 * @returns {{ state: { alerts: object[], seeded: string[] }, changed: boolean }}
 */
export function applySeeds(state, { at }) {
  const alerts = [...state.alerts];
  const seeded = [...state.seeded];
  let changed = false;
  for (const seed of SEED_ALERTS) {
    if (seeded.includes(seed.id)) continue;
    if (!alerts.some((row) => row?.id === seed.id)) {
      alerts.push(newAlert(seed, { id: seed.id, at }));
    }
    seeded.push(seed.id);
    changed = true;
  }
  return { state: { alerts, seeded }, changed };
}

/**
 * The state with one alert removed. A seed's id is recorded in `seeded` in
 * the same step, so removing it can never let applySeeds make it again.
 */
export function withoutAlert(state, id) {
  const alerts = state.alerts.filter((row) => row?.id !== id);
  const seeded = isSeedId(id) && !state.seeded.includes(id) ? [...state.seeded, id] : state.seeded;
  return { alerts, seeded };
}
