/**
 * developer-api/call-routes.js — the route that opens or closes an
 * organizer's call for speakers (ADR 0042). handlers.js wires it through its
 * `route` and holds the header that says what it may write and log; the
 * write is create-only, or under the ETag of the call as it was read.
 */
import { CFS_CONTAINER, callDocId, composeCall, ownsCall, presentCall, validateCallChange } from './cfs.js';
import {
  Answer,
  CHANGED,
  NO_CALL,
  audit,
  eventIdOf,
  isConflict,
  json,
  notFound,
  readCall,
  readJson,
  readSnapshot,
} from './route-kit.js';

/**
 * The site's own published events are not an organizer's to claim: a call
 * on one would collect speakers' details under the owner's event.
 */
async function eventIdReserved(deps, eventId) {
  const snapshot = await readSnapshot(deps);
  return Array.isArray(snapshot?.items) && snapshot.items.some((item) => String(item?.id) === eventId);
}

/** The refusal for a call change this key may not make, or null. */
async function callChangeRefusal(deps, { eventId, existing, change, user }) {
  if (existing && !ownsCall(existing, user)) return notFound(NO_CALL);
  if (!existing && change.action === 'close') return notFound(NO_CALL);
  if (!existing && (await eventIdReserved(deps, eventId))) {
    return json(409, {
      ok: false,
      code: 'EVENT_ID_RESERVED',
      error: 'That event id belongs to one of the site\'s own events. Choose another id for your event.',
    });
  }
  return null;
}

/** Create the call, or replace it under the ETag it was read at; a lost race is the 409 answer. */
async function writeCall(deps, eventId, existing, next) {
  try {
    return existing
      ? await deps.store.replaceDocIfMatch(CFS_CONTAINER, { ...next, _etag: existing._etag }, { partitionKey: eventId })
      : await deps.store.createDoc(CFS_CONTAINER, next);
  } catch (error) {
    if (isConflict(error)) throw new Answer(json(409, { ok: false, code: 'CONFLICT', error: CHANGED }));
    throw error;
  }
}

/** POST events/{eventId}/call-for-speakers — cfs:manage. Opens or closes this key's call. */
export async function setCall(deps, request, context) {
  const auth = await deps.guard.requireScope(request, 'cfs:manage');
  if (auth.error) return auth.error;
  const eventId = eventIdOf(request);
  const change = validateCallChange(await readJson(request), deps.now());
  const existing = await readCall(deps, eventId);
  const refusal = await callChangeRefusal(deps, { eventId, existing, change, user: auth.user });
  if (refusal) return refusal;

  const nowIso = new Date(deps.now()).toISOString();
  const next = composeCall({ eventId, existing, change, user: auth.user, nowIso });
  const call = (await writeCall(deps, eventId, existing, next)) || next;
  await audit(deps, context, change.action === 'open' ? 'developer_cfs_opened' : 'developer_cfs_closed', auth.user, {
    resource: `${CFS_CONTAINER}:${callDocId(eventId)}`,
    before: existing ? presentCall(existing, deps.now()) : null,
    after: presentCall(call, deps.now()),
    details: { eventId },
  });
  return json(existing ? 200 : 201, { ok: true, call: presentCall(call, deps.now()) });
}
