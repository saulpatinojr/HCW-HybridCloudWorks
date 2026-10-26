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
import { AuthoredError } from '../http/error-response.js';
import { dateOnly, daysUntil, parseDateOnly } from '../reminders/calendar.js';

export { dateOnly, daysUntil };

export const CALENDAR_ALERTS_DOC_ID = 'calendar_alerts';
export const CALENDAR_ALERTS_DOC_TYPE = 'calendar_alerts';

/** Rows one document may hold. A year of daily alerts fits; the page says what to do when full. */
export const MAX_ALERTS = 300;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 500;
export const MAX_LINK_LENGTH = 2048;
/** Longest snooze a request may ask for; the pop-up offers 1, 3 and 7. */
export const MAX_SNOOZE_DAYS = 30;
/** The pop-up lists open alerts due within this many days, and every overdue one. */
export const DUE_SOON_DAYS = 7;
export const STATUSES = Object.freeze(['open', 'snoozed', 'done']);

const EARLIEST_DUE_DATE = '2000-01-01';
const LATEST_DUE_DATE = '2100-12-31';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADMIN_ROUTE = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?(?:\?[A-Za-z0-9._~%=&-]*)?$/;
/**
 * What a note may not hold: control characters other than the tab and the
 * line break, the C1 controls (U+0080 to U+009F, which include U+0085) and the
 * Unicode line and paragraph separators. Some calendar programs read those as
 * line ends, so one inside a title or note could start a new property in the
 * .ics file the page offers.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
/** The same, and the line break too: a title is one line. */
const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
/** Anything but printable ASCII with no space: an address is percent-encoded, never raw. */
const NOT_ADDRESS_CHARACTER = /[^!-~]/;
/**
 * The OAuth callback acts on its query (code, state), so an alert may not point
 * at it. Matched in any case: the portal's router reads paths case-insensitively,
 * so /OAuth/ reaches the same page as /oauth/.
 */
const OAUTH_SEGMENT = /(^|\/)(oauth|callback)(\/|$)/i;

/** Thrown by a check here; the handler turns it into a 400 (authored, #945). */
export class CalendarAlertValidationError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field */
  constructor(message) {
    super(message, { code: 'INVALID_ALERT', status: 400 });
  }
}

/** Thrown when an id names no alert. */
export class CalendarAlertNotFoundError extends AuthoredError {
  constructor() {
    super('That alert no longer exists. Reload the page to see the current list.', {
      code: 'ALERT_NOT_FOUND',
      status: 404,
    });
  }
}

/** Thrown when a request body is bigger than any alert could need. */
export class CalendarAlertTooLargeError extends AuthoredError {
  constructor() {
    super('The request is too large to be a calendar alert.', { code: 'TOO_LARGE', status: 413 });
  }
}

/**
 * The most the whole list may weigh when it is written back, in characters of
 * JSON. A Cosmos item is capped near 2 MB; the row caps alone allow a list of
 * non-ASCII text to come close, and a write past the cap fails as an opaque
 * 500. This stops a save a little short of it, with a sentence that says what
 * to do, and a delete (which shrinks the list) is never refused by it.
 */
export const MAX_LIST_CHARACTERS = 1_200_000;

const fail = (message) => {
  throw new CalendarAlertValidationError(message);
};

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

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(
      `Unknown field(s) in ${where}: ${unknown.map((key) => key.slice(0, 40)).join(', ')}. Allowed: ${allowed.join(', ')}`
    );
  }
}

/** Whether `id` can be an alert's id (and so a path segment). */
export const isAlertId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

function normalizeTitle(value) {
  if (typeof value !== 'string') fail('title is required');
  const title = value.trim();
  if (title === '') fail('title is required');
  if (title.length > MAX_TITLE_LENGTH) fail(`title is longer than ${MAX_TITLE_LENGTH} characters`);
  if (ANY_CONTROL_CHARACTER.test(title)) fail('title must be a single line of plain text');
  return title;
}

function normalizeDueDate(value) {
  if (typeof value !== 'string' || parseDateOnly(value) === null) {
    fail('dueDate must be a real date as YYYY-MM-DD');
  }
  if (value < EARLIEST_DUE_DATE || value > LATEST_DUE_DATE) {
    fail(`dueDate must be between ${EARLIEST_DUE_DATE} and ${LATEST_DUE_DATE}`);
  }
  return value;
}

