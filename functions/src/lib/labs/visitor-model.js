/**
 * labs/visitor-model.js — the visitor lab sessions' settings, limits,
 * statuses and record shapes (visitor-session.js has the header that
 * explains the sessions). Pure; visitor-session.js re-exports what callers
 * use.
 */
import { randomBytes } from 'node:crypto';
import { resolvedSetting } from '../auth/client-identity.js';
import { LOCK_CODES } from './public-lock.js';
import { readCoderConfig } from './coder-status.js';

export const VISITOR_SESSION_SWITCH = 'LABS_VISITOR_SESSIONS_ENABLED';
export const VISITOR_MAX_CONCURRENT_SWITCH = 'LABS_VISITOR_MAX_CONCURRENT';
export const CODER_BROKER_TOKEN_SETTING = 'CODER_BROKER_TOKEN';
export const TURNSTILE_SECRET_SETTING = 'TURNSTILE_SECRET_KEY';

export const DEFAULT_VISITOR_MAX_CONCURRENT = 2;
export const VISITOR_SESSION_DURATION_MS = 60 * 60 * 1000; // 60 minutes
export const VISITOR_CLIENT_DAILY_LIMIT = 2;
export const VISITOR_JOB_TYPE = 'visitor-session';
export const VISITOR_DOC_TTL_SECONDS = 7200; // 2 hours
/**
 * Status reads and stops one visitor may make per instance in CHECK_WINDOW_MS
 * (ten minutes). The pane reads the status once when it opens, so sixty is
 * far above what a person needs, and still bounds a script that reads in a
 * loop: each read is a query over every session that holds a lab.
 */
export const VISITOR_READS_PER_WINDOW = 60;
/** The shape of the Coder user names the broker makes (`generateVisitorCredentials`). */
export const VISITOR_USERNAME_SHAPE = /^v-[0-9a-f]{12}$/;
/**
 * The shape of a Coder id, a UUID: Coder's users and workspaces have one each,
 * and nothing that is not one is written into a Coder path as an id (#1403).
 */
export const CODER_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this value plainly a Coder id (a UUID)? Anything else, `me` included, is not. */
export function isCoderId(value) {
  return typeof value === 'string' && CODER_ID_SHAPE.test(value);
}

/** Is this value plainly one of the broker's own user names? */
export function isVisitorUsername(value) {
  return typeof value === 'string' && VISITOR_USERNAME_SHAPE.test(value);
}

/** Is this value one of the workspace names the broker makes (`VALID_LAB_WORKSPACES`)? */
export function isLabWorkspaceName(value) {
  return typeof value === 'string' && LAB_WORKSPACE_NAMES.has(value);
}

/**
 * How every call to Coder is made: a redirect is a failure, never followed.
 * `fetch` keeps a custom header such as `Coder-Session-Token` on a redirect
 * to another site, so a Coder address that answered with one would send the
 * broker token wherever it pointed (#1403; coder-status.js does the same).
 */
export const CODER_FETCH_OPTIONS = Object.freeze({ redirect: 'error' });

export const VALID_LAB_WORKSPACES = Object.freeze({
  'landing-zone-builder-output': 'lab-lzb',
  'terraform-validate-walkthrough': 'lab-tfv',
  'ansible-syntax-check-walkthrough': 'lab-asc',
  'wsl-containers-walkthrough': 'lab-wslc',
  'defender-wsl-plugin-walkthrough': 'lab-dwsl',
  'aws-transit-gateway-walkthrough': 'lab-tgw',
  'gcp-shared-vpc-walkthrough': 'lab-gsvpc',
  'vmware-hcx-migration-walkthrough': 'lab-hcx',
  'docker-sandbox-agent-walkthrough': 'lab-dsba',
});
export const LAB_WORKSPACE_NAMES = new Set(Object.values(VALID_LAB_WORKSPACES));

export const DOOR_CODES = Object.freeze({
  closed: 'VISITOR_SESSIONS_CLOSED',
  unconfigured: 'VISITOR_NOT_CONFIGURED',
  turnstile_unconfigured: 'TURNSTILE_NOT_CONFIGURED',
  coder_unavailable: 'CODER_UNAVAILABLE',
  capacity_full: 'LAB_CAPACITY_REACHED',
  client_rate_limited: 'VISITOR_RATE_LIMITED',
  active_session_exists: 'ACTIVE_SESSION_EXISTS',
  invalid_lab: 'INVALID_LAB_ID',
  reads_rate_limited: 'VISITOR_READS_RATE_LIMITED',
  start_in_progress: 'VISITOR_START_IN_PROGRESS',
});

