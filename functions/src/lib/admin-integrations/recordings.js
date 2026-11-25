/**
 * recordings.js — the recordings routes of the admin integrations surface
 * (RecordingsPage.jsx, the Recording Hub): list, create, and the routing
 * patch. The field rules are in ./recording-rules.js.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * uuid); the factory at the bottom only wires them.
 */
import { json, LIST_WINDOW, validBody } from '../http/admin-handler.js';
import { recordMutationAudit } from '../audit.js';
import { errorFacts } from '../http/error-response.js';
import { validateRecordingCreate, validateRecordingPatch } from './recording-rules.js';

/** A stamp as epoch ms for sorting, 0 when missing or unreadable. Also used by the usage list. */
export const dateValue = (v) => {
  if (!v) return 0;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

/** GET /api/cms/recordings — local library, newest first. */
async function listRecordings(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const limit = Math.min(Math.max(Number(request.query.get('limit')) || 100, 1), 500);
    const items = await ctx.store.queryDocs('recordings', `SELECT TOP ${LIST_WINDOW} * FROM c`, []);
    const sorted = items
      .sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))
      .slice(0, limit);
    return json(200, {
      success: true,
      items: sorted,
      total: sorted.length,
    });
  } catch (error) {
    context.error('listRecordings failed:', errorFacts(error));
    return json(500, { error: 'Failed to list recordings' });
  }
}

/** POST /api/cms/recordings — both page paths require title + transcript. */
async function createRecording(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    if (!body) return json(400, { error: 'Body must be a JSON object' });
    const checked = validateRecordingCreate(body);
    if (checked.error) return json(400, { error: checked.error });
    const doc = {
      ...checked.doc,
      id: ctx.uuid(),
      status: 'new',
      createdAt: ctx.now().toISOString(),
    };
    await ctx.store.upsertDoc('recordings', doc);
    await recordMutationAudit(ctx.store, {
      action: 'recording_created',
      actor: auth.user,
      resource: `recordings:${doc.id}`,
      before: null,
      after: doc,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, id: doc.id, item: doc });
  } catch (error) {
    context.error('createRecording failed:', errorFacts(error));
    return json(500, { error: 'Failed to create recording' });
  }
}

/** Route id, non-empty body and the stored recording of a PATCH: `{ id, updates }` or `{ error }` holding the response. */
async function prepareRecordingPatch(store, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body || Object.keys(body).length === 0) {
    return { error: json(400, { error: 'Body must be a non-empty JSON object' }) };
  }
  const existing = await store.readDoc('recordings', id, id);
  if (!existing) return { error: json(404, { error: `recording ${id} not found` }) };
  const checked = validateRecordingPatch(body);
  if (checked.error) return { error: json(400, { error: checked.error }) };
  return { id, updates: checked.updates, existing };
}

/** PATCH /api/cms/recordings/{id} — routing updates (status, contentId). */
async function patchRecording(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const prepared = await prepareRecordingPatch(ctx.store, request);
    if (prepared.error) return prepared.error;
    const updated = await ctx.store.patchDoc('recordings', prepared.id, prepared.updates);
    await recordMutationAudit(ctx.store, {
      action: 'recording_updated',
      actor: auth.user,
      resource: `recordings:${prepared.id}`,
      before: prepared.existing,
      after: updated,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, item: updated });
  } catch (error) {
    context.error('patchRecording failed:', errorFacts(error));
    return json(500, { error: 'Failed to update recording' });
  }
}

/** The recordings routes, over the shared `ctx`. */
export function createRecordingHandlers(ctx) {
  return {
    listRecordings: (request, context) => listRecordings(ctx, request, context),
    createRecording: (request, context) => createRecording(ctx, request, context),
    patchRecording: (request, context) => patchRecording(ctx, request, context),
  };
}
