/**
 * community-days/notes.js — what the owner has written against one Community
 * Days event: a status, notes, costs, and the saved estimate (#1823, ADR 0045).
 *
 * ONE SMALL DOCUMENT PER EVENT, in `admin_config` (the container and the
 * constant partition every other admin setting uses, so no new container and
 * no Terraform for storage). Its id is `community_days_event_<event id>`, the
 * API's own id for the event, so a note is found without a search and an
 * event can have only one.
 *
 * Each document also keeps a small copy of the event (`event`: its title,
 * days and place). The API lists an event only while its call for speakers
 * is open, and the owner's "applied" must still mean something, and still
 * show on the calendar, after the call has closed and the event has left the
 * list.
 *
 * EVERY WRITE IS GUARDED BY THE VERSION IT WAS DECIDED FROM. A save sends the
 * ETag (the version stamp Cosmos gives each document) the page last read; the
 * document is replaced only if it still carries that stamp, and created only
 * if it still does not exist. Otherwise the save is refused with 409 and the
 * page reads again, so two tabs can never silently overwrite each other.
 *
 * The whole document is written each time, built here field by field from
 * checked values: no value is ever `undefined`, and no field name comes from
 * the request, so a dotted or unexpected key cannot reach the store.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError } from '../http/error-response.js';
import { dayOf, httpUrl, isEventId, text } from './events.js';

export const CONTAINER = 'admin_config';
export const NOTE_DOC_TYPE = 'community_days_event_note';
export const NOTE_ID_PREFIX = 'community_days_event_';
export const NOTES_WINDOW = 500;

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

export class NoteConflictError extends AuthoredError {
  constructor() {
    super('This event was changed somewhere else since the page read it. Nothing was saved; the page has the latest now, so make the change again.', {
      code: 'CONFLICT',
      status: 409,
    });
  }
}

export class NoteNotFoundError extends AuthoredError {
  constructor(message = 'There is nothing saved for this event.') {
    super(message, { code: 'NOT_FOUND', status: 404 });
  }
}

const fail = (message) => {
  throw new NoteValidationError(message);
};

export const noteDocId = (eventId) => `${NOTE_ID_PREFIX}${eventId}`;

const isConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};
const isMissing = (error) => (error?.code ?? error?.statusCode) === 404;

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

  const status = body.status === undefined || body.status === null ? '' : body.status;
  if (status !== '' && !NOTE_STATUSES.includes(status)) fail(`status must be empty or one of: ${NOTE_STATUSES.join(', ')}.`);

  const rawNotes = body.notes === undefined || body.notes === null ? '' : body.notes;
  if (typeof rawNotes !== 'string') fail('notes must be text.');
  if (rawNotes.length > NOTES_MAX) fail(`notes can be at most ${NOTES_MAX} characters.`);

  const rawCosts = body.costs === undefined || body.costs === null ? {} : body.costs;
  if (typeof rawCosts !== 'object' || Array.isArray(rawCosts)) fail('costs must be an object.');
  const strange = Object.keys(rawCosts).filter((key) => !COST_FIELDS.includes(key));
  if (strange.length > 0) fail(`costs can only hold: ${COST_FIELDS.join(', ')}.`);
  const costs = {};
  for (const field of COST_FIELDS) {
    const value = rawCosts[field];
    if (value === undefined || value === null || value === '') {
      costs[field] = null;
    } else {
      const amount = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(amount) || amount < 0 || amount > COST_MAX) fail(`costs.${field} must be a number from 0 to ${COST_MAX}, or empty.`);
      costs[field] = Math.round(amount * 100) / 100;
    }
  }
  return { status, notes: rawNotes.trim(), costs };
}

/** The small copy of an event a note keeps, from a cached event or an earlier copy; null when neither is usable. */
export function eventSnapshot(source) {
  if (!source || typeof source !== 'object') return null;
  const title = text(source.title, 160);
  const startDate = dayOf(source.startDate);
  if (!title || !startDate) return null;
  const endDate = dayOf(source.endDate);
  return {
    title,
    startDate,
    endDate: endDate && endDate >= startDate ? endDate : startDate,
    url: httpUrl(source.url),
    city: text(source.city, 80),
    region: text(source.region, 80),
    country: text(source.country, 2).toUpperCase(),
    eventType: text(source.eventType, 24),
    callCloses: dayOf(source.callCloses),
  };
}

/** A stored estimate as it is kept and shown, or null. Checked again on the way out. */
export function storedEstimate(value) {
  if (!value || typeof value !== 'object') return null;
  const percent = Number(value.percent);
  if (!Number.isFinite(percent)) return null;
  return {
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    reasons: (Array.isArray(value.reasons) ? value.reasons : []).map((reason) => text(reason, 240)).filter(Boolean).slice(0, 3),
    madeAt: typeof value.madeAt === 'string' && Number.isFinite(Date.parse(value.madeAt)) ? value.madeAt : null,
    topicsFrom: (Array.isArray(value.topicsFrom) ? value.topicsFrom : []).map((label) => text(label, 60)).filter(Boolean).slice(0, 4),
  };
}

