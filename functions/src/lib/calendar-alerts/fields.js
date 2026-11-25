/**
 * calendar-alerts/fields.js — how a request body is checked into the fields
 * of one calendar alert (see model.js for what an alert is). Every check
 * throws a CalendarAlertValidationError naming the field. Re-exported by
 * model.js.
 */
import { parseDateOnly } from '../reminders/calendar.js';
import { fail } from './errors.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 500;
export const MAX_LINK_LENGTH = 2048;
/** Longest snooze a request may ask for; the pop-up offers 1, 3 and 7. */
export const MAX_SNOOZE_DAYS = 30;

const EARLIEST_DUE_DATE = '2000-01-01';
const LATEST_DUE_DATE = '2100-12-31';
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADMIN_ROUTE = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?(?:\?[A-Za-z0-9._~%=&-]*)?$/;
/**
 * What a note may not hold: control characters other than the tab and the
 * line break, the C1 controls (U+0080 to U+009F, which include U+0085) and the
 * Unicode line and paragraph separators. Some calendar programs read those as
 * line ends, so one inside a title or note could start a new property in the
 * .ics file the page offers.
 */
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
/** The same, and the line break too: a title is one line. */
export const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
/** Anything but printable ASCII with no space: an address is percent-encoded, never raw. */
const NOT_ADDRESS_CHARACTER = /[^!-~]/;
/**
 * The OAuth callback acts on its query (code, state), so an alert may not point
 * at it. Matched in any case: the portal's router reads paths case-insensitively,
 * so /OAuth/ reaches the same page as /oauth/.
 */
const OAUTH_SEGMENT = /(^|\/)(oauth|callback)(\/|$)/i;

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(
      `Unknown field(s) in ${where}: ${unknown.map((key) => key.slice(0, 40)).join(', ')}. Allowed: ${allowed.join(', ')}`
    );
  }
}

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
export function normalizeLink(value) {
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
