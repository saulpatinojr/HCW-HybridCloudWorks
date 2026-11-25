/**
 * labs/visitor-routes.js — the visitor lab sessions' status and stop routes,
 * and the answers the start route shares with them (visitor-session.js has
 * the header that explains the sessions and builds the handlers).
 */

import { timingSafeEqual } from 'node:crypto';
import { CHECK_WINDOW_MS, turnstileConfigured } from './public-lock.js';
import {
  DOOR_CODES,
  DOOR_REASONS,
  HOLDING_STATUSES,
  holdsSlot,
  MAX_HOLDING_RECORDS,
  readBrokerConfig,
  readVisitorMaxConcurrent,
  RETRY_SWEEP_EVERY_MS,
  SESSION_CONTAINER,
  SESSION_STATUS,
  VISITOR_JOB_TYPE,
  VISITOR_SESSION_DURATION_MS,
  visitorSessionsEnabled,
} from './visitor-model.js';
import { claimable, endSession } from './visitor-end.js';
import { HOLDING_QUERY, reapExpiredVisitorSessions } from './visitor-reap.js';

/** What a session id looks like (a UUID today). Anything else cannot be one. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

export const RETRY_AFTER_WINDOW = { 'Retry-After': String(CHECK_WINDOW_MS / 1000) };

export function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

/** The same body public-submit.js gives an origin it cannot verify. */
export function forbidden() {
  return jsonResponse({ ok: false, code: 'FORBIDDEN', error: 'Forbidden' }, 403);
}

/** A refusal with one of the door's codes and its sentence. */
export function doorRefusal(code, status, headers) {
  return jsonResponse({ ok: false, code, reason: DOOR_REASONS[code] }, status, headers);
}

function tooManyReads(context) {
  context?.warn?.('visitor-session: refused a read: too many from one visitor');
  return jsonResponse(
    {
      ok: false,
      configured: true,
      open: false,
      code: DOOR_CODES.reads_rate_limited,
      reason: DOOR_REASONS[DOOR_CODES.reads_rate_limited],
    },
    429,
    RETRY_AFTER_WINDOW
  );
}

/**
 * Whether the routes are switched on and set up, in the order they are
 * checked: `{ code }` names why not, `{ config }` is the broker's settings.
 */
export function doorCheck(env) {
  if (!visitorSessionsEnabled(env)) return { code: DOOR_CODES.closed };
  if (!turnstileConfigured(env)) return { code: DOOR_CODES.turnstile_unconfigured };
  const config = readBrokerConfig(env);
  return config ? { config } : { code: DOOR_CODES.unconfigured };
}

/** The answer when the routes are off or not set up. */
export function doorShut(code, status) {
  return jsonResponse({ configured: false, open: false, code, reason: DOOR_REASONS[code] }, status);
}

/**
 * The sweep ends sessions past their hour and retries clean-ups Coder has not
 * yet confirmed. It lists them with queries, and any visitor can cause one
 * by asking for the status, so it runs at most once in RETRY_SWEEP_EVERY_MS
 * per worker. This one runs when someone visits. The timer
 * (functions/src/functions/visitor-session-sweep.js) runs it on its own
 * every two minutes once the owner arms it; this stays for the moments when
 * visitors are about and for a timer that is off. A claim keeps the two from
 * making a second set of Coder calls for one session.
 */
export function createRetrySweep() {
  let nextRetrySweepMs = 0;
  return {
    due: (nowMs) => nowMs >= nextRetrySweepMs,
    ran: (nowMs) => {
      nextRetrySweepMs = nowMs + RETRY_SWEEP_EVERY_MS;
    },
  };
}

/** The records that may hold a workspace slot (HOLDING_QUERY), or a throw from the store. */
export function listHolding(store) {
  return store.queryDocs(SESSION_CONTAINER, HOLDING_QUERY, [
    { name: '@top', value: MAX_HOLDING_RECORDS },
    { name: '@type', value: VISITOR_JOB_TYPE },
    { name: '@statuses', value: [...HOLDING_STATUSES] },
  ]);
}

/**
 * Do two client hashes name the same caller? Compared in constant time, on
 * their bytes: a stored value with multibyte characters has as many characters
 * as a hash and a different number of bytes, which timingSafeEqual refuses by
 * throwing, so the lengths are compared on the bytes first.
 */
export function sameClient(stored, presented) {
  if (typeof stored !== 'string' || typeof presented !== 'string' || stored === '') return false;
  const storedBytes = Buffer.from(stored);
  const presentedBytes = Buffer.from(presented);
  return storedBytes.length === presentedBytes.length && timingSafeEqual(storedBytes, presentedBytes);
}

/** Is this the caller's own running session? */
export function isCallersActive(session, clientHash) {
  return session.status === SESSION_STATUS.active && sameClient(session.clientHash, clientHash);
}

/** A session handed back to the visitor it belongs to. */
export function sessionAnswer(session, status = 200) {
  return jsonResponse({
    ok: true,
    sessionId: session.id,
    labId: session.labId,
    accessUrl: session.accessUrl,
    expiresAt: session.expiresAt,
  }, status);
}

/** The caller and the time, or the refusal when they cannot be verified or have read too often. */
function admitReader(deps, request, context) {
  const caller = deps.identify(request, context);
  if (!caller) return { refusal: forbidden() };
  const nowMs = deps.clock();
  // Before the query: a read in a loop must not become a query in a loop.
  if (!deps.readLimiter.take(caller.clientHash, nowMs)) return { refusal: tooManyReads(context) };
  return { clientHash: caller.clientHash, nowMs };
}