/** A stored note as the page is sent it: checked fields, the ETag, and none of Cosmos's own fields. */
export function presentNote(doc) {
  if (!doc || typeof doc !== 'object' || doc.docType !== NOTE_DOC_TYPE || !isEventId(doc.eventId)) return null;
  const costs = {};
  for (const field of COST_FIELDS) {
    const amount = doc.costs?.[field];
    costs[field] = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
  }
  return {
    eventId: doc.eventId,
    status: NOTE_STATUSES.includes(doc.status) ? doc.status : '',
    notes: typeof doc.notes === 'string' ? doc.notes.slice(0, NOTES_MAX) : '',
    costs,
    estimate: storedEstimate(doc.estimate),
    event: eventSnapshot(doc.event),
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    etag: typeof doc._etag === 'string' ? doc._etag : null,
  };
}

/** Every saved note, as stored documents. */
export async function listNoteDocs(store) {
  const rows = await store.queryDocs(
    CONTAINER,
    `SELECT TOP ${NOTES_WINDOW} * FROM c WHERE c.configScope = @scope AND c.docType = @type`,
    [
      { name: '@scope', value: ADMIN_CONFIG_PARTITION },
      { name: '@type', value: NOTE_DOC_TYPE },
    ],
    { partitionKey: ADMIN_CONFIG_PARTITION }
  );
  return Array.isArray(rows) ? rows : [];
}

export const readNoteDoc = (store, eventId) => store.readDoc(CONTAINER, noteDocId(eventId), ADMIN_CONFIG_PARTITION);

/** The whole document for one event, every field set (never undefined). */
function buildDoc(eventId, { status, notes, costs, estimate, event, at }) {
  return {
    id: noteDocId(eventId),
    configScope: ADMIN_CONFIG_PARTITION,
    docType: NOTE_DOC_TYPE,
    eventId,
    status,
    notes,
    costs: Object.fromEntries(COST_FIELDS.map((field) => [field, costs?.[field] ?? null])),
    estimate: estimate ?? null,
    event: event ?? null,
    updatedAt: at,
  };
}

/** Write `doc` over `existing` (or create it), turning a lost race into NoteConflictError. */
async function guardedWrite(store, existing, doc) {
  try {
    if (existing) {
      return await store.replaceDocIfMatch(CONTAINER, { ...doc, _etag: existing._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
    }
    return await store.createDoc(CONTAINER, doc);
  } catch (error) {
    if (isConflict(error) || isMissing(error)) throw new NoteConflictError();
    throw error;
  }
}

/**
 * Save the owner's fields for one event.
 *
 * `etag` is the version the page read: required when a note already exists,
 * and must be absent when none does. `cachedEvent` is the event from the
 * cache when it is still listed; without it the note's earlier copy is kept,
 * and a first save for an event this site has never seen is refused.
 *
 * @returns {Promise<object>} the stored document
 */
export async function saveNote(store, { eventId, input, etag, cachedEvent, now }) {
  const existing = await readNoteDoc(store, eventId);
  if (existing ? existing._etag !== etag : Boolean(etag)) throw new NoteConflictError();
  const event = eventSnapshot(cachedEvent) ?? eventSnapshot(existing?.event);
  if (!event) throw new NoteNotFoundError('This event is not in the list read from Community Days, so nothing can be saved for it.');
  const doc = buildDoc(eventId, {
    ...input,
    estimate: storedEstimate(existing?.estimate),
    event,
    at: now().toISOString(),
  });
  return guardedWrite(store, existing, doc);
}

/**
 * Keep a new estimate on an event's note, creating the note if there is
 * none. The estimate was paid for, so a lost race is tried again on the
 * latest document (up to three times) instead of being thrown away; nothing
 * else on the note is changed.
 *
 * @returns {Promise<object>} the stored document
 */
export async function saveEstimate(store, { eventId, estimate, cachedEvent, now }) {
  for (let attempt = 1; ; attempt += 1) {
    const existing = await readNoteDoc(store, eventId);
    const doc = buildDoc(eventId, {
      status: NOTE_STATUSES.includes(existing?.status) ? existing.status : '',
      notes: typeof existing?.notes === 'string' ? existing.notes.slice(0, NOTES_MAX) : '',
      costs: presentNote(existing)?.costs ?? {},
      estimate,
      event: eventSnapshot(cachedEvent) ?? eventSnapshot(existing?.event),
      at: now().toISOString(),
    });
    try {
      return await guardedWrite(store, existing, doc);
    } catch (error) {
      if (!(error instanceof NoteConflictError) || attempt >= 3) throw error;
    }
  }
}

/** Delete an event's note, only if it is still the version the page read. */
export async function deleteNote(store, { eventId, etag }) {
  if (!etag) throw new NoteConflictError();
  try {
    await store.deleteDocIfMatch(CONTAINER, noteDocId(eventId), etag, ADMIN_CONFIG_PARTITION);
  } catch (error) {
    if (isMissing(error)) throw new NoteNotFoundError();
    if (isConflict(error)) throw new NoteConflictError();
    throw error;
  }
}
