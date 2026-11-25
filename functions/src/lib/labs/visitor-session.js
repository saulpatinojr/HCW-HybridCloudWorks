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

import { assertClientIdentity, ORIGIN_NOT_VERIFIED } from '../auth/client-identity.js';
import { createCheckLimiter } from './public-lock.js';
import { SESSION_CONTAINER, VISITOR_READS_PER_WINDOW } from './visitor-model.js';
import { createRetrySweep, getStatus, stopSession } from './visitor-routes.js';
import { startSession } from './visitor-start.js';

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
  const deps = {
    store,
    fetchImpl,
    clock,
    checkLimiter,
    readLimiter,
    sweep: createRetrySweep(),
    identify: (request, context) => identifyCaller(identity, request, context),
    saveOver,
  };
  return {
    async getStatus(request, context) {
      return getStatus(deps, request, context);
    },
    async startSession(request, context) {
      return startSession(deps, request, context);
    },
    async stopSession(request, context) {
      return stopSession(deps, request, context);
    },
  };
}
