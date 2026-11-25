/**
 * community-days/note-fields.js — the fields the owner can save against one
 * Community Days event, and how a request body is checked into them (#1823).
 * Split out of notes.js, which re-exports everything here and describes the
 * stored document.
 */
import { AuthoredError } from '../http/error-response.js';
import { text } from './events.js';

/** What the owner can say about an event. '' is "nothing yet". */
export const NOTE_STATUSES = Object.freeze(['interested', 'applied', 'accepted', 'declined', 'not_going']);
/** The cost boxes the owner fills in. A number of 0 or more, or null for empty. */
export const COST_FIELDS = Object.freeze(['travel', 'lodging', 'other']);
export const NOTES_MAX = 4000;
export const COST_MAX = 1_000_000;
export const NOTE_FIELDS = Object.freeze(['status', 'notes', 'costs', 'etag']);

export class NoteValidationError extends AuthoredError {
  constructor(message) {
    super(message, { code: 'INVALID_NOTE', status: 400 });
  }
}

const fail = (message) => {
  throw new NoteValidationError(message);
};

/**
 * The owner's fields from a request body, checked. Unknown fields are
 * refused, so nothing the page did not mean to send is ever stored.
 *
 * @param {unknown} body
 * @returns {{ status: string, notes: string, costs: Record<string, number|null> }}
 */
export function normalizeNoteInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('The body must be a JSON object.');
  const unknown = Object.keys(body).filter((key) => !NOTE_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown field(s): ${unknown.slice(0, 5).map((key) => text(key, 30)).join(', ')}.`);
  const status = noteStatusOf(body.status);
  const rawNotes = noteTextOf(body.notes);
  const costs = noteCostsOf(body.costs);
  return { status, notes: rawNotes.trim(), costs };
}

/** A missing value (undefined or null) reads as `empty`. */
const orEmpty = (value, empty) => (value === undefined || value === null ? empty : value);

function noteStatusOf(value) {
  const status = orEmpty(value, '');
  if (status !== '' && !NOTE_STATUSES.includes(status)) fail(`status must be empty or one of: ${NOTE_STATUSES.join(', ')}.`);
  return status;
}

function noteTextOf(value) {
  const rawNotes = orEmpty(value, '');
  if (typeof rawNotes !== 'string') fail('notes must be text.');
  if (rawNotes.length > NOTES_MAX) fail(`notes can be at most ${NOTES_MAX} characters.`);
  return rawNotes;
}

function noteCostsOf(value) {
  const rawCosts = orEmpty(value, {});
  if (typeof rawCosts !== 'object' || Array.isArray(rawCosts)) fail('costs must be an object.');
  const strange = Object.keys(rawCosts).filter((key) => !COST_FIELDS.includes(key));
  if (strange.length > 0) fail(`costs can only hold: ${COST_FIELDS.join(', ')}.`);
  const costs = {};
  for (const field of COST_FIELDS) costs[field] = costOf(field, rawCosts[field]);
  return costs;
}

/** One cost box: null when empty, else a number from 0 to COST_MAX, to the cent. */
function costOf(field, value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > COST_MAX) fail(`costs.${field} must be a number from 0 to ${COST_MAX}, or empty.`);
  return Math.round(amount * 100) / 100;
}