export const DOOR_REASONS = Object.freeze({
  [DOOR_CODES.closed]: 'Visitor lab sessions are not available right now.',
  [DOOR_CODES.unconfigured]: 'Visitor lab sessions are not available right now.',
  [DOOR_CODES.turnstile_unconfigured]: 'Visitor lab sessions are not available right now.',
  [DOOR_CODES.coder_unavailable]: 'The lab workspace environment is currently unreachable. Please try again shortly.',
  [DOOR_CODES.capacity_full]:
    'The lab is currently at full capacity (visitor limit reached). Please try again in a few minutes, or sign in if you are a team member.',
  [DOOR_CODES.client_rate_limited]:
    'You have reached your visitor lab session limit for today. Please try again tomorrow, or sign in with GitHub.',
  [DOOR_CODES.active_session_exists]: 'You already have an active visitor lab session running.',
  [DOOR_CODES.invalid_lab]: 'The requested lab is not recognized.',
  [DOOR_CODES.reads_rate_limited]:
    'Too many requests from this browser in the last few minutes. Try again in about ten minutes.',
  [DOOR_CODES.start_in_progress]: 'Your visitor lab session is still being set up. Please wait a moment.',
});

/**
 * What a visitor reads when a start is refused by the human verification
 * check, by its code (the lab submission's codes, `LOCK_CODES` in
 * public-lock.js). These are the visitor session's own sentences: the lab
 * submission's speak of validating a job (#1464 review, finding H). They name
 * no vendor and no setting, and the reason for a refusal goes to the log only
 * (#1400, item 3).
 */
export const VISITOR_CHECK_REASONS = Object.freeze({
  [LOCK_CODES.attempts]:
    'Too many attempts to start a lab from this browser in the last few minutes. Try again in about ten minutes.',
  [LOCK_CODES.failed]: "The browser check didn't pass, so no lab was started. Try again.",
  [LOCK_CODES.unavailable]: "The browser check couldn't be completed just now, so no lab was started. Try again in a minute.",
});

export function visitorSessionsEnabled(env = process.env) {
  return env?.[VISITOR_SESSION_SWITCH] === 'true';
}

export function readVisitorMaxConcurrent(env = process.env) {
  const val = Number.parseInt(env?.[VISITOR_MAX_CONCURRENT_SWITCH], 10);
  return Number.isInteger(val) && val > 0 ? val : DEFAULT_VISITOR_MAX_CONCURRENT;
}

/**
 * Coder's address and the BROKER token, or null when either is missing. There is
 * no fallback to the read-only status token (`CODER_STATUS_TOKEN`): it holds
 * only `template:read` and `workspace:read`, so a broker built on it would be
 * refused at every create and every delete, and each refused clean-up try would
 * be spent (five end a session as `cleanup_failed`). Without the broker token the
 * broker is not configured, and the callers say so.
 */
export function readBrokerConfig(env = process.env) {
  const coderConfig = readCoderConfig(env);
  if (!coderConfig) return null;
  const brokerToken = resolvedSetting(env?.[CODER_BROKER_TOKEN_SETTING]);
  if (!brokerToken) return null;
  return {
    base: coderConfig.base,
    token: brokerToken,
    max: coderConfig.max,
  };
}

export function generateVisitorCredentials() {
  const suffix = randomBytes(6).toString('hex');
  const username = `v-${suffix}`;
  const cred = ['P#', randomBytes(24).toString('base64url'), '!9'].join('');
  const email = `${username}@visitor.lab.hybridcloudworks.com`;
  return { username, password: cred, email };
}


export const SESSION_CONTAINER = 'lab_jobs';

