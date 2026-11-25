/**
 * community-days/handlers.js — the routes behind the Speaking hub's "Events
 * to apply to" tab (#1823, ADR 0045).
 *
 *   GET    cms/community-days/events                     the list, with the owner's notes   editor
 *   POST   cms/community-days/refresh                    read the list again now            editor
 *   PUT    cms/community-days/events/{eventId}           save status, notes and costs       editor
 *   DELETE cms/community-days/events/{eventId}           remove what was saved              editor
 *   POST   cms/community-days/events/{eventId}/estimate  ask the model for one estimate     editor
 *
 * Editor and above, like the rest of the Speaking hub. The page never talks
 * to Community Days: the browser calls these routes, and only the server
 * holds the key (client.js). No answer here carries the key, a URL built with
 * it, or the outside API's raw response.
 *
 * NOTHING PRIVATE IN A LOG. The owner's notes and costs, an event's id and
 * the outside API's text are never logged: a failure is logged by its code
 * (http/error-response.js). An audit row carries the event's id and the names
 * of what changed, never the note's text. The answers are
 * `Cache-Control: private, no-store`.
 *
 * Every refusal is a sentence this code wrote (AuthoredError, #945); a
 * failure of the store or the model is a fixed sentence plus a correlation id.
 */
import { randomUUID } from 'node:crypto';

import { recordMutationAudit } from '../audit.js';
import { startBudgetClock } from '../ai/time-budget.js';
import { authoredMessage, errorCode, errorResponse, isAuthoredError } from '../http/error-response.js';
import { readJsonBodyWithin } from '../http/bounded-body.js';
import { loadEvents, readCacheState, CACHE_DOC_ID, CONTAINER } from './cache.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { API_KEY_SETTING } from './api.js';
import { readApiKey } from './client.js';
import { isEventId, presentEvent } from './events.js';
import { ESTIMATE_AI_BUDGET_MS, EstimateRefusedError, EstimateUnusableError, estimateAcceptance, gatherTopics } from './estimate.js';
import {
  NOTE_STATUSES,
  NoteNotFoundError,
  NoteValidationError,
  deleteNote,
  listNoteDocs,
  normalizeNoteInput,
  presentNote,
  saveEstimate,
  saveNote,
} from './notes.js';

export const COMMUNITY_DAYS_ROLE = 'editor';
export const MAX_BODY_BYTES = 24_000;
/** How many Speaking hub rows are read for talk topics. */
export const SPEAKER_EVENTS_WINDOW = 200;

/** What the Estimate button answers when its switch on the AI Engine page is off. */
export const ESTIMATE_SWITCHED_OFF_CODE = 'ESTIMATE_SWITCHED_OFF';
export const ESTIMATE_SWITCHED_OFF_SENTENCE =
  'The acceptance estimate is switched off. To use it, switch on “Speaking acceptance estimate” on the AI Engine page (the AI Services tab), then press Estimate again. Nothing was asked of a model.';

export const AUDIT_ACTIONS = Object.freeze({
  saved: 'community_days_note_saved',
  deleted: 'community_days_note_deleted',
  estimated: 'community_days_estimate_made',
});

class BodyTooLargeError extends NoteValidationError {
  constructor() {
    super('The request is too large.');
    this.status = 413;
    this.code = 'TOO_LARGE';
  }
}

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/** The version the page read, from the If-Match header or the body's `etag`; '' when neither. */
function etagOf(request, body = null) {
  const header = request.headers?.get?.('if-match');
  if (typeof header === 'string' && header.trim()) return header.trim();
  return typeof body?.etag === 'string' ? body.etag.trim() : '';
}

function failed(context, request, sentence, error) {
  // The estimate is switched off on the AI Engine page. That is the owner's
  // own choice, not a fault: the model router says so with an error that
  // carries no HTTP status, which would otherwise fall through to a 500 and
  // a failure in the log. Answer 409 with a sentence that says where the
  // switch is, and a code the page can tell apart.
  if (error?.code === 'AI_FEATURE_DISABLED') {
    return privateJson(409, { ok: false, error: ESTIMATE_SWITCHED_OFF_SENTENCE, code: ESTIMATE_SWITCHED_OFF_CODE });
  }
  // A refusal this module wrote: below 500, or the one 502 it writes itself
  // (the model answered, but not with a number). Anything else, including
  // an authored error from the model router, gets the fixed sentence.
  const ours = error instanceof EstimateUnusableError || (Number.isInteger(error?.status) && error.status < 500);
  if (isAuthoredError(error) && ours) {
    return privateJson(error.status, {
      ok: false,
      error: authoredMessage(error, sentence),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    });
  }
  return errorResponse(context, sentence, error, 500, request);
}