export async function getStatus(deps, request, context) {
  const door = doorCheck(process.env);
  if (!door.config) return doorShut(door.code);
  const reader = admitReader(deps, request, context);
  if (reader.refusal) return reader.refusal;
  const nowIso = new Date(reader.nowMs).toISOString();

  let holding = [];
  try {
    holding = await listHolding(deps.store);
  } catch {
    return jsonResponse({
      configured: true,
      open: false,
      code: DOOR_CODES.coder_unavailable,
      reason: DOOR_REASONS[DOOR_CODES.coder_unavailable],
    }, 503);
  }

  // Proactively reap any expired sessions, and retry any clean-up Coder has
  // not confirmed, in background
  if (deps.sweep.due(reader.nowMs)) {
    deps.sweep.ran(reader.nowMs);
    // No `log` here: this runs after the answer is sent, and a Functions
    // context must not be written to once its invocation has ended.
    reapExpiredVisitorSessions(deps.store, deps.fetchImpl, door.config, { nowIso }).catch(() => {});
  }
  return jsonResponse(statusBody(holding, reader.clientHash, nowIso));
}

/** The status code: the caller's own session, a full house, or open. */
function statusCode(mine, capacityReached) {
  if (mine) return DOOR_CODES.active_session_exists;
  return capacityReached ? DOOR_CODES.capacity_full : 'OPEN';
}

function statusBody(holding, clientHash, nowIso) {
  const slots = holding.filter((s) => holdsSlot(s, nowIso));
  // Only the caller's own session is ever described: its id and address
  // are what ends it or opens it, so they are not handed to anyone else.
  const myActiveSession = slots.find((s) => isCallersActive(s, clientHash));
  const maxConcurrent = readVisitorMaxConcurrent(process.env);
  const code = statusCode(myActiveSession, slots.length >= maxConcurrent);
  return {
    configured: true,
    open: code !== DOOR_CODES.capacity_full,
    code,
    reason: code === 'OPEN' ? 'Visitor lab session available.' : DOOR_REASONS[code],
    session: myActiveSession
      ? {
          id: myActiveSession.id,
          labId: myActiveSession.labId,
          accessUrl: myActiveSession.accessUrl,
          expiresAt: myActiveSession.expiresAt,
        }
      : null,
    bounds: {
      durationMinutes: Math.round(VISITOR_SESSION_DURATION_MS / 60000),
      maxConcurrent,
      activeCount: slots.length,
    },
  };
}

/**
 * `status: 'ended'` is what the pane has always been told; `cleanup` says
 * whether Coder has confirmed the lab is gone (#1403, item 7): `done`,
 * `pending` (it will be tried again) or `failed` (given up for now).
 */
const ended = (cleanup) => jsonResponse({ ok: true, status: 'ended', cleanup });

function cleanupOf(status) {
  if ([SESSION_STATUS.ended, SESSION_STATUS.expired].includes(status)) return 'done';
  return status === SESSION_STATUS.cleanupFailed ? 'failed' : 'pending';
}

/**
 * Someone else's session, a record that is not a visitor session, an id
 * that does not exist and text that cannot be an id all get the one
 * answer (null), so the route does not tell a caller which ids are live.
 * Holding the id is not enough to end it. The owner is checked before the
 * status, so a session that is already over is not revealed either.
 */
async function callersSession(store, sessionId, clientHash) {
  if (!SESSION_ID_SHAPE.test(sessionId)) return null;
  const doc = await store.readDoc(SESSION_CONTAINER, sessionId, sessionId);
  const theirs = doc && doc.type === VISITOR_JOB_TYPE && sameClient(doc.clientHash, clientHash);
  return theirs ? doc : null;
}

export async function stopSession(deps, request, context) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (!sessionId) {
    return jsonResponse({ ok: false, error: 'sessionId parameter required' }, 400);
  }
  const reader = admitReader(deps, request, context);
  if (reader.refusal) return reader.refusal;

  const doc = await callersSession(deps.store, sessionId, reader.clientHash);
  if (!doc) return jsonResponse({ ok: false, error: 'Session not found' }, 404);

  // Already over, or another request is cleaning it up, or it is waiting for
  // its next try: a second stop (a double click, a retry) has nothing to do,
  // and the answer is the same. A clean-up Coder has not confirmed whose
  // next try is due is tried again here, by whoever asks next.
  if (!claimable(doc, new Date(reader.nowMs).toISOString())) {
    return ended(cleanupOf(doc.status));
  }

  // Only the request that claims the record calls Coder; Coder's answer
  // decides whether the record is saved as ended or left to be retried, and
  // either way the visitor's End is answered as done.
  const { outcome, status } = await endSession(deps.store, deps.fetchImpl, readBrokerConfig(process.env), doc, {
    endStatus: SESSION_STATUS.ended,
    nowMs: reader.nowMs,
    log: (line) => context?.warn?.(line),
  });
  return stopAnswer(outcome, status);
}

function stopAnswer(outcome, status) {
  if (outcome === 'changed') {
    return jsonResponse(
      { ok: false, error: 'The session changed while it was being ended. Please try again.' },
      409
    );
  }
  if (outcome === 'done') return ended('done');
  if (outcome === 'given-up') return ended('failed');
  // Another request holds it: say what its record says. Otherwise (still
  // waiting, or the record aged out under us) the honest word is pending.
  return ended(status ? cleanupOf(status) : 'pending');
}