/**
 * A session's life, in `status` (#1388, #1403).
 *
 *   provisioning ──Coder made both──▶ active ──claim──▶ ending ──both Coder deletes confirmed──▶ ended | expired
 *        │                                                │
 *        └─ the start failed ─▶ cleanup_pending ◀── Coder has not confirmed yet
 *                                     │      ▲
 *                                     │      └─ retry ─▶ ending ...
 *              MAX_CLEANUP_ATTEMPTS tries used ─▶ cleanup_failed ── an hour later, up to MAX_CLEANUP_ROUNDS times ─▶ ending ...
 *
 * `provisioning` is written BEFORE the first Coder call of a start (#1403,
 * item 2), so that whatever Coder makes, even for a call that never answers,
 * has a record the sweep can find. It carries the visitor's Coder user name,
 * which the broker chose, and the workspace's name; the ids come later. A
 * start that fails turns it into `cleanup_pending` (`startFailed`) at once,
 * and one whose process died is taken up by the sweep once its lease
 * (PROVISION_LEASE_MS) has run out.
 *
 * `ended` (the visitor pressed End) and `expired` (the sweep found it past its
 * hour) are saved only once Coder has confirmed that the workspace and the
 * user are gone. Until then the record keeps the ids it needs to try again, and
 * says which half is done (`workspaceGone`, `userGone`), so a retry does not
 * ask Coder to delete a workspace twice.
 *
 * Why a session so often waits: Coder deletes a workspace by starting a build
 * that finishes later, and refuses to delete a user who still has workspaces
 * (HTTP 417), so the user delete straight after an accepted workspace delete
 * is refused for most sessions. That is the normal case, not a fault, and the
 * retry is what finishes it.
 *
 * Which delete confirmed each half is kept too (`workspaceConfirmedBy`,
 * `userConfirmedBy`, #1403 item 4): `ok` (Coder accepted the delete), `gone`
 * (Coder answered 404 or 410), or `not found` (a lookup by name found
 * nothing). A 404 is also what Coder may answer a token that is not allowed to
 * see the thing, so a record finished on `gone` is worth a second look when
 * the broker token's permissions are in doubt.
 */
export const SESSION_STATUS = Object.freeze({
  provisioning: 'provisioning',
  active: 'active',
  ending: 'ending',
  cleanupPending: 'cleanup_pending',
  ended: 'ended',
  expired: 'expired',
  cleanupFailed: 'cleanup_failed',
});

/** Tries at a clean-up in one round before it is given up for the round (`cleanup_failed`). */
export const MAX_CLEANUP_ATTEMPTS = 5;
/**
 * A given-up record is tried again, a new round of MAX_CLEANUP_ATTEMPTS tries,
 * this long after it was given up (#1403, item 3): Coder may simply have been
 * down for longer than one round lasts (about twenty minutes).
 */
export const CLEANUP_REARM_MS = 60 * 60 * 1000;
/** Rounds after the first; after them the record is left for a person (see the runbook) until it ages out. */
export const MAX_CLEANUP_ROUNDS = 24;
/**
 * After this many user deletes in a row that Coder refused with 417 (the user
 * still has a workspace), the next try asks for the workspace delete again
 * (#1403, item 3). An accepted workspace delete only means a delete build was
 * queued; if that build failed, asking for the user forever cannot succeed.
 * Coder answers 409 to a workspace delete while a build is still running,
 * which is harmless and counted as not confirmed.
 */
export const USER_REFUSALS_BEFORE_WORKSPACE_RETRY = 3;
/**
 * How long a `provisioning` record is left alone before the sweep takes it as
 * a start whose process died: longer than the four provisioning calls at
 * their timeouts (CODER_PROVISION_TIMEOUT_MS each) with the store's writes
 * around them. A test pins that arithmetic.
 */
export const PROVISION_LEASE_MS = 5 * 60 * 1000;
/** After try n that Coder did not confirm, the next one waits n times this. */
export const CLEANUP_RETRY_BASE_MS = 2 * 60 * 1000;
/**
 * How long a claim ('ending') holds before another request may take it over.
 * It is measured from the start of the sweep that made the claim, so a sweep
 * must finish its last session before it runs out, or another sweep could
 * take that session over while this one is still working on it (a second,
 * harmless delete that spends one try). The sweep keeps to it by taking up no
 * new session once SWEEP_DEADLINE_MS has passed since it started (#1403): what
 * is left waits for the next run.
 */
export const CLEANUP_LEASE_MS = 5 * 60 * 1000;
/** The longest one Coder delete may take. A Coder that hangs must not hold a request open. */
export const CODER_CALL_TIMEOUT_MS = 10 * 1000;
/**
 * The most Coder calls one session's clean-up makes in one try: the lookup of
 * a user by name, the lookup of a workspace by owner and name, the workspace
 * delete, and the user delete (the read-back before the user delete is skipped
 * when the name lookup has just read the user).
 */