function eventIdOf(request) {
  const id = request.params?.eventId;
  if (!isEventId(id)) throw new NoteNotFoundError('There is no such event.');
  return id;
}

async function readBody(request) {
  const read = await readJsonBodyWithin(request, MAX_BODY_BYTES);
  if (read.tooLarge) throw new BodyTooLargeError();
  return read.body;
}

async function audit({ store, now, uuid }, { action, user, eventId, details, context }) {
  await recordMutationAudit(store, {
    action,
    actor: user,
    resource: `admin_config:community_days_event:${eventId}`,
    details: { eventId, ...details },
    now,
    uuid,
    context,
  });
}

/** The owner's talk topics, from the Speaking hub's own data and the cached talk titles. */
async function readTopics({ store }, talks) {
  const [speakerEvents, settings] = await Promise.all([
    store.queryDocs('speakerevents', `SELECT TOP ${SPEAKER_EVENTS_WINDOW} c.topic, c.sessions FROM c ORDER BY c._ts DESC`, []),
    store.readDoc('admin_settings', 'integrations', 'integrations'),
  ]);
  return gatherTopics({ speakerEvents, speakerProfile: settings?.speakerProfile ?? null, talks });
}

/** The page's whole answer: the cached list joined with the owner's notes. */
async function listAnswer({ store, env, now, load }, context, { force }) {
  const loaded = await load({ store, env, now, force, log: context });
  const notes = new Map();
  for (const doc of await listNoteDocs(store)) {
    const note = presentNote(doc);
    if (note) notes.set(note.eventId, note);
  }
  const listed = new Set();
  const events = loaded.events.map((event) => {
    listed.add(event.id);
    return { ...presentEvent(event), note: notes.get(event.id) ?? null };
  });
  // Saved for an event that is no longer listed (its call closed, or it was
  // unpublished): still the owner's record, shown from the note's own copy.
  const saved = [...notes.values()].filter((note) => !listed.has(note.eventId) && note.event);
  const topics = await readTopics({ store }, loaded.talks);
  return privateJson(200, {
    ok: true,
    status: loaded.status,
    keySet: loaded.status !== 'no_key',
    keySetting: API_KEY_SETTING,
    events,
    saved,
    fetchedAt: loaded.fetchedAt,
    total: loaded.total,
    truncated: loaded.truncated,
    refreshed: loaded.refreshed,
    retryAt: loaded.retryAt,
    error: loaded.error ?? null,
    notice: loaded.notice ?? null,
    statuses: NOTE_STATUSES,
    topics: { count: topics.topics.length, hasBio: Boolean(topics.bio), from: topics.from },
  });
}

/**
 * What an estimate is made from: the cached event and the owner's topics.
 * Throws the refusal when there is no key, no such event, a cancelled one,
 * or nothing to compare it with.
 */
async function estimateInputs({ store, env }, eventId) {
  if (!readApiKey(env)) {
    throw new EstimateRefusedError('The Community Days key is not set yet, so there is no event text to estimate from.', { code: 'NO_KEY' });
  }
  // The estimate reads this site's copy; it never calls Community Days.
  const cache = readCacheState(await store.readDoc(CONTAINER, CACHE_DOC_ID, ADMIN_CONFIG_PARTITION));
  const event = cache.events.find((entry) => entry.id === eventId);
  if (!event) {
    throw new NoteNotFoundError('This event is not in the list read from Community Days. Press Refresh and try again.');
  }
  if (event.cancelled) throw new EstimateRefusedError('This event is cancelled, so no estimate is made for it.', { code: 'EVENT_CANCELLED' });
  const { topics, bio, from } = await readTopics({ store }, cache.talks);
  if (topics.length === 0 && !bio) {
    throw new EstimateRefusedError(
      'There are no talk topics to compare the event with. Add a topic or session titles to an event on the Speaking hub (Upcoming → Enrich), or a bio on its Settings tab, then try again.',
      { code: 'NO_TOPICS' }
    );
  }
  return { event, topics, bio, from };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {object} deps.store readDoc, createDoc, replaceDocIfMatch, deleteDocIfMatch, queryDocs, upsertDoc (audit)
 * @param {{ generateJsonResponse: Function }} deps.ai the site's model router
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Function} [deps.load] test seam for cache.js loadEvents
 * @param {number} [deps.aiBudgetMs]
 */
