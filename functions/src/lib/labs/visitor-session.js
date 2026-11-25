/**
 * Visitor lab sessions (#1016; ADR 0032 amendment).
 *
 * Owner decision 2026-10-08 and 2026-10-16: visitors who are not in the
 * HybridCloudWorks GitHub organisation obtain Coder labs through sessions the
 * site hands out. Coder itself stays restricted to that organisation
 * (CODER_OAUTH2_GITHUB_ALLOWED_ORGS: [HybridCloudWorks]), and sign-ups remain off.
 *
 * WHY BROKERED, NOT OPEN SIGN-IN:
 * Coder Community edition has no per-user quotas, forced auto-stop or dormancy.
 * Opening GitHub sign-in to everyone would let one visitor exhaust the host's
 * 5 workspace slots (violating ADR 0032 Decision 4). In addition, every lab
 * template enforces 1 running workspace per owner at plan time (LAB-8).
 * The site acts as broker, creating ephemeral per-session Coder users
 * (v-<random>) and workspaces, enforcing strict concurrency caps, Turnstile/origin
 * verification, daily quotas, and automated session reaping.
 *
 * WHO IS CALLING (#1387). Every route here is anonymous, so a session belongs
 * to the hashed Cloudflare-verified address the client identity helper
 * (auth/client-identity.js) gives, the same one the other anonymous routes use.
 * The start route files its daily quota and the new session under that hash,
 * and gives Turnstile the trusted address. The status route answers with the
 * caller's own session only, and the stop route ends a session only for the
 * caller it belongs to; any other caller is told the session is not found, the
 * same answer as an id that never existed. When the origin cannot be proved to
 * be our Cloudflare, these routes refuse (403 FORBIDDEN, before any read,
 * write or call to Turnstile or Coder): a quota counted on an address the
 * caller can choose is not a quota. They refuse whatever `NODE_ENV` says
 * (#1400, item 5): the helper itself lets an unproved origin through outside
 * production, which suits the other anonymous routes on a developer's machine
 * and not routes that hand out a lab and decide who may end it. People behind
 * one shared network address count as one visitor, as they do for every other
 * anonymous quota here.
 *
 * HOW OFTEN ONE VISITOR MAY ASK (#1400, item 2). Two limits held in memory,
 * per Function App instance, keyed on the caller's hash and checked before
 * anything is read: a start may ask Cloudflare's Turnstile at most
 * CHECK_ATTEMPTS_PER_WINDOW times in CHECK_WINDOW_MS (the lab submission's
 * limit, public-lock.js), and the status read and the stop share
 * VISITOR_READS_PER_WINDOW in the same window.
 *
 * WHAT IS SENT TO CODER, AND WHAT IS TRUSTED FROM A RECORD (#1403, the items
 * found while the timer was built). Every call to Coder refuses to follow a
 * redirect (`redirect: 'error'`): the broker token travels in a custom header
 * that `fetch` keeps on a redirect to another site, and the sweep now runs
 * unattended. A value read from a session record is written into a Coder path
 * only when it has the shape of what it claims to be: a Coder id is a UUID
 * (`CODER_ID_SHAPE`), a visitor's user name is `v-` and twelve hex characters
 * (`VISITOR_USERNAME_SHAPE`), and a workspace name is one of the lab names in
 * `VALID_LAB_WORKSPACES`. Before a user is deleted it is read back by its id,
 * and deleted only when Coder's answer is that id and a visitor's name. The
 * three queries on `lab_jobs` are bounded with `TOP`, and the sweep stops
 * taking up sessions before the claims it made can run out
 * (`SWEEP_DEADLINE_MS`).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { assertClientIdentity, ORIGIN_NOT_VERIFIED } from '../auth/client-identity.js';
import {
  CHECK_WINDOW_MS,
  createCheckLimiter,
  isSiteOrigin,
  LOCK_CODES,
  turnstileConfigured,
  turnstileSecret,
  verifyTurnstileToken,
  VISITOR_TURNSTILE_ACTION,
} from './public-lock.js';
import { utcDay } from '../cloud-tools/history.js';
import { takeDailyCap } from '../daily-cap.js';
import { recordLabStart, safeLogCode } from './lab-starts.js';
import {
  CLEANUP_RETRY_BASE_MS,
  DOOR_CODES,
  DOOR_REASONS,
  generateVisitorCredentials,
  HOLDING_STATUSES,
  holdsSlot,
  isCoderId,
  MAX_HOLDING_RECORDS,
  mayHoldLab,
  PROVISION_LEASE_MS,
  readBrokerConfig,
  readVisitorMaxConcurrent,
  RETRY_SWEEP_EVERY_MS,
  SESSION_CONTAINER,
  SESSION_STATUS,
  VALID_LAB_WORKSPACES,
  VISITOR_CHECK_REASONS,
  VISITOR_CLIENT_DAILY_LIMIT,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_JOB_TYPE,
  VISITOR_PENDING_DOC_TTL_SECONDS,
  VISITOR_READS_PER_WINDOW,
  VISITOR_SESSION_DURATION_MS,
  visitorSessionsEnabled,
} from './visitor-model.js';
import { createVisitorCoderUser, createVisitorWorkspace } from './visitor-coder.js';
import { claimable, endSession } from './visitor-end.js';
import { HOLDING_QUERY, reapExpiredVisitorSessions } from './visitor-reap.js';
import { releaseSlot, releaseStartLock, slotHolders, takeSlot, takeStartLock } from './visitor-slots.js';
import { countRefunds, DAILY_CAP_REFUND, recordRefund, refundOwed } from './visitor-refunds.js';

export {
  CLEANUP_LEASE_MS,
  CLEANUP_REARM_MS,
  CLEANUP_RETRY_BASE_MS,
  CODER_BROKER_TOKEN_SETTING,
  CODER_CALL_TIMEOUT_MS,
  CODER_CALLS_PER_SESSION,
  CODER_FETCH_OPTIONS,
  CODER_ID_SHAPE,
  CODER_PROVISION_TIMEOUT_MS,
  DEFAULT_VISITOR_MAX_CONCURRENT,
  DOOR_CODES,
  DOOR_REASONS,
  FINISH_ATTEMPTS,
  generateVisitorCredentials,
  givenUpForGood,
  HOLDING_STATUSES,
  holdsSlot,
  isCoderId,
  isLabWorkspaceName,
  isVisitorUsername,
  LAB_WORKSPACE_NAMES,
  lostRace,
  MAX_CLEANUP_ATTEMPTS,
  MAX_CLEANUP_ROUNDS,
  MAX_HOLDING_RECORDS,
  MAX_SWEEP_SESSIONS,
  mayHoldLab,
  PROVISION_LEASE_MS,
  readBrokerConfig,
  readVisitorMaxConcurrent,
  RETRY_SWEEP_EVERY_MS,
  SESSION_CONTAINER,
  SESSION_STATUS,
  SWEEP_DEADLINE_MS,
  TURNSTILE_SECRET_SETTING,
  USER_REFUSALS_BEFORE_WORKSPACE_RETRY,
  VALID_LAB_WORKSPACES,
  VISITOR_CHECK_REASONS,
  VISITOR_CLIENT_DAILY_LIMIT,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_FAILED_DOC_TTL_SECONDS,
  VISITOR_JOB_TYPE,
  VISITOR_MAX_CONCURRENT_SWITCH,
  VISITOR_PENDING_DOC_TTL_SECONDS,
  VISITOR_READS_PER_WINDOW,
  VISITOR_SESSION_DURATION_MS,
  VISITOR_SESSION_SWITCH,
  VISITOR_USERNAME_SHAPE,
  visitorSessionsEnabled,
} from './visitor-model.js';
export {
  coderDelete,
  coderInit,
  coderRefusal,
  coderTimeout,
  createVisitorCoderUser,
  createVisitorWorkspace,
  deleteUserCall,
  deleteVisitorUser,
  deleteVisitorWorkspace,
  deleteWorkspaceCall,
  getTemplateByName,
  hasSafeLookupNames,
  INVALID_ID,
  lookUpUserCall,
  lookUpWorkspaceCall,
  releaseBody,
} from './visitor-coder.js';
export {
  claimable,
  claimSession,
  cleanUpCoder,
  countOf,
  endSession,
} from './visitor-end.js';
export {
  DUE_QUERY,
  DUE_STATUSES,
  EXPIRED_QUERY,
  HOLDING_QUERY,
  reapExpiredVisitorSessions,
} from './visitor-reap.js';
export {
  isConflict,
  QUOTA_CONTAINER,
  releaseSlot,
  releaseStartLock,
  SLOT_PREFIX,
  SLOT_TTL_SECONDS,
  slotHolders,
  slotIsFree,
  START_LOCK_PREFIX,
  takeSlot,
  takeStartLock,
} from './visitor-slots.js';
export {
  countRefunds,
  DAILY_CAP_REFUND,
  recordRefund,
  REFUND_PREFIX,
  REFUND_QUERY,
  REFUND_TTL_SECONDS,
  refundOwed,
} from './visitor-refunds.js';

/**
 * What went wrong, for a log line: the error's code or its name, never its text,
 * and only when it is the shape of one: a three-digit status (`503`), a system
 * error code (`ECONNRESET`) or an error class (`TypeError`, `TimeoutError`).
 * Anything else, a host name or an id included, is just `error`.
 */