export const CODER_CALLS_PER_SESSION = 4;
/**
 * After this much of a sweep has gone by, it takes up no more sessions, so
 * that the slowest session it could still take (CODER_CALLS_PER_SESSION calls,
 * each waiting out CODER_CALL_TIMEOUT_MS) ends inside the lease its claim
 * holds. A test pins that arithmetic.
 */
export const SWEEP_DEADLINE_MS = CLEANUP_LEASE_MS - CODER_CALLS_PER_SESSION * CODER_CALL_TIMEOUT_MS;
/** The longest one Coder call that provisions a session may take (creating a user or a workspace is slower than deleting one). */
export const CODER_PROVISION_TIMEOUT_MS = 30 * 1000;
/**
 * At most one in-request sweep per handler set (per worker) in this time. The
 * timer (functions/src/functions/visitor-session-sweep.js, every two minutes)
 * is not held to it: it is one run for the whole app.
 */
export const RETRY_SWEEP_EVERY_MS = 60 * 1000;
/** The most sessions one sweep takes up, so a long list cannot hold a request open; the rest wait for the next sweep. */
export const MAX_SWEEP_SESSIONS = 10;
/**
 * The most records the status and start routes read when they count what may
 * hold a lab (HOLDING_QUERY's `TOP`, #1403). Far above the concurrent limit
 * (LABS_VISITOR_MAX_CONCURRENT, 2 by default, at most the host's 5) plus the
 * waiting clean-ups a day of visitors can leave, so the count is never short
 * in use; and should it ever be, the limit still holds by the slot documents
 * (`takeSlot`), which do not depend on this count.
 */
export const MAX_HOLDING_RECORDS = 100;
/**
 * A record waiting for a retry, or being cleaned, outlives the usual two hours
 * so the retry can still find it. The timer retries it every two minutes, but
 * it can be off (it is armed by the owner) and then the retry runs only when
 * someone visits, so this is a week, not a day: a quiet weekend must not let
 * the record, and with it the only note of what is still in Coder, age out.
 */
export const VISITOR_PENDING_DOC_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A given-up record keeps its Coder ids for a week, so a person can finish the clean-up. */
export const VISITOR_FAILED_DOC_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How many times a claim is tried when another writer keeps changing the record. */
export const FINISH_ATTEMPTS = 3;

/** A write that lost to another writer: the record changed (412) or is gone (404). */
export const lostRace = (error) =>
  [412, 404].some((code) => error?.code === code || error?.statusCode === code);


/**
 * The records that may hold one of the host's workspace slots: a running
 * session, a start under way, and one whose clean-up Coder has not confirmed.
 */
export const HOLDING_STATUSES = Object.freeze([
  SESSION_STATUS.active,
  SESSION_STATUS.provisioning,
  SESSION_STATUS.ending,
  SESSION_STATUS.cleanupPending,
  SESSION_STATUS.cleanupFailed,
]);

/**
 * Has the clean-up of this record been given up for good: `cleanup_failed`
 * with no next round (`retryAt`)? Such a record is left for a person and no
 * longer counts against the concurrent limit (#1464 review, finding G):
 * counting it would close the lab to visitors for the week its record is
 * kept. Its workspace may still exist on the host, which is what the log line
 * written when it is given up says, so a person can remove it.
 */
export const givenUpForGood = (record) =>
  record.status === SESSION_STATUS.cleanupFailed && typeof record.retryAt !== 'string';

/**
 * May this record still hold a lab on the host? A running session (within its
 * hour or past it: until it is cleaned up its workspace is there), a start
 * under way, and one whose workspace Coder has not confirmed as deleted,
 * unless its clean-up was given up for good.
 */
export function mayHoldLab(record) {
  return (
    HOLDING_STATUSES.includes(record?.status) && record.workspaceGone !== true && !givenUpForGood(record)
  );
}

/**
 * Does this record count against the concurrent limit as the status read
 * shows it (#1403, item 5)? What `mayHoldLab` says, except that a session past
 * its hour that is still `active` is not counted, as before: the sweep that
 * the same request starts ends it. The start does not rely on this count
 * alone; it takes a slot document as well (`takeSlot`).
 */
export function holdsSlot(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return record.expiresAt > nowIso;
  return mayHoldLab(record);
}
