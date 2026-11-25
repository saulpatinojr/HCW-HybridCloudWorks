/**
 * developer-api/route-kit.js — the pieces the Developer API v1 routes share
 * (handlers.js for the key status and the public reads, cfs-routes.js for the
 * call for speakers): the answer's shape, the sentences a refusal says, the
 * early answer a route throws, and the reads and audit row every
 * call-for-speakers route uses. handlers.js's header says what each route
 * may write and log.
 */
import { recordMutationAudit } from '../audit.js';
import { CFS_CONTAINER, callDocId, isEventId, ownsCall } from './cfs.js';

const PUBLIC_CACHE_SECONDS = 300;

export const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});
export const publicJson = (body) => json(200, body, { 'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}` });
export const notFound = (error) => json(404, { ok: false, code: 'NOT_FOUND', error });
export const NO_CALL = 'There is no call for speakers on this event for this key.';
export const NO_PROPOSAL = 'There is no such proposal on this event.';
export const NOT_OPEN = 'This event has no open call for speakers.';
export const STRIPPED =
  "This proposal's yearly cycle has ended and it was not accepted, so the speaker's details were removed and its decision can no longer change. It can still be listed and deleted.";
export const CHANGED = 'The record changed while this request was being made. Read it again and retry.';

/** Thrown inside a handler to answer with a ready response. */
export class Answer extends Error {
  constructor(response) {
    super('answered');
    this.response = response;
  }
}

export const isConflict = (error) => error?.code === 409 || error?.code === 412;

export const readSnapshot = (deps) => deps.publicStore.readDoc('_snapshots', 'speakerevents', 'speakerevents');
export const readCall = (deps, eventId) => deps.store.readDoc(CFS_CONTAINER, callDocId(eventId), eventId);

export function audit(deps, context, action, user, { resource, before = null, after = null, details = {} }) {
  return recordMutationAudit(deps.store, {
    action,
    actor: user,
    resource,
    before,
    after,
    details: { ...details, developerKeyId: user.developerKeyId },
    now: () => new Date(deps.now()),
    uuid: deps.uuid,
    context,
  });
}

export function eventIdOf(request) {
  const eventId = request.params?.eventId;
  if (!isEventId(eventId)) {
    throw new Answer(
      json(400, {
        ok: false,
        code: 'INVALID',
        error: 'The event id must be 3 to 80 lower-case letters, digits or hyphens.',
      }),
    );
  }
  return eventId;
}

/** The call this key owns on this event, or a 404 answer (the same one whether absent or another's). */
export async function ownedCall(deps, eventId, user) {
  const call = await readCall(deps, eventId);
  if (!ownsCall(call, user)) throw new Answer(notFound(NO_CALL));
  return call;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Answer(json(400, { ok: false, code: 'INVALID', error: 'The body must be valid JSON.' }));
  }
}