export function errorKind(error) {
  const kind = String(error?.code ?? error?.statusCode ?? error?.name ?? 'error');
  return /^\d{3}$|^E[A-Z0-9_]{2,30}$|^[A-Z][A-Za-z]{2,30}$/.test(kind) ? kind : 'error';
}

/**
 * Turn a start's `provisioning` record into a note for the sweep, when the
 * start failed after it was written: a `cleanup_pending` record carrying what
 * the sweep reads (the Coder user's name, its id when Coder gave one, the
 * workspace's name, and its id when Coder gave one) and the retry fields
 * (#1403, item 2). The first try waits CLEANUP_RETRY_BASE_MS so that a create
 * Coder is still finishing can finish. It drops `clientHash`: it was never
 * given to a visitor, so no stop request has to reach it, only the sweep. A
 * start that failed at the user (`noWorkspace`) never asked for a workspace,
 * so that half is saved as done: only the user is looked up, and the note
 * does not hold a lab slot while it waits. A user create that Coder refused
 * outright (`noUser`, a 4xx answer other than 408) made nothing at all, so
 * both halves are saved as done and nothing is looked up by name (#1464
 * review, finding F): a name Coder refused may be someone else's.
 *
 * Then the daily start is given back (`recordRefund`), and only once that is
 * written is the marker turned to `given`; a note with nothing left in Coder
 * is saved as over in the same write. When the refund or that write fails,
 * the note stays `cleanup_pending` with `dailyCapRefund: pending`, and the
 * sweep finishes it. It lets the slot go when the note holds no lab.
 *
 * Never throws: the visitor is being answered with a 502 whatever happens
 * here, and a store that is down must not turn that into something else. A
 * note that could not be written leaves the `provisioning` record, which the
 * sweep takes up once its lease has run out. The log says by kind what could
 * not be written, and nothing more.
 */
