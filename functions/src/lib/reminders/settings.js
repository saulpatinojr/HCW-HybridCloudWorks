/**
 * reminders/settings.js — the owner's dated reminders: the shape, its
 * normalizer, and when each one is due to be said.
 *
 * Owner request 2026-10-06, after a token expiry and a re-verification date
 * had been living in session notes and memory files rather than anywhere the
 * platform could act on: "reminders should leverage Telegram as well", kept
 * on a sheet of their own under Platform Settings. One `admin_config`
 * document holds them (`admin_config/reminders`, edited on Platform Settings
 * → Reminders through cms/platform-settings/reminders), and the daily
 * `sendReminders` timer (timers/reminders.js) reads it and tells the owner on
 * Telegram ahead of each date, on the day, and weekly after it until the
 * reminder is marked done.
 *
 * The shape is exactly what the timer reads, normalized on every save the
 * same way every other platform setting is (platform-settings.js): unknown
 * keys are refused, dates must be real calendar dates, and the `notified`
 * stamps the timer writes round-trip through the page unchanged, so a save
 * from the sheet never makes a reminder fire twice.
 */

import { AuthoredError } from '../http/error-response.js';
import { STAGES, parseDateOnly } from './calendar.js';

// The calendar (dates, stages) lives beside this file; re-exported so a
// reader of the shape finds the whole of "reminders" from one import.
export {
  OVERDUE_REPEAT_DAYS,
  STAGES,
  dateOnly,
  daysUntil,
  parseDateOnly,
  stageDue,
} from './calendar.js';

export const REMINDERS_CONFIG_ID = 'reminders';
export const MAX_REMINDERS = 200;
/**
 * Rows kept for the credential register's own reminders, which an editor's
 * save of the sheet cannot use (review of #1039): without the reserve, a
 * sheet filled with the owner's rows before the register's were installed
 * would refuse every sync, and the renewal warnings would never appear.
 * credentials/reminders.test.js holds the register's rows under it.
 */
export const REGISTER_RESERVED_ROWS = 20;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_URL_LENGTH = 2048;
export const MAX_LEAD_DAYS = 365;
export const DEFAULT_LEAD_DAYS = 7;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Thrown by the normalizer; platform-settings.js turns it into a 400 (authored, #945). */
export class RemindersValidationError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field */
  constructor(message) {
    super(message);
    this.name = 'RemindersValidationError';
    this.status = 400;
  }
}

const fail = (message) => {
  throw new RemindersValidationError(message);
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`Unknown field(s) in ${where}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
}

/** An https URL with nothing that could smuggle a second one, or empty. */
function normalizeUrl(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${where}.url must be a string`);
  const url = value.trim();
  if (url === '') return '';
  if (url.length > MAX_URL_LENGTH) fail(`${where}.url is too long`);
  if (/[\s<>"'`\\]/.test(url) || !/^https:\/\/[^/]+/.test(url)) {
    fail(`${where}.url must be an https URL`);
  }
  return url;
}

/** The timer's stamps: each stage an ISO instant or absent. Never invented here. */
function normalizeNotified(value, where) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) fail(`${where}.notified must be an object`);
  assertOnlyKeys(value, STAGES, `${where}.notified`);
  const out = {};
  for (const stage of STAGES) {
    const stamp = value[stage];
    if (stamp === undefined || stamp === null) continue;
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) {
      fail(`${where}.notified.${stage} must be an ISO timestamp`);
    }
    out[stage] = new Date(stamp).toISOString();
  }
  return out;
}

function normalizeReminder(entry, index) {
  const where = `reminders[${index}]`;
  if (!isPlainObject(entry)) fail(`${where} must be an object`);
  assertOnlyKeys(
    entry,
    ['id', 'title', 'dueDate', 'leadDays', 'notes', 'url', 'done', 'notified'],
    where
  );

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!ID_PATTERN.test(id)) fail(`${where}.id must be 1–64 letters, digits, - or _`);

  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  if (title === '') fail(`${where}.title is required`);
  if (title.length > MAX_TITLE_LENGTH) fail(`${where}.title is longer than ${MAX_TITLE_LENGTH} characters`);

  if (parseDateOnly(entry.dueDate) === null) fail(`${where}.dueDate must be a real date as YYYY-MM-DD`);

  const leadRaw = entry.leadDays ?? DEFAULT_LEAD_DAYS;
  const leadDays = typeof leadRaw === 'string' && leadRaw.trim() !== '' ? Number(leadRaw) : leadRaw;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > MAX_LEAD_DAYS) {
    fail(`${where}.leadDays must be a whole number from 0 to ${MAX_LEAD_DAYS}`);
  }

  const notesRaw = entry.notes ?? '';
  if (typeof notesRaw !== 'string') fail(`${where}.notes must be a string`);
  const notes = notesRaw.trim();
  if (notes.length > MAX_NOTES_LENGTH) fail(`${where}.notes is longer than ${MAX_NOTES_LENGTH} characters`);

  const done = entry.done ?? false;
  if (typeof done !== 'boolean') fail(`${where}.done must be true or false`);

  return {
    id,
    title,
    dueDate: entry.dueDate,
    leadDays,
    notes,
    url: normalizeUrl(entry.url, where),
    done,
    notified: normalizeNotified(entry.notified, where),
  };
}

/**
 * `{ reminders: [...] }` → the document the timer reads. Order is kept as
 * given: the sheet sorts for display and the timer does not care.
 */
