/**
 * developer-api/proposal-intake.js — the one public write of the Developer
 * API v1 (ADR 0042): a speaker's proposal to an open call for speakers. Its
 * checks, in order, are in submitProposal's comment below; handlers.js wires
 * it through its `route` and holds the header that says what it may log.
 */
import { ORIGIN_NOT_VERIFIED } from '../auth/client-identity.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { enforceSubmissionQuota } from '../submissions.js';
import {
  CFS_CONTAINER,
  MAX_SUBMISSION_BYTES,
  SUBMISSIONS_PER_CALL_PER_HOUR,
  SUBMISSIONS_PER_CLIENT_PER_HOUR,
  callQuotaKey,
  clientQuotaKey,
  composeSubmission,
  isCallOpen,
  ownsCall,
  validateSubmission,
} from './cfs.js';
import { developerKeyFrom, isKeyId, isUsable, keyRecordId, looksLikeKey, scopesOf } from './keys.js';
import { Answer, NOT_OPEN, eventIdOf, json, notFound, readCall } from './route-kit.js';

const tooLarge = () =>
  json(413, {
    ok: false,
    code: 'TOO_LARGE',
    error: `The proposal is too large: at most ${MAX_SUBMISSION_BYTES} bytes.`,
  });

const limited = () =>
  json(429, { ok: false, code: 'RATE_LIMITED', error: 'Too many proposals. Try again later.' }, { 'Retry-After': '3600' });

/**
 * Is the key that owns this call still a working key? One point read of its
 * record, with no cache, the same read the guard makes: a key revoked a
 * moment ago is seen as revoked by the very next proposal.
 */
async function ownerKeyWorks(deps, call) {
  if (!isKeyId(call?.organizerKeyId)) return false;
  const record = await deps.store.readDoc('admin_config', keyRecordId(call.organizerKeyId), ADMIN_CONFIG_PARTITION);
  return isUsable(record);
}

/** One count against an hourly proposal limit; throws the 429 answer when it is over. */
async function countProposal(deps, quotaKey, nowMs, limit) {
  try {
    await enforceSubmissionQuota(deps.store, quotaKey, { now: nowMs, limit });
  } catch (error) {
    if (error?.code === 'SUBMISSION_RATE_LIMIT') throw new Answer(limited());
    throw error;
  }
}

/** The caller's anonymous key, from the Cloudflare-verified address; an unverified origin is the 403 answer. */
function clientHashOf(deps, request, context) {
  try {
    return deps.identity.anonymousKey(request).key;
  } catch (error) {
    if (error?.code !== ORIGIN_NOT_VERIFIED) throw error;
    context.warn?.('[developer-api] proposal refused: unverified origin');
    throw new Answer(json(403, { ok: false, code: 'FORBIDDEN', error: 'Forbidden' }));
  }
}

/**
 * The relay: the organizer a working key with `cfs:manage` speaks for, or
 * null. Only a value shaped like an organizer key is looked up, so an
 * anonymous request costs no key read; a wrong or revoked key is the
 * guard's 401.
 */
async function relayOf(deps, request) {
  if (!looksLikeKey(developerKeyFrom(request))) return null;
  const auth = await deps.guard.authenticate(request);
  if (auth.error) throw new Answer(auth.error);
  return scopesOf(auth.record).includes('cfs:manage') ? auth.user : null;
}

/** The proposal from the body, its bytes measured as read (the header can lie); too large or not JSON is answered. */
async function proposalOf(request) {
  const raw = typeof request.text === 'function' ? await request.text() : '';
  if (Buffer.byteLength(raw || '', 'utf8') > MAX_SUBMISSION_BYTES) throw new Answer(tooLarge());
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Answer(json(400, { ok: false, code: 'INVALID', error: 'The body must be valid JSON.' }));
  }
  return validateSubmission(body);
}

/**
 * The call the proposal is for, once it may be taken: the per-caller limit
 * (skipped for the call's own key), then an open call whose key still works.
 * A keyed request reads the call first, to learn whether the key owns it. An
 * anonymous one is counted first, as before, so a caller over the limit
 * costs no read of the call.
 */
async function openCallFor(deps, { eventId, relay, clientHash, nowMs }) {
  let call = relay ? await readCall(deps, eventId) : null;
  const ownerRelay = Boolean(relay) && ownsCall(call, relay);
  if (!ownerRelay) await countProposal(deps, clientQuotaKey(clientHash), nowMs, SUBMISSIONS_PER_CLIENT_PER_HOUR);

  if (!relay) call = await readCall(deps, eventId);
  if (!isCallOpen(call, nowMs)) throw new Answer(notFound(NOT_OPEN));
  if (!ownerRelay && !(await ownerKeyWorks(deps, call))) throw new Answer(notFound(NOT_OPEN));
  return call;
}

/**
 * POST events/{eventId}/call-for-speakers/submissions — public.
 * Origin verified (Cloudflare), body capped, then two limits: per caller
 * and per call, both hourly, through the same counter as public/submissions.
 *
 * THE ORGANIZER'S RELAY (#1754 review). A browser on the organizer's own
 * site cannot call this route (lib/auth/cors.js answers 403 to an Origin
 * that is not this site's), so the organizer's form posts to their own
 * server and that server sends the proposal on. Every proposal then comes
 * from one address, and the per-caller limit would hold a whole event to
 * five an hour. So a request that carries the key that OWNS this call,
 * with `cfs:manage`, skips the per-caller limit and no other check: the
 * origin check, the body cap, the open-call check and the per-call limit
 * all still apply. A request with no key is handled exactly as before. A
 * working key that does not own the call, or lacks the scope, gets no
 * favour and is counted like any visitor. A key that is wrong or revoked
 * is answered 401 by the guard, so a relay with a dead key finds out.
 *
 * A REVOKED KEY'S CALL TAKES NOTHING (#1777). A call belongs to the key
 * that opened it, and once that key is revoked nobody holds a key that
 * can list, review, delete or close what arrives. So an open call is only
 * open while its key still works: before a proposal is counted against
 * the call or stored, the owning key's record is read (one point read),
 * and a revoked or missing one is answered the same 404 as a closed call.
 * Checked on every proposal rather than by closing the calls at revoke
 * time, so there is no moment between the revoke and the close in which a
 * proposal can still land, and a failed close cannot leave a call open.
 * The owning key relaying its own form was authenticated a few lines up,
 * so that path costs no second read.
 */
export async function submitProposal(deps, request, context) {
  const clientHash = clientHashOf(deps, request, context);
  const eventId = eventIdOf(request);

  // What the client says the size is, before any of it is read. A client
  // can leave the header out or understate it, so the bytes are measured
  // again when the body is read.
  const declared = Number(request.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SUBMISSION_BYTES) return tooLarge();

  const relay = await relayOf(deps, request);
  const value = await proposalOf(request);

  const nowMs = deps.now();
  await openCallFor(deps, { eventId, relay, clientHash, nowMs });
  await countProposal(deps, callQuotaKey(eventId), nowMs, SUBMISSIONS_PER_CALL_PER_HOUR);

  const doc = composeSubmission({ eventId, value, id: deps.uuid(), nowIso: new Date(nowMs).toISOString() });
  await deps.store.createDoc(CFS_CONTAINER, doc);
  context.log?.('[developer-api] proposal accepted for review');
  return json(201, { ok: true, id: doc.id, status: 'pending' });
}