async function noteUnfinishedStart(
  store,
  provisioning,
  { user, workspaceId, noWorkspace = false, noUser = false, nowMs, context }
) {
  const nowIso = new Date(nowMs).toISOString();
  const { clientHash: _owner, ...record } = provisioning;
  const note = {
    ...record,
    status: SESSION_STATUS.cleanupPending,
    startFailed: true,
    ...(isCoderId(user?.id) ? { coderUserId: user.id } : {}),
    ...(typeof user?.username === 'string' && user.username ? { coderUsername: user.username } : {}),
    ...(isCoderId(workspaceId) ? { workspaceId } : {}),
    ...(noWorkspace || noUser ? { workspaceGone: true, workspaceConfirmedBy: 'never asked for' } : {}),
    ...(noUser ? { userGone: true, userConfirmedBy: 'refused at create' } : {}),
    endedAt: nowIso,
    cleanupAt: nowIso,
    retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
  const log = (line) => context?.error?.(line);
  let saved;
  try {
    saved = (await saveOver(store, note)) ?? note;
  } catch (error) {
    log(`visitor-session: a failed start could not be noted for clean-up (${errorKind(error)})`);
    return;
  }
  if (!mayHoldLab(note)) await releaseSlot(store, note, nowMs);
  if (!refundOwed(saved) || !(await recordRefund(store, saved, nowMs, log))) return;
  const { retryAt: _next, ...settled } = saved;
  const over = noUser ? { status: SESSION_STATUS.ended, ttl: VISITOR_DOC_TTL_SECONDS } : {};
  try {
    await saveOver(store, noUser ? { ...settled, ...over, dailyCapRefund: DAILY_CAP_REFUND.given } : { ...saved, dailyCapRefund: DAILY_CAP_REFUND.given });
  } catch {
    // The refund is written; the sweep sees `pending`, finds the refund there (409) and finishes.
  }
}

/**
 * Replace a record the caller holds (with the `_etag` it was read or written
 * with), or save it outright on a store without conditional writes. A 412
 * means another request (the sweep, after the lease) has taken the record,
 * and is thrown like any other failure.
 */
async function saveOver(store, record) {
  if (typeof store.replaceDocIfMatch === 'function') {
    return store.replaceDocIfMatch(SESSION_CONTAINER, record, { partitionKey: record.id });
  }
  await store.upsertDoc(SESSION_CONTAINER, record);
  return record;
}

/**
 * Who is calling: the hashed key their sessions and daily quota are filed
 * under, and the address Cloudflare's Turnstile is given.
 *
 * Both come from the real client identity helper, as public-submit.js reads
 * them. Three cases are refused, with a log line that names nothing:
 *  - `anonymousKey` throws ORIGIN_NOT_VERIFIED when the request cannot be shown
 *    to have come through our Cloudflare (and we are not in dev): the helper
 *    failing closed.
 *  - The helper let the request through without that proof (`trusted` is
 *    false), which it does whenever `NODE_ENV` is not `production`. These
 *    routes refuse it anyway (#1400, item 5), so a Function App that lost
 *    `NODE_ENV`, or a slot that never had it, still files nothing under an
 *    address the caller chose. A developer who wants to try the routes on
 *    their own machine sets `CF_ORIGIN_SECRET` there and sends the
 *    `x-hcw-origin-secret` and `CF-Connecting-IP` headers.
 *  - The request did present the Cloudflare secret but carries no usable
 *    client address (`trustedClientIp` is null). The helper would hash that to
 *    one shared "unknown" bucket, which is right for a rate limit and wrong
 *    for who owns a session: every such caller would read and end each
 *    other's, the old shared-"unidentified" fault under a new name.
 * Any other error is not a refusal but a bug (a TypeError from a method the
 * helper does not have is the very mistake in #1387), so it is thrown on,
 * where it shows up as a server error instead of a quiet "Forbidden".
 *
 * @param {{ anonymousKey: Function, trustedClientIp: Function }} identity
 * @param {object} request
 * @param {{ warn?: Function } | undefined} context
 * @returns {{ clientHash: string, clientIp: string | null } | null} null when refused
 */
function identifyCaller(identity, request, context) {
  const refused = () => {
    context?.warn?.('visitor-session: refused a request whose caller could not be verified');
    return null;
  };
  let key;
  try {
    key = identity.anonymousKey(request);
  } catch (error) {
    if (error?.code !== ORIGIN_NOT_VERIFIED) throw error;
    return refused();
  }
  if (key?.trusted !== true) return refused();
  const clientIp = identity.trustedClientIp(request);
  if (clientIp === null) return refused();
  return { clientHash: key.key, clientIp };
}

/**
 * Do two client hashes name the same caller? Compared in constant time, on
 * their bytes: a stored value with multibyte characters has as many characters
 * as a hash and a different number of bytes, which timingSafeEqual refuses by
 * throwing, so the lengths are compared on the bytes first.
 */
function sameClient(stored, presented) {
  if (typeof stored !== 'string' || typeof presented !== 'string' || stored === '') return false;
  const storedBytes = Buffer.from(stored);
  const presentedBytes = Buffer.from(presented);
  return storedBytes.length === presentedBytes.length && timingSafeEqual(storedBytes, presentedBytes);
}

/** What a session id looks like (a UUID today). Anything else cannot be one. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

export function createVisitorSessionHandlers({
  store,
  identity,
  fetchImpl = fetch,
  clock = () => Date.now(),
  // One of each per handler set, which is one per worker process
  // (labs-public-http.js builds the handlers once), so the limits are per
  // instance, as the lab submission's is (#1400, item 2).
  checkLimiter = createCheckLimiter(),
  readLimiter = createCheckLimiter({ limit: VISITOR_READS_PER_WINDOW }),
}) {
  // Not a stand-in: see assertClientIdentity (#1387).
  assertClientIdentity(identity);

  // The sweep ends sessions past their hour and retries clean-ups Coder has not
  // yet confirmed. It lists them with queries, and any visitor can cause one
  // by asking for the status, so it runs at most once in RETRY_SWEEP_EVERY_MS
  // per worker. This one runs when someone visits. The timer
  // (functions/src/functions/visitor-session-sweep.js) runs it on its own
  // every two minutes once the owner arms it; this stays for the moments when
  // visitors are about and for a timer that is off. A claim keeps the two from
  // making a second set of Coder calls for one session.
  let nextRetrySweepMs = 0;
  const retrySweepDue = (nowMs) => nowMs >= nextRetrySweepMs;
  const sweepRan = (nowMs) => {
    nextRetrySweepMs = nowMs + RETRY_SWEEP_EVERY_MS;
  };

  const jsonResponse = (body, status = 200, headers = {}) => ({
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  // The same body public-submit.js gives an origin it cannot verify.
  const forbidden = () => jsonResponse({ ok: false, code: 'FORBIDDEN', error: 'Forbidden' }, 403);
  const retryAfterWindow = { 'Retry-After': String(CHECK_WINDOW_MS / 1000) };
  const tooManyReads = (context) => {
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
      retryAfterWindow
    );
  };

  /** The records that may hold a workspace slot (HOLDING_QUERY), or a throw from the store. */
  const listHolding = () =>
    store.queryDocs(SESSION_CONTAINER, HOLDING_QUERY, [
      { name: '@top', value: MAX_HOLDING_RECORDS },
      { name: '@type', value: VISITOR_JOB_TYPE },
      { name: '@statuses', value: [...HOLDING_STATUSES] },
    ]);

  return {
    async getStatus(request, context) {
      const env = process.env;
      if (!visitorSessionsEnabled(env)) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.closed,
          reason: DOOR_REASONS[DOOR_CODES.closed],
        });
      }
      if (!turnstileConfigured(env)) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.turnstile_unconfigured,
          reason: DOOR_REASONS[DOOR_CODES.turnstile_unconfigured],
        });
      }
      const config = readBrokerConfig(env);
      if (!config) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.unconfigured,
          reason: DOOR_REASONS[DOOR_CODES.unconfigured],
        });
      }

      const caller = identifyCaller(identity, request, context);
      if (!caller) return forbidden();
      const { clientHash } = caller;
      const nowMs = clock();
      const nowIso = new Date(nowMs).toISOString();
      // Before the query: a read in a loop must not become a query in a loop.
      if (!readLimiter.take(clientHash, nowMs)) return tooManyReads(context);

      let holding = [];
      try {
        holding = await listHolding();
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
      if (retrySweepDue(nowMs)) {
        sweepRan(nowMs);
        // No `log` here: this runs after the answer is sent, and a Functions
        // context must not be written to once its invocation has ended.
        reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
      }

      const slots = holding.filter((s) => holdsSlot(s, nowIso));
      // Only the caller's own session is ever described: its id and address
      // are what ends it or opens it, so they are not handed to anyone else.
      const myActiveSession = slots.find(
        (s) => s.status === SESSION_STATUS.active && sameClient(s.clientHash, clientHash)
      );

      const maxConcurrent = readVisitorMaxConcurrent(env);
      const capacityReached = slots.length >= maxConcurrent;

      return jsonResponse({
        configured: true,
        open: !capacityReached || Boolean(myActiveSession),
        code: myActiveSession
          ? DOOR_CODES.active_session_exists
          : capacityReached
          ? DOOR_CODES.capacity_full
          : 'OPEN',
        reason: myActiveSession
          ? DOOR_REASONS[DOOR_CODES.active_session_exists]
          : capacityReached
          ? DOOR_REASONS[DOOR_CODES.capacity_full]
          : 'Visitor lab session available.',
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
      });
    },

    async startSession(request, context) {
      const env = process.env;
      if (!visitorSessionsEnabled(env)) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.closed,
          reason: DOOR_REASONS[DOOR_CODES.closed],
        }, 503);
      }
      if (!turnstileConfigured(env)) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.turnstile_unconfigured,
          reason: DOOR_REASONS[DOOR_CODES.turnstile_unconfigured],
        }, 503);
      }
      const config = readBrokerConfig(env);
      if (!config) {
        return jsonResponse({
          configured: false,
          open: false,
          code: DOOR_CODES.unconfigured,
          reason: DOOR_REASONS[DOOR_CODES.unconfigured],
        }, 503);
      }

      // Origin check
      const origin = request.headers.get('origin');
      if (!isSiteOrigin(origin)) {
        return jsonResponse({
          ok: false,
          code: 'ORIGIN_NOT_ALLOWED',
          reason: 'Visitor sessions are permitted only from the site.',
        }, 403);
      }

      // Parse body
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Malformed JSON body' }, 400);
      }

      const { labId, turnstileToken } = body || {};
      if (typeof labId !== 'string' || !Object.hasOwn(VALID_LAB_WORKSPACES, labId)) {
        return jsonResponse({
          ok: false,
          code: DOOR_CODES.invalid_lab,
          reason: DOOR_REASONS[DOOR_CODES.invalid_lab],
        }, 400);
      }

      if (!turnstileToken || typeof turnstileToken !== 'string') {
        return jsonResponse({
          ok: false,
          code: 'TURNSTILE_REQUIRED',
          reason: 'Turnstile verification token is required.',
        }, 403);
      }

      const caller = identifyCaller(identity, request, context);
      if (!caller) return forbidden();
      const { clientHash, clientIp } = caller;
      const nowMs = clock();
      const nowIso = new Date(nowMs).toISOString();

      // At most CHECK_ATTEMPTS_PER_WINDOW calls to Cloudflare per visitor per
      // instance, before any is made (#1400, item 2; public-submit.js does the same).
      if (!checkLimiter.take(clientHash, nowMs)) {
        context?.warn?.('visitor-session: refused a start: too many human verification checks from one visitor');
        return jsonResponse(
          { ok: false, code: LOCK_CODES.attempts, reason: VISITOR_CHECK_REASONS[LOCK_CODES.attempts] },
          429,
          retryAfterWindow
        );
      }

      // Verify Turnstile
      const verification = await verifyTurnstileToken({
        fetch: fetchImpl,
        secret: turnstileSecret(env),
        token: turnstileToken,
        remoteIp: clientIp,
        action: VISITOR_TURNSTILE_ACTION,
      });

      if (!verification.ok) {
        // Why goes to the log; the visitor gets a plain sentence of their own. The detail
        // can carry Cloudflare's error codes, such as `missing-input-secret`,
        // which tell an anonymous caller how the site is set up (#1400, item 3).
        context?.warn?.(`visitor-session: refused a start by the human verification check: ${verification.detail}`);
        const unavailable = verification.kind === 'unavailable';
        const code = unavailable ? LOCK_CODES.unavailable : LOCK_CODES.failed;
        return jsonResponse(
          { ok: false, code, reason: VISITOR_CHECK_REASONS[code] },
          unavailable ? 503 : 403,
          unavailable ? { 'Retry-After': '60' } : {}
        );
      }

      // Check active concurrency
      let holding = await listHolding();
      // Reclaim capacity from expired sessions (and, on the way, retry any
      // clean-up Coder has not confirmed). Waited for only when a session is
      // past its hour, so its log lines can be written; a retry alone runs
      // behind the answer, without a log, as the status route's does.
      const expired = holding.filter((s) => s.status === SESSION_STATUS.active && s.expiresAt <= nowIso);
      if (retrySweepDue(nowMs)) {
        sweepRan(nowMs);
        if (expired.length > 0) {
          await reapExpiredVisitorSessions(store, fetchImpl, config, {
            nowIso,
            log: (line) => context?.warn?.(line),
          }).catch(() => {});
          // The sweep changed what holds a lab: a session whose delete Coder
          // refused is now waiting, and still holds one, so the list is read
          // again rather than trusted from before the sweep (#1464 review, finding B).
          holding = await listHolding();
        } else {
          reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
        }
      }

      // The caller's own running session is handed back, and costs nothing:
      // a reload and a second press of start are the same visitor's one lab
      // (#1400, item 1).
      const slots = holding.filter((s) => holdsSlot(s, nowIso));
      const existing = slots.find(
        (s) => s.status === SESSION_STATUS.active && sameClient(s.clientHash, clientHash)
      );
      if (existing) {
        return jsonResponse({
          ok: true,
          sessionId: existing.id,
          labId: existing.labId,
          accessUrl: existing.accessUrl,
          expiresAt: existing.expiresAt,
        }, 200);
      }

      const maxConcurrent = readVisitorMaxConcurrent(env);
      const full = () =>
        jsonResponse({
          ok: false,
          code: DOOR_CODES.capacity_full,
          reason: DOOR_REASONS[DOOR_CODES.capacity_full],
        }, 503);
      if (slots.length >= maxConcurrent) return full();

      // From here a new lab may be made, and two requests could get here at
      // the same moment, each having read the same list. Two creates that
      // Cosmos refuses with 409 when the id is taken make it safe (#1464
      // review, finding A): the visitor's start lock (one start at a time per
      // visitor) and a slot (one per lab the visitors may hold at once).
      const sessionId = randomUUID();
      // Everything a start does while it holds the visitor's lock.
      const startHoldingLock = async () => {
        // Read again now that no other start of this visitor's can run (#1464
        // review, round 2): a start that finished between the first read and
        // this lock has made the caller's session, which is handed back.
        const fresh = await listHolding();
        const mineNow = fresh.find(
          (s) => s.status === SESSION_STATUS.active && s.expiresAt > nowIso && sameClient(s.clientHash, clientHash)
        );
        if (mineNow) {
          return jsonResponse({
            ok: true,
            sessionId: mineNow.id,
            labId: mineNow.labId,
            accessUrl: mineNow.accessUrl,
            expiresAt: mineNow.expiresAt,
          }, 200);
        }
        // The limit holds because every holder owns one of the `max` slot
        // documents, and a slot is taken only by a create or a conditional
        // replace that one request can win (#1464 review, rounds 2 and 3).
        // A holder is a record that may still hold a lab (`mayHoldLab`: past
        // its hour included, until its clean-up is confirmed), or a start that
        // has taken its slot and not yet written its record (a young slot
        // whose holder cannot be seen, which `slotIsFree` never takes over).
        //
        // Every holding record counts, whatever slot it has or has not.
        const holders = fresh.filter(mayHoldLab);
        if (holders.length >= maxConcurrent) return full();
        // A holding record that no slot names (one saved before slots
        // existed, or one whose slot was lost) gets one first. Only then does
        // this start take its own, so it can never use a slot a record is
        // still counting on, at any index. If one cannot be given a slot,
        // the lab is full.
        const named = await slotHolders(store, maxConcurrent);
        for (const holder of holders) {
          if (named.has(holder.id)) continue;
          if ((await takeSlot(store, holder.id, maxConcurrent, nowMs)) === null) return full();
          named.add(holder.id);
        }
        const slot = await takeSlot(store, sessionId, maxConcurrent, nowMs);
        if (slot === null) return full();
        const letSlotGo = () => releaseSlot(store, { id: sessionId, slot }, clock());

        // Only now is a new lab really going to be made, so only now is one of
        // the visitor's daily starts taken (#1400, item 1). A start that then
        // fails gives it back with a refund document, which raises the limit
        // by one for that counter (`recordRefund`, `countRefunds`).
        const day = utcDay(nowMs);
        const quota = { container: 'submission_quota', id: `visitor-quota:${clientHash}:${day}` };
        let allowed;
        try {
          const refunds = await countRefunds(store, quota.id);
          allowed = await takeDailyCap(store, {
            ...quota,
            kind: 'visitor_session_daily',
            day,
            nowIso,
            limit: VISITOR_CLIENT_DAILY_LIMIT + refunds,
            ttlSeconds: 86400 * 2,
          });
        } catch (error) {
          await letSlotGo();
          throw error;
        }
        if (!allowed) {
          await letSlotGo();
          return jsonResponse({
            ok: false,
            code: DOOR_CODES.client_rate_limited,
            reason: DOOR_REASONS[DOOR_CODES.client_rate_limited],
          }, 429);
        }

        // The record comes first, before Coder is asked for anything, so that
        // whatever Coder makes has a record the sweep can find (#1403, item 2).
        const creds = generateVisitorCredentials();
        const workspaceName = VALID_LAB_WORKSPACES[labId];
        const provisioning = {
          id: sessionId,
          type: VISITOR_JOB_TYPE,
          status: SESSION_STATUS.provisioning,
          endStatus: SESSION_STATUS.ended,
          clientHash,
          labId,
          coderUsername: creds.username,
          workspaceName,
          slot,
          dailyCap: quota,
          dailyCapRefund: DAILY_CAP_REFUND.pending,
          createdAt: nowIso,
          cleanupAttempts: 0,
          workspaceGone: false,
          userGone: false,
          retryAt: new Date(nowMs + PROVISION_LEASE_MS).toISOString(),
          ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
        };
        let held;
        try {
          held = (await store.createDoc(SESSION_CONTAINER, provisioning)) ?? provisioning;
        } catch (error) {
          // Nothing was asked of Coder, so there is nothing to clean up, and
          // the start is given back. The refund is one document per session,
          // so if the record was written after all (a timeout, a 5xx), the
          // sweep's own give-back for it finds this refund and adds none. The
          // slot is let go only when the store plainly refused the write (a
          // 4xx other than 408); otherwise the record may hold it, and a slot
          // whose record never appears is taken over after its lease.
          context?.error?.(`visitor-session: a start could not be recorded (${errorKind(error)})`);
          await recordRefund(store, provisioning, nowMs, (line) => context?.error?.(line));
          const status = Number(error?.code ?? error?.statusCode);
          if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
            await letSlotGo();
          }
          return jsonResponse({
            ok: false,
            code: DOOR_CODES.coder_unavailable,
            reason: DOOR_REASONS[DOOR_CODES.coder_unavailable],
          }, 503);
        }

        const failed = async (step, error, { user, workspaceId, noWorkspace, noUser } = {}) => {
          // The step and the kind only: never Coder's text (#1403, item 9).
          context?.error?.(`visitor-session: a start failed at ${step} (${errorKind(error)})`);
          await noteUnfinishedStart(store, held, { user, workspaceId, noWorkspace, noUser, nowMs: clock(), context });
          return jsonResponse({
            ok: false,
            code: DOOR_CODES.coder_unavailable,
            reason: DOOR_REASONS[DOOR_CODES.coder_unavailable],
          }, 502);
        };

        // Provision ephemeral Coder user & workspace
        let user;
        try {
          user = await createVisitorCoderUser(fetchImpl, config, creds);
        } catch (error) {
          // The workspace is asked for only once the user exists, so there is
          // none. A plain refusal (a 4xx answer) made no user either, so the
          // name is never looked up: it may be someone else's (finding F).
          // No answer, a 5xx, or a 408 (Coder timed the request out, and may
          // have made the user anyway; round 2) may have made one, so it is
          // looked up.
          const status = error?.statusCode;
          const refused = Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
          return failed('the Coder user', error, { noWorkspace: true, noUser: refused });
        }
        let workspaceInfo;
        try {
          workspaceInfo = await createVisitorWorkspace(fetchImpl, config, {
            userId: user.id,
            username: user.username,
            workspaceName,
            labId,
          });
        } catch (error) {
          return failed('the workspace', error, { user });
        }

        const expiresAtIso = new Date(nowMs + VISITOR_SESSION_DURATION_MS).toISOString();
        const doc = {
          id: sessionId,
          type: VISITOR_JOB_TYPE,
          status: SESSION_STATUS.active,
          clientHash,
          labId,
          coderUserId: user.id,
          coderUsername: user.username,
          workspaceId: workspaceInfo.workspace.id,
          workspaceName,
          accessUrl: workspaceInfo.accessUrl,
          slot,
          dailyCap: quota,
          dailyCapRefund: DAILY_CAP_REFUND.spent,
          createdAt: nowIso,
          expiresAt: expiresAtIso,
          ttl: VISITOR_DOC_TTL_SECONDS,
          ...(held?._etag ? { _etag: held._etag } : {}),
        };

        try {
          await saveOver(store, doc);
        } catch (error) {
          // Both Coder calls worked and the session could not be saved: the
          // visitor is told nothing ran, and the note gives the sweep both ids
          // (#1403, item 2). A 412 means the sweep has already taken the record
          // (the lease ran out), and the note is refused the same way; either
          // way the sweep has what it needs.
          return failed('saving the session', error, { user, workspaceId: workspaceInfo.workspace?.id });
        }

        // The start is real from here: count it, once, as plain per-lab-per-day
        // numbers (lab-starts.js). The day is read from a fresh clock reading,
        // not from `nowMs` above: Turnstile and the Coder calls took time, and a
        // start that finished after UTC midnight belongs to the new day. The
        // session's own timestamps stay as they were. A counter fault is logged
        // by code only and never reaches the visitor, whose session already
        // exists.
        try {
          const counted = await recordLabStart(store, { labId, nowMs: clock() });
          if (!counted.counted) {
            context?.error?.(`visitor-session: lab start not counted (${counted.reason})`);
          }
        } catch (err) {
          context?.error?.(`visitor-session: lab start not counted (${safeLogCode(err)})`);
        }

        return jsonResponse({
          ok: true,
          sessionId,
          labId,
          accessUrl: workspaceInfo.accessUrl,
          expiresAt: expiresAtIso,
        }, 201);
      };

      const lock = await takeStartLock(store, clientHash, sessionId, nowMs);
      if (!lock) {
        return jsonResponse({
          ok: false,
          code: DOOR_CODES.start_in_progress,
          reason: DOOR_REASONS[DOOR_CODES.start_in_progress],
        }, 409, { 'Retry-After': '30' });
      }
      const released = async () => releaseStartLock(store, lock, clock());
      try {
        return await startHoldingLock();
      } finally {
        await released();
      }
    },

    async stopSession(request, context) {
      const env = process.env;
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return jsonResponse({ ok: false, error: 'sessionId parameter required' }, 400);
      }

      const caller = identifyCaller(identity, request, context);
      if (!caller) return forbidden();
      const nowMs = clock();
      if (!readLimiter.take(caller.clientHash, nowMs)) return tooManyReads(context);

      // Someone else's session, a record that is not a visitor session, an id
      // that does not exist and text that cannot be an id all get the one
      // answer, so the route does not tell a caller which ids are live.
      // Holding the id is not enough to end it. The owner is checked before the
      // status, so a session that is already over is not revealed either.
      const notFound = () => jsonResponse({ ok: false, error: 'Session not found' }, 404);
      if (!SESSION_ID_SHAPE.test(sessionId)) return notFound();
      const doc = await store.readDoc(SESSION_CONTAINER, sessionId, sessionId);
      if (!doc || doc.type !== VISITOR_JOB_TYPE || !sameClient(doc.clientHash, caller.clientHash)) {
        return notFound();
      }

      // `status: 'ended'` is what the pane has always been told; `cleanup` says
      // whether Coder has confirmed the lab is gone (#1403, item 7): `done`,
      // `pending` (it will be tried again) or `failed` (given up for now).
      const ended = (cleanup) => jsonResponse({ ok: true, status: 'ended', cleanup });
      const cleanupOf = (status) =>
        [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(status)
          ? 'done'
          : status === SESSION_STATUS.cleanupFailed
          ? 'failed'
          : 'pending';

      // Already over, or another request is cleaning it up, or it is waiting for
      // its next try: a second stop (a double click, a retry) has nothing to do,
      // and the answer is the same. A clean-up Coder has not confirmed whose
      // next try is due is tried again here, by whoever asks next.
      if (!claimable(doc, new Date(nowMs).toISOString())) {
        return ended(cleanupOf(doc.status));
      }

      // Only the request that claims the record calls Coder; Coder's answer
      // decides whether the record is saved as ended or left to be retried, and
      // either way the visitor's End is answered as done.
      const { outcome, status } = await endSession(store, fetchImpl, readBrokerConfig(env), doc, {
        endStatus: SESSION_STATUS.ended,
        nowMs,
        log: (line) => context?.warn?.(line),
      });
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
    },
  };
}