export function normalizeReminders(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  assertOnlyKeys(body, ['reminders'], 'body');
  const list = body.reminders ?? [];
  if (!Array.isArray(list)) fail('reminders must be an array');
  if (list.length > MAX_REMINDERS) fail(`reminders may hold at most ${MAX_REMINDERS} entries`);
  const seen = new Set();
  const reminders = list.map((entry, index) => {
    const reminder = normalizeReminder(entry, index);
    if (seen.has(reminder.id)) fail(`reminders[${index}].id "${reminder.id}" is given more than once`);
    seen.add(reminder.id);
    return reminder;
  });
  return { reminders };
}

export const emptyReminders = () => ({ reminders: [] });

/**
 * The stored document as the timer reads it: only the `reminders` field,
 * normalized, so a hand-edited document that does not validate is a warning
 * and a skipped run, never a message built from a half-read row. Throws
 * RemindersValidationError.
 */
export function readStoredReminders(doc) {
  if (!doc) return emptyReminders();
  return normalizeReminders({ reminders: doc.reminders ?? [] });
}

/** Two `notified` maps as one: per stage, the later instant wins. */
export function mergeStamps(a, b) {
  const out = {};
  for (const stage of STAGES) {
    const [x, y] = [a?.[stage], b?.[stage]];
    const later = [x, y].filter(Boolean).sort().at(-1);
    if (later) out[stage] = later;
  }
  return out;
}

/**
 * The id prefix of the rows the credential register keeps on this sheet
 * (lib/credentials/reminders.js). Defined here, where the sheet's shape
 * lives, so the save below and the register share one spelling of it.
 */
export const CREDENTIAL_ROW_PREFIX = 'credential-';

/** Whether a row is one the credential register keeps, by its reserved id prefix. */
export const isCredentialRow = (row) =>
  typeof row?.id === 'string' && row.id.startsWith(CREDENTIAL_ROW_PREFIX);

/**
 * The stored document's register rows, each normalized on its own, stamps
 * included. A row that does not validate is left out and the rest are kept
 * (#1041): the whole sheet used to be validated at once, so one malformed
 * owner row dropped every register row and its `notified` stamps, and the
 * next run said a stage again. A dropped row comes back, valid, at the
 * register's next sync. A second row under an id already kept is dropped,
 * as a whole-sheet read would have refused it.
 */
function storedCredentialRows(storedDoc) {
  const storedRows = Array.isArray(storedDoc?.reminders) ? storedDoc.reminders : [];
  const kept = new Map();
  for (const entry of storedRows) {
    let row;
    try {
      [row] = normalizeReminders({ reminders: [entry] }).reminders;
    } catch (error) {
      if (error instanceof RemindersValidationError) continue;
      throw error;
    }
    if (isCredentialRow(row) && !kept.has(row.id)) kept.set(row.id, row);
  }
  return [...kept.values()];
}

/**
 * The sheet's save, with any stamp the timer wrote while the page was open
 * kept: for each incoming row that the stored document also holds, `notified`
 * is the merge of both. Rows the owner removed stay removed, rows they added
 * carry only what they sent. Review of #910: without this, a save made after
 * the 13:00 run erased that morning's stamp and the reminder was said again.
 *
 * THE CREDENTIAL REGISTER'S ROWS ARE NOT THE SHEET'S TO CHANGE (review of
 * #1039). This page saves at `editor`, below the `super_admin` that records
 * a rotation, so a save that could mark a `credential-` row done, re-date
 * it, or remove it would let an editor silence a renewal warning. A save
 * therefore carries every stored register row through exactly as stored,
 * stamps included, and drops any register row the request sent, new or
 * changed: it cannot add, remove or alter one. Their stamps are the stored
 * ones, not a merge with the request's, because the stored row already
 * holds every stamp the timer wrote (what the merge above exists to keep),
 * and a request's stamp could otherwise be a forged one that silences a
 * stage. Recording a rotation on Integrations → Credentials is the only way
 * a register row's cycle ends. The owner's own rows behave exactly as
 * before.
 *
 * Editors can still READ the register rows, and so the credential names in
 * their titles and notes. That is accepted: those names (secret names,
 * variable names, file paths) are public in this repository's own docs,
 * docs/standards/required-inputs.md among them; the rows carry no value.
 *
 * Throws RemindersValidationError when the owner's rows and the stored
 * register rows together pass MAX_REMINDERS.
 */
export function mergeStoredStamps(value, storedDoc) {
  // A stored `reminders` that is not a list (a malformed sheet) holds no rows
  // to keep stamps from: this save repairs it, as storedCredentialRows does,
  // rather than throwing a TypeError into a 500 (review of #1039).
  const storedRows = Array.isArray(storedDoc?.reminders) ? storedDoc.reminders : [];
  const stored = new Map(storedRows.map((row) => [row?.id, row?.notified]));
  const ownRows = value.reminders
    .filter((row) => !isCredentialRow(row))
    .map((row) =>
      stored.has(row.id) ? { ...row, notified: mergeStamps(stored.get(row.id), row.notified) } : row
    );
  const ownLimit = MAX_REMINDERS - REGISTER_RESERVED_ROWS;
  if (ownRows.length > ownLimit) {
    fail(
      `reminders may hold at most ${ownLimit} of your own entries; ${REGISTER_RESERVED_ROWS} are kept for the credential register`
    );
  }
  const reminders = [...ownRows, ...storedCredentialRows(storedDoc)];
  if (reminders.length > MAX_REMINDERS) {
    fail(`reminders may hold at most ${MAX_REMINDERS} entries, the credential register's rows included`);
  }
  return { reminders };
}

/** What the audit row records: counts and the next date, never titles. */
export function summarizeReminders(value) {
  const open = value.reminders.filter((reminder) => !reminder.done);
  const nextDue = open.map((reminder) => reminder.dueDate).sort()[0] ?? null;
  return { reminders: value.reminders.length, open: open.length, nextDue };
}