export function createCommunityDaysHandlers({
  guard,
  store,
  ai,
  env = process.env,
  now = () => new Date(),
  uuid = randomUUID,
  load = loadEvents,
  aiBudgetMs = ESTIMATE_AI_BUDGET_MS,
}) {
  const deps = { store, env, now, uuid, load };

  return {
    /** GET cms/community-days/events */
    async list(request, context) {
      const auth = await guard.requireRole(request, COMMUNITY_DAYS_ROLE);
      if (auth.error) return auth.error;
      try {
        return await listAnswer(deps, context, { force: false });
      } catch (error) {
        return failed(context, request, 'Failed to read the events to apply to', error);
      }
    },

    /** POST cms/community-days/refresh */
    async refresh(request, context) {
      const auth = await guard.requireRole(request, COMMUNITY_DAYS_ROLE);
      if (auth.error) return auth.error;
      try {
        return await listAnswer(deps, context, { force: true });
      } catch (error) {
        return failed(context, request, 'Failed to refresh the events to apply to', error);
      }
    },

    /** PUT cms/community-days/events/{eventId} */
    async save(request, context) {
      const auth = await guard.requireRole(request, COMMUNITY_DAYS_ROLE);
      if (auth.error) return auth.error;
      try {
        const eventId = eventIdOf(request);
        const body = await readBody(request);
        const input = normalizeNoteInput(body);
        const cache = readCacheState(await store.readDoc(CONTAINER, CACHE_DOC_ID, ADMIN_CONFIG_PARTITION));
        const doc = await saveNote(store, {
          eventId,
          input,
          etag: etagOf(request, body),
          cachedEvent: cache.events.find((event) => event.id === eventId) ?? null,
          now,
        });
        await audit(deps, { action: AUDIT_ACTIONS.saved, user: auth.user, eventId, details: { status: input.status, hasNotes: Boolean(input.notes) }, context });
        return privateJson(200, { ok: true, note: presentNote(doc) });
      } catch (error) {
        return failed(context, request, 'Failed to save the event', error);
      }
    },

    /** DELETE cms/community-days/events/{eventId} */
    async remove(request, context) {
      const auth = await guard.requireRole(request, COMMUNITY_DAYS_ROLE);
      if (auth.error) return auth.error;
      try {
        const eventId = eventIdOf(request);
        await deleteNote(store, { eventId, etag: etagOf(request) });
        await audit(deps, { action: AUDIT_ACTIONS.deleted, user: auth.user, eventId, details: {}, context });
        return privateJson(200, { ok: true, eventId });
      } catch (error) {
        return failed(context, request, 'Failed to remove what was saved for the event', error);
      }
    },

    /** POST cms/community-days/events/{eventId}/estimate */
    async estimate(request, context) {
      const budgetLeft = startBudgetClock(aiBudgetMs);
      const auth = await guard.requireRole(request, COMMUNITY_DAYS_ROLE);
      if (auth.error) return auth.error;
      try {
        const eventId = eventIdOf(request);
        const { event, topics, bio, from } = await estimateInputs(deps, eventId);
        const made = await estimateAcceptance({ ai }, { event, topics, bio, budgetMs: budgetLeft() });
        const estimate = { ...made, madeAt: now().toISOString(), topicsFrom: from };
        const doc = await saveEstimate(store, { eventId, estimate, cachedEvent: event, now });
        await audit(deps, { action: AUDIT_ACTIONS.estimated, user: auth.user, eventId, details: { percent: estimate.percent }, context });
        return privateJson(200, { ok: true, note: presentNote(doc) });
      } catch (error) {
        if (!isAuthoredError(error)) context?.warn?.(`communityDaysEstimate: the model call or the save failed (${errorCode(error)})`);
        return failed(context, request, 'The estimate could not be made', error);
      }
    },
  };
}
