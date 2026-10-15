/**
 * speaker-events.js — the speaker-event write RPCs (upsertSpeakerEvent /
 * deleteSpeakerEvent), ported from Site-Main cms-functions.js (:6171,
 * :6236). Each handler body is a module-level function over `ctx` (guard,
 * store, now, actor); the factory at the bottom only wires them.
 */
import { json } from '../http/admin-handler.js';
import { errorResponse } from '../http/error-response.js';
import { checkSpeakerEventUpsert } from './speaker-event-rules.js';

/**
 * The write itself. `merge === false` is `set(..., {merge:false})` — a full
 * replace, with creation stamps. A merge patches an existing document; a
 * merge that creates is still a creation, so it is stamped as one.
 */
async function writeSpeakerEvent(store, { docId, payload, merge, created }) {
  const existing = merge === false ? null : await store.readDoc('speakerevents', docId, docId);
  if (existing) {
    await store.patchDoc('speakerevents', docId, payload);
    return;
  }
  await store.upsertDoc('speakerevents', { id: docId, ...payload, ...created });
}

/** POST /api/upsertSpeakerEvent — merge by default, replace on merge:false. */
async function upsertSpeakerEvent(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const checked = checkSpeakerEventUpsert(body);
    if (checked.error) return json(400, { error: checked.error });

    const nowIso = ctx.now().toISOString();
    const by = ctx.actor(auth.user);
    await writeSpeakerEvent(ctx.store, {
      docId: checked.docId,
      merge: checked.merge,
      payload: { ...checked.value, updatedAt: nowIso, updatedBy: by },
      created: { createdAt: nowIso, createdBy: by },
    });

    return json(200, { success: true, docId: checked.docId });
  } catch (error) {
    return errorResponse(context, 'Failed to save speaker event', error, 500, request);
  }
}

/** POST /api/deleteSpeakerEvent */
async function deleteSpeakerEvent(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const { docId } = body;
    if (!docId || typeof docId !== 'string') {
      return json(400, { error: 'docId required' });
    }

    const existing = await ctx.store.readDoc('speakerevents', docId, docId);
    if (!existing) {
      return json(404, { error: `speakerevents/${docId} not found` });
    }

    await ctx.store.deleteDoc('speakerevents', docId);
    return json(200, { success: true, docId, deletedBy: ctx.actor(auth.user) });
  } catch (error) {
    return errorResponse(context, 'Failed to delete speaker event', error, 500, request);
  }
}

/** @param {{ guard: object, store: object, now: () => Date, actor: (user: object) => string }} ctx */
export function createSpeakerEventHandlers(ctx) {
  return {
    upsertSpeakerEvent: (request, context) => upsertSpeakerEvent(ctx, request, context),
    deleteSpeakerEvent: (request, context) => deleteSpeakerEvent(ctx, request, context),
  };
}