/** HH:MM (UTC), or null when blank: an alert with no time is for the whole day. */
function normalizeDueTime(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('dueTime must be a time as HH:MM, or empty');
  const time = value.trim();
  if (time === '') return null;
  if (!TIME_PATTERN.test(time)) fail('dueTime must be a time as HH:MM (24-hour, UTC), or empty');
  return time;
}

/**
 * '' for no link, an https URL with no credentials in it, or a path inside the
 * admin portal. The same https rule as the reminders sheet's url, plus the
 * portal's own routes (an alert often points at the page that does the work).
 * `..` is refused so a route cannot climb out of /admin.
 */
function normalizeLink(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('link must be a web address or an admin page, or empty');
  const link = value.trim();
  if (link === '') return '';
  if (link.length > MAX_LINK_LENGTH) fail('link is too long');
  if (link.startsWith('/')) {
    const [path] = link.split('?');
    if (
      !ADMIN_ROUTE.test(link) ||
      path.split('/').some((segment) => segment === '..') ||
      OAUTH_SEGMENT.test(path)
    ) {
      fail('link must be an https web address or a page inside /admin');
    }
    return link;
  }
  if (
    NOT_ADDRESS_CHARACTER.test(link) ||
    /[<>"'`\\]/.test(link) ||
    !/^https:\/\/[^/]+/.test(link)
  ) {
    fail('link must be an https web address or a page inside /admin');
  }
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    fail('link must be an https web address or a page inside /admin');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('link must be an https web address or a page inside /admin');
  }
  return link;
}

function normalizeNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('note must be text');
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) fail(`note is longer than ${MAX_NOTE_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(note)) fail('note must be plain text');
  return note;
}

const CREATE_FIELDS = Object.freeze(['title', 'dueDate', 'dueTime', 'link', 'note']);
const EDIT_FIELDS = Object.freeze([...CREATE_FIELDS, 'done', 'snoozeDays']);

/**
 * The body of a create: a title and a day, and optionally a time, a link and a
 * note. Any other key is refused, not dropped, so a typo is a 400 rather than
 * an alert that quietly lacks what was typed.
 *
 * @returns {{ title: string, dueDate: string, dueTime: string|null, link: string, note: string }}
 * @throws {CalendarAlertValidationError}
 */
export function parseCreateBody(body) {
  if (!isPlainObject(body)) fail('The body must be a JSON object');
  assertOnlyKeys(body, CREATE_FIELDS, 'the body');
  return {
    title: normalizeTitle(body.title),
    dueDate: normalizeDueDate(body.dueDate),
    dueTime: normalizeDueTime(body.dueTime),
    link: normalizeLink(body.link),
    note: normalizeNote(body.note),
  };
}

/**
 * The body of an update: any of the editable fields, `done` (true marks it
 * done, false opens it again) or `snoozeDays` (hide it for that many days; 0
 * brings it back now). At least one key. A snooze and a done in one request
 * contradict each other and are refused.
 *
 * @returns {{ edits: object, done?: boolean, snoozeDays?: number }}
 * @throws {CalendarAlertValidationError}
 */
export function parsePatchBody(body) {
  if (!isPlainObject(body)) fail('The body must be a JSON object');
  assertOnlyKeys(body, EDIT_FIELDS, 'the body');
  if (Object.keys(body).length === 0) fail('Send at least one field to change');

  const edits = {};
  if ('title' in body) edits.title = normalizeTitle(body.title);
  if ('dueDate' in body) edits.dueDate = normalizeDueDate(body.dueDate);
  if ('dueTime' in body) edits.dueTime = normalizeDueTime(body.dueTime);
  if ('link' in body) edits.link = normalizeLink(body.link);
  if ('note' in body) edits.note = normalizeNote(body.note);

  const patch = { edits };
  if ('done' in body) {
    if (typeof body.done !== 'boolean') fail('done must be true or false');
    patch.done = body.done;
  }
  if ('snoozeDays' in body) {
    const days = body.snoozeDays;
    if (!Number.isInteger(days) || days < 0 || days > MAX_SNOOZE_DAYS) {
      fail(`snoozeDays must be a whole number from 0 to ${MAX_SNOOZE_DAYS}`);
    }
    patch.snoozeDays = days;
  }
  if (patch.done === true && patch.snoozeDays > 0) {
    fail('An alert cannot be marked done and snoozed in the same request');
  }
  return patch;
}

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
  if (patch.snoozeDays !== undefined) {
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
  return (
    isPlainObject(row) &&
    isAlertId(row.id) &&
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
