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
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ORIGIN_NOT_VERIFIED, assertClientIdentity, resolvedSetting } from '../auth/client-identity.js';
import {
  CHECK_WINDOW_MS,
  LOCK_CODES,
  VISITOR_TURNSTILE_ACTION,
  createCheckLimiter,
  isSiteOrigin,
  turnstileConfigured,
  turnstileSecret,
  verifyTurnstileToken,
} from './public-lock.js';
import { utcDay } from '../cloud-tools/history.js';
import { takeDailyCap } from '../daily-cap.js';
import { readCoderConfig } from './coder-status.js';
import { recordLabStart, safeLogCode } from './lab-starts.js';

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

/**
 * A signal that aborts a Coder call after `config.timeoutMs` (default
 * CODER_CALL_TIMEOUT_MS for a delete, CODER_PROVISION_TIMEOUT_MS for the calls
 * that provision a session), so a Coder that hangs cannot hold a request open.
 * None of the Coder calls had one before (#1388).
 */
const coderTimeout = (config, fallbackMs = CODER_CALL_TIMEOUT_MS) =>
  AbortSignal.timeout(config?.timeoutMs ?? fallbackMs);

/**
 * The error a provisioning call throws when Coder refuses it: the step and the
 * HTTP status, and nothing Coder wrote in its answer (#1403, item 9). Coder's
 * text can name users, templates or its own settings, and this message reaches
 * a log line. `statusCode` lets `errorKind` report the status on its own.
 */
function coderRefusal(what, status) {
  const shown = Number.isInteger(status) ? `HTTP ${status}` : 'a refusal';
  return Object.assign(new Error(`${what}: ${shown}`), Number.isInteger(status) ? { statusCode: status } : {});
}

export async function createVisitorCoderUser(fetchImpl, config, { username, email, password }) {
  const res = await fetchImpl(`${config.base}/api/v2/users`, {
    signal: coderTimeout(config, CODER_PROVISION_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Coder-Session-Token': config.token,
    },
    body: JSON.stringify({
      username,
      email,
      name: username,
      password,
      user_login_type: 'password',
    }),
  });
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to create Coder user', res.status);
  }
  return res.json();
}

export async function getTemplateByName(fetchImpl, config, templateName = 'hcw-lab') {
  const res = await fetchImpl(`${config.base}/api/v2/templates`, {
    signal: coderTimeout(config, CODER_PROVISION_TIMEOUT_MS),
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Coder-Session-Token': config.token,
    },
  });
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to list Coder templates', res.status);
  }
  const templates = await res.json();
  const matched = Array.isArray(templates) ? templates.find((t) => t.name === templateName) : null;
  if (!matched) {
    throw new Error(`Coder template '${templateName}' not found`);
  }
  return matched;
}

export async function createVisitorWorkspace(
  fetchImpl,
  config,
  { userId, username, workspaceName, labId, templateName = 'hcw-lab' }
) {
  const template = await getTemplateByName(fetchImpl, config, templateName);
  const orgRes = await fetchImpl(`${config.base}/api/v2/organizations`, {
    signal: coderTimeout(config, CODER_PROVISION_TIMEOUT_MS),
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Coder-Session-Token': config.token,
    },
  });
  if (!orgRes.ok) {
    await releaseBody(orgRes);
    throw coderRefusal('Failed to list Coder organizations', orgRes.status);
  }
  const orgs = await orgRes.json();
  const defaultOrg = Array.isArray(orgs) && orgs.length > 0 ? orgs[0] : null;
  if (!defaultOrg) {
    throw new Error('No default Coder organization found');
  }

  const res = await fetchImpl(
    `${config.base}/api/v2/organizations/${encodeURIComponent(defaultOrg.id)}/members/${encodeURIComponent(userId)}/workspaces`,
    {
      signal: coderTimeout(config, CODER_PROVISION_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Coder-Session-Token': config.token,
      },
      body: JSON.stringify({
        template_id: template.id,
        name: workspaceName,
        autostart: true,
      }),
    }
  );
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to create visitor workspace', res.status);
  }
  const workspace = await res.json();
  const accessUrl = `https://code-server--${workspaceName}--${username}.coder.lab.hybridcloudworks.com/?folder=/tmp/home/lab`;
  return { workspace, accessUrl };
}

/**
 * Ask Coder to delete a workspace. True when Coder accepted it or the
 * workspace is already gone (404 or 410); false for anything else, a timeout
 * included. The sessions use the same call through `cleanUpCoder`, which also
 * keeps the reason for its log line.
 */
export async function deleteVisitorWorkspace(fetchImpl, config, workspaceId) {
  return (await deleteWorkspaceCall(fetchImpl, config, workspaceId)).confirmed;
}

/** Ask Coder to delete a user: true when accepted or already gone, false otherwise. */
export async function deleteVisitorUser(fetchImpl, config, userId) {
  return (await deleteUserCall(fetchImpl, config, userId)).confirmed;
}

const SESSION_CONTAINER = 'lab_jobs';

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
 * It is measured from the start of the sweep that made the claim, and the
 * slowest sweep is MAX_SWEEP_SESSIONS sessions with up to three Coder calls each
 * (the lookup of a start that failed, the workspace delete, the user delete),
 * each of which may wait out CODER_CALL_TIMEOUT_MS: 10 x 3 x 10 s, which is
 * this much exactly. A test pins that arithmetic. Only a Coder that answers
 * slowly gets there; one that hangs outright stops each session's chain at its
 * first call.
 */
export const CLEANUP_LEASE_MS = 5 * 60 * 1000;
/** The longest one Coder delete may take. A Coder that hangs must not hold a request open. */
export const CODER_CALL_TIMEOUT_MS = 10 * 1000;
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
const FINISH_ATTEMPTS = 3;

/** A write that lost to another writer: the record changed (412) or is gone (404). */
const lostRace = (error) =>
  [412, 404].some((code) => error?.code === code || error?.statusCode === code);

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
 * Whether a stored id or name is safe to write into a Coder URL path as one
 * segment. These come from Coder's own answers and are saved in the session
 * record, which no visitor writes; the unattended sweep still carries an
 * administrator-grade token, so it does not send what is not plainly an id or a
 * name. It refuses `.` and `..` (a path climb), anything with a slash, `?`, `#`,
 * `%` or a space, and `me`, which Coder reads as the caller's own account (a
 * delete of "me" would delete the broker's own user).
 */
export function isSafeSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && value.toLowerCase() !== 'me';
}

/** Let go of an answer's body without reading it; a failure to is no failure of the call. */
async function releaseBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The status is already read.
  }
}

/**
 * One delete call to Coder, with a timeout. `confirmed` is true when Coder
 * accepted it, or answered 404 or 410 (the thing is already gone: a delete
 * that finds nothing to delete has done its job). `kind` says what happened
 * in a few safe words for a log line: `ok`, `gone`, `HTTP 417`, `timeout`,
 * `network`. Never the response text and never an id.
 */
async function coderDelete(fetchImpl, config, url, init) {
  try {
    const res = await fetchImpl(url, { ...init, signal: coderTimeout(config) });
    // Only the status matters; let go of the body so the connection is not held for it.
    await releaseBody(res);
    if (res.ok) return { confirmed: true, kind: 'ok' };
    if (res.status === 404 || res.status === 410) return { confirmed: true, kind: 'gone' };
    return { confirmed: false, kind: Number.isInteger(res.status) ? `HTTP ${res.status}` : 'refused' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { confirmed: false, kind: timedOut ? 'timeout' : 'network' };
  }
}

const INVALID_ID = Object.freeze({ confirmed: false, kind: 'invalid id' });

const deleteWorkspaceCall = (fetchImpl, config, workspaceId) =>
  !isSafeSegment(workspaceId)
    ? Promise.resolve(INVALID_ID)
    : coderDelete(fetchImpl, config, `${config.base}/api/v2/workspaces/${encodeURIComponent(workspaceId)}/builds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
        body: JSON.stringify({ transition: 'delete' }),
      });

const deleteUserCall = (fetchImpl, config, userId) =>
  !isSafeSegment(userId)
    ? Promise.resolve(INVALID_ID)
    : coderDelete(fetchImpl, config, `${config.base}/api/v2/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
      });

/** Both names the lookup writes into its path are plainly names (see isSafeSegment). */
const hasSafeLookupNames = (session) => isSafeSegment(session.coderUsername) && isSafeSegment(session.workspaceName);

/**
 * Look a visitor's workspace up by its owner's name and its own name, for a
 * record that has no workspace id: a start whose workspace call gave no answer
 * (it timed out, say) after Coder may have gone on and made the workspace, so
 * nothing tells us its id. Coder's API: `GET /api/v2/users/{user}/workspace/{workspacename}`
 * answers the workspace, or 404 when there is none (a deleted one too, unless
 * `include_deleted` is asked for, which it is not).
 * https://coder.com/docs/reference/api/workspaces (read 2026-10-26)
 *
 * It answers one of:
 *  - `{ id, kind: 'found' }`: the workspace, and only when it is the visitor's
 *    own: its name is the one this record was made for and its owner is the
 *    Coder user this record made. Anything else is `lookup mismatch` and is
 *    never deleted.
 *  - `{ missing: true, kind: 'not found' }`: Coder has no such workspace.
 *  - `{ kind }`: Coder did not say (`lookup HTTP 500`, `lookup timeout`,
 *    `lookup network`, `lookup mismatch`). Never an id or any of Coder's text.
 */
async function lookUpWorkspaceCall(fetchImpl, config, session) {
  if (!hasSafeLookupNames(session)) return { kind: 'lookup invalid name' };
  const url =
    `${config.base}/api/v2/users/${encodeURIComponent(session.coderUsername)}` +
    `/workspace/${encodeURIComponent(session.workspaceName)}`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Coder-Session-Token': config.token },
      signal: coderTimeout(config),
    });
    if (res.status === 404 || res.status === 410) {
      await releaseBody(res);
      return { missing: true, kind: 'not found' };
    }
    if (!res.ok) {
      await releaseBody(res);
      return { kind: Number.isInteger(res.status) ? `lookup HTTP ${res.status}` : 'lookup refused' };
    }
    const workspace = await res.json();
    const ours =
      typeof workspace?.id === 'string' &&
      workspace.id !== '' &&
      workspace.name === session.workspaceName &&
      workspace.owner_id === session.coderUserId;
    return ours ? { id: workspace.id, kind: 'found' } : { kind: 'lookup mismatch' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { kind: timedOut ? 'lookup timeout' : 'lookup network' };
  }
}

/**
 * Look a visitor's Coder user up by the name the broker chose for it, for a
 * record that has the name and no id: a start whose user create gave no
 * answer (it timed out, say), or whose process died before it saved the id
 * (#1403, item 2). Coder's API takes a user name where it takes an id:
 * `GET /api/v2/users/{user}`, "User ID, username, or me".
 * https://coder.com/docs/reference/api/users (read 2026-10-31)
 *
 * Only a name of the broker's own shape (`v-` and twelve hex characters) is
 * looked up, so a stored value that is another person's name, or `me`, is
 * never sent. It answers one of:
 *  - `{ id, kind: 'user found' }`: the user, and only when Coder's answer
 *    names the same user and carries an id that is plainly an id.
 *  - `{ missing: true, kind: 'user not found' }`: Coder has no such user.
 *  - `{ kind }`: Coder did not say (`user lookup HTTP 500`, `user lookup
 *    timeout`, `user lookup network`, `user lookup mismatch`, `user lookup
 *    invalid name`). Never an id or any of Coder's text.
 */
async function lookUpUserCall(fetchImpl, config, username) {
  if (typeof username !== 'string' || !VISITOR_USERNAME_SHAPE.test(username)) {
    return { kind: 'user lookup invalid name' };
  }
  try {
    const res = await fetchImpl(`${config.base}/api/v2/users/${encodeURIComponent(username)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Coder-Session-Token': config.token },
      signal: coderTimeout(config),
    });
    if (res.status === 404 || res.status === 410) {
      await releaseBody(res);
      return { missing: true, kind: 'user not found' };
    }
    if (!res.ok) {
      await releaseBody(res);
      return { kind: Number.isInteger(res.status) ? `user lookup HTTP ${res.status}` : 'user lookup refused' };
    }
    const user = await res.json();
    const ours = isSafeSegment(user?.id) && user.username === username;
    return ours ? { id: user.id, kind: 'user found' } : { kind: 'user lookup mismatch' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { kind: timedOut ? 'user lookup timeout' : 'user lookup network' };
  }
}

/** A count stored in a record: a negative, fractional or text one counts as none. */
const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * Can this record be taken up by a stop or the sweep now? An `active` one, or
 * one whose time has come (`retryAt` reached) and that is: cleaning up
 * (`ending`, a claim whose lease has run out), waiting for its next try
 * (`cleanup_pending`), a start whose process never finished
 * (`provisioning`, its lease run out) or a given-up one due another round
 * (`cleanup_failed` with a `retryAt`).
 */
function claimable(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return true;
  const waiting = [
    SESSION_STATUS.ending,
    SESSION_STATUS.cleanupPending,
    SESSION_STATUS.provisioning,
    SESSION_STATUS.cleanupFailed,
  ].includes(record.status);
  return waiting && typeof record.retryAt === 'string' && record.retryAt <= nowIso;
}

/**
 * Take a session for clean-up, under the ETag it was read with, so that only
 * one request does the Coder calls: the winner gets `ending`, with a lease, a
 * count of tries and a longer `ttl`; the loser is refused with a 412.
 *
 * A claim drops the lab's address (`accessUrl`, #1403 item 6): only a running
 * session needs it, and a record that waits for its clean-up can wait a week.
 * A given-up record claimed for another round starts its count of tries again
 * and counts the round (`cleanupRounds`).
 *
 * Losing is not a failure. A stop and a sweep, or two stops, reach the same
 * session at once. The loser reads the record again: no longer claimable means
 * the winner has it (`taken-elsewhere`), gone means its `ttl` ran out
 * (`gone`); still claimable means something else changed it, and the claim is
 * tried again on the new version, up to FINISH_ATTEMPTS times, then `changed`.
 * Any other error is a real failure and is thrown.
 *
 * `replaceDocIfMatch(containerName, document, options)` takes the whole
 * document, `_etag` inside it, and the partition key in the options (#1383).
 *
 * @returns {Promise<{ outcome: 'claimed', session: object } | { outcome: 'taken-elsewhere', status: string } | { outcome: 'gone' | 'changed' }>}
 *   `status` is what the record that another request holds says now
 */
async function claimSession(store, session, endStatus, nowMs) {
  const claimOf = ({ accessUrl: _address, ...record }) => {
    const newRound = record.status === SESSION_STATUS.cleanupFailed;
    return {
      ...record,
      status: SESSION_STATUS.ending,
      // Only the two final statuses a session can have; a record that says anything else gets the one asked for.
      endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(record.endStatus) ? record.endStatus : endStatus,
      endedAt: record.endedAt ?? new Date(nowMs).toISOString(),
      // A count: a negative or fractional one would never reach the bound.
      cleanupAttempts: newRound ? 1 : countOf(record.cleanupAttempts) + 1,
      ...(newRound ? { cleanupRounds: countOf(record.cleanupRounds) + 1 } : {}),
      retryAt: new Date(nowMs + CLEANUP_LEASE_MS).toISOString(),
      ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    };
  };

  if (typeof store.replaceDocIfMatch !== 'function') {
    // A store without conditional writes, which the Functions app never has
    // (labs-public-http.js hands it cosmos-client.js's): unconditional, so no
    // protection against a second request. One that cannot save at all must
    // not report that it did.
    if (typeof store.upsertDoc !== 'function') {
      throw new TypeError('The store given to the visitor sessions cannot save a session record.');
    }
    const claimed = claimOf(session);
    await store.upsertDoc(SESSION_CONTAINER, claimed);
    return { outcome: 'claimed', session: claimed };
  }

  const nowIso = new Date(nowMs).toISOString();
  let current = session;
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    try {
      const claimed = claimOf(current);
      const saved = await store.replaceDocIfMatch(SESSION_CONTAINER, claimed, {
        partitionKey: current.id,
      });
      return { outcome: 'claimed', session: saved ?? claimed };
    } catch (error) {
      if (!lostRace(error)) throw error;
    }
    current = await store.readDoc(SESSION_CONTAINER, session.id, session.id);
    if (!current) return { outcome: 'gone' };
    if (!claimable(current, nowIso)) return { outcome: 'taken-elsewhere', status: current.status };
  }
  return { outcome: 'changed' };
}

/**
 * Ask Coder to delete the session's workspace, then its user, skipping a half
 * an earlier try already got confirmed, and say what it got. The user delete
 * is attempted straight after an accepted workspace delete (it is sometimes
 * quick enough) but not after a refused one, which it cannot succeed after.
 *
 * Nothing to delete counts as done (a record with no workspace or no user). A
 * session that has something to delete cannot be cleaned without the broker
 * configuration, so it is not done, and is tried again when there is one.
 *
 * A record with the visitor's Coder user name and no user id is a start whose
 * user create gave no answer, or whose process died (#1403, item 2). The user
 * is looked up by that name first. Coder having no such user means nothing was
 * made at all (the workspace is asked for only after the user exists, and
 * Coder cannot keep a workspace without its owner), so both halves are done.
 *
 * A record with no workspace id but with the visitor's Coder user and a
 * workspace name is a start that failed after the user was made (its workspace
 * call timed out or was refused). Coder may still have made the workspace, so
 * it is looked up by owner and name before it is taken as gone. A workspace
 * the lookup does not find counts as gone for this try only (`workspaceGone`
 * is not saved): the user delete, which Coder refuses while the user has a
 * workspace, is the confirmation, and a workspace that turns up later is found
 * by the next try's lookup.
 *
 * @returns {Promise<{ workspaceGone: boolean, workspaceGoneSaved: boolean, workspaceId: string | undefined, coderUserId: string | undefined, userGone: boolean, workspace: string, user: string, workspaceBy?: string, userBy?: string }>}
 *   the two halves; `workspaceGoneSaved` is whether `workspaceGone` may be
 *   written to the record; `workspaceId` and `coderUserId` are the ones the
 *   record had or a lookup found; `workspaceBy` and `userBy` say what
 *   confirmed a half on this try (`ok`, `gone`, `not found`); and for each half
 *   a short safe word for the log (`ok`, `gone`, `found`, `not found`,
 *   `HTTP 417`, `lookup mismatch`, `timeout`, `network`, `skipped`,
 *   `unconfigured`, `done`, `none`)
 */
async function cleanUpCoder(fetchImpl, config, session) {
  const needsLookup =
    !session.workspaceGone &&
    !session.workspaceId &&
    Boolean(session.workspaceName) &&
    Boolean(session.coderUsername);
  const nothingToDelete = !session.workspaceId && !needsLookup;
  const result = {
    workspaceGone: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceGoneSaved: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceId: session.workspaceId,
    coderUserId: session.coderUserId,
    userGone: Boolean(session.userGone) || (!session.coderUserId && !session.coderUsername),
    workspace: session.workspaceGone ? 'done' : 'none',
    user: session.userGone ? 'done' : 'none',
  };

  // Only the user's name is known: find its id, or learn that it was never made.
  if (!result.userGone && !result.coderUserId) {
    if (!config) {
      return { ...result, user: 'unconfigured', workspace: result.workspaceGone ? result.workspace : 'skipped' };
    }
    const found = await lookUpUserCall(fetchImpl, config, session.coderUsername);
    if (found.missing) {
      return {
        ...result,
        workspaceGone: true,
        workspaceGoneSaved: true,
        userGone: true,
        workspace: 'none',
        user: found.kind,
        workspaceBy: 'no user',
        userBy: 'not found',
      };
    }
    if (!found.id) {
      return { ...result, user: found.kind, workspace: result.workspaceGone ? result.workspace : 'skipped' };
    }
    result.coderUserId = found.id;
  }

  if (needsLookup) {
    if (!config) {
      result.workspace = 'unconfigured';
    } else {
      const found = await lookUpWorkspaceCall(fetchImpl, config, { ...session, coderUserId: result.coderUserId });
      result.workspace = found.kind;
      if (found.id) result.workspaceId = found.id;
      if (found.missing) {
        result.workspaceGone = true;
        result.workspaceBy = 'not found';
      }
    }
  }
  if (!result.workspaceGone && result.workspaceId) {
    if (!config) {
      result.workspace = 'unconfigured';
    } else {
      const call = await deleteWorkspaceCall(fetchImpl, config, result.workspaceId);
      result.workspaceGone = call.confirmed;
      result.workspaceGoneSaved = call.confirmed;
      result.workspace = call.kind;
      if (call.confirmed) result.workspaceBy = call.kind;
    }
  }
  if (!result.userGone) {
    if (!config) {
      result.user = 'unconfigured';
    } else if (!result.workspaceGone) {
      result.user = 'skipped';
    } else {
      const call = await deleteUserCall(fetchImpl, config, result.coderUserId);
      result.userGone = call.confirmed;
      result.user = call.kind;
      if (call.confirmed) result.userBy = call.kind;
    }
  }
  return result;
}

/**
 * End one session: claim it, delete its Coder workspace and user, and save it
 * as over only when Coder has confirmed both. Used by the stop route (a
 * visitor pressing End), by the sweep for a session past its hour, and by the
 * sweep again for one still waiting for its clean-up to be finished.
 *
 * @param {object} store
 * @param {Function} fetchImpl
 * @param {{ base: string, token: string } | null} config - null: Coder cannot be called
 * @param {object} session - the stored record, with the `_etag` it was read with
 * @param {object} options
 * @param {'ended' | 'expired'} options.endStatus - what it becomes (a retried record keeps the one it was first given)
 * @param {number} options.nowMs
 * @param {(line: string) => void} [options.log] - content-free lines only
 * @returns {Promise<{ outcome: 'done' | 'pending' | 'given-up' | 'taken-elsewhere' | 'gone' | 'changed', status?: string }>}
 *   `done`: both deletes confirmed and the record is saved as over. `pending`:
 *   not yet, it will be tried again. `given-up`: the last try of a round was
 *   used (`cleanup_failed`; another round follows unless it was the last).
 *   The rest: another request has it, its record has aged out, or it kept
 *   changing.
 */
async function endSession(store, fetchImpl, config, session, { endStatus, nowMs, log = null }) {
  const claim = await claimSession(store, session, endStatus, nowMs);
  if (claim.outcome !== 'claimed') return claim;

  const claimed = claim.session;
  const steps = await cleanUpCoder(fetchImpl, config, claimed);
  // A start that never ran still owes its daily start back (#1464 review,
  // findings C and round 2): the record is not over until the refund is written.
  const owed = refundOwed(claimed);
  const refunded = owed ? await recordRefund(store, claimed, nowMs, log) : false;
  const attempts = claimed.cleanupAttempts;
  const finished = steps.workspaceGone && steps.userGone && (!owed || refunded);
  const givenUp = !finished && attempts >= MAX_CLEANUP_ATTEMPTS;
  const nowIso = new Date(nowMs).toISOString();

  // Coder refusing the user (417) after an earlier try saved the workspace as
  // gone: after a few of those in a row, ask for the workspace delete again,
  // since the delete build Coder accepted may have failed (#1403, item 3).
  const refusedUser = steps.user === 'HTTP 417';
  const refusals = refusedUser ? countOf(claimed.userRefusals) + 1 : 0;
  const askWorkspaceAgain =
    !finished &&
    refusals >= USER_REFUSALS_BEFORE_WORKSPACE_RETRY &&
    Boolean(claimed.workspaceGone) &&
    Boolean(steps.workspaceId);

  const { retryAt: _lease, ...rest } = claimed;
  // Ids a lookup found are kept, so a later try deletes them without looking again.
  const found = {
    ...(steps.workspaceId ? { workspaceId: steps.workspaceId } : {}),
    ...(steps.coderUserId ? { coderUserId: steps.coderUserId } : {}),
  };
  // What confirmed each half, once it is confirmed for good (#1403, item 4).
  const confirmedBy = (savedHalf) => ({
    ...(steps.workspaceBy && (finished || savedHalf) ? { workspaceConfirmedBy: steps.workspaceBy } : {}),
    ...(steps.userBy ? { userConfirmedBy: steps.userBy } : {}),
  });
  const waitingHalves = askWorkspaceAgain
    ? { workspaceGone: false, userGone: steps.userGone, userRefusals: 0 }
    : { workspaceGone: steps.workspaceGoneSaved, userGone: steps.userGone, userRefusals: refusals };
  const rounds = countOf(claimed.cleanupRounds);
  const lastRound = rounds >= MAX_CLEANUP_ROUNDS;

  let next;
  if (finished) {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(true),
      status: claimed.endStatus,
      workspaceGone: true,
      userGone: true,
      ttl: VISITOR_DOC_TTL_SECONDS,
    };
  } else if (givenUp) {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(steps.workspaceGoneSaved && !askWorkspaceAgain),
      status: SESSION_STATUS.cleanupFailed,
      ...waitingHalves,
      cleanupAt: nowIso,
      ...(lastRound ? {} : { retryAt: new Date(nowMs + CLEANUP_REARM_MS).toISOString() }),
      ttl: VISITOR_FAILED_DOC_TTL_SECONDS,
    };
  } else {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(steps.workspaceGoneSaved && !askWorkspaceAgain),
      status: SESSION_STATUS.cleanupPending,
      ...waitingHalves,
      cleanupAt: nowIso,
      retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS * attempts).toISOString(),
      ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    };
  }
  if (askWorkspaceAgain) delete next.workspaceConfirmedBy;
  if (refunded) next.dailyCapRefund = DAILY_CAP_REFUND.given;

  if (typeof store.replaceDocIfMatch === 'function') {
    try {
      await store.replaceDocIfMatch(SESSION_CONTAINER, next, { partitionKey: next.id });
    } catch (error) {
      if (!lostRace(error)) throw error;
      // The record changed while Coder was being called (the lease ran out and
      // another request took it over, or it aged out). That request owns it now.
      const current = await Promise.resolve(store.readDoc?.(SESSION_CONTAINER, next.id, next.id)).catch(() => null);
      return current ? { outcome: 'taken-elsewhere', status: current.status } : { outcome: 'gone' };
    }
  } else {
    await store.upsertDoc(SESSION_CONTAINER, next);
  }

  // A session that no longer holds a lab lets its slot go (#1464 review, finding A).
  if (!mayHoldLab(next)) await releaseSlot(store, next, nowMs);

  const where = `workspace ${steps.workspace}, user ${steps.user}${owed && !refunded ? ', daily start not yet given back' : ''}`;
  if (finished) {
    // A 404 or 410 is also how Coder may answer a token that may not see the
    // thing, so a clean-up confirmed that way is said in the log (#1403, item 4).
    if (steps.workspaceBy === 'gone' || steps.userBy === 'gone') {
      log?.(`visitor-session: a session's Coder clean-up was taken as done on a 404 or 410 (${where})`);
    }
    return { outcome: 'done' };
  }
  const again = askWorkspaceAgain ? '; the workspace delete will be asked for again' : '';
  if (givenUp) {
    log?.(
      lastRound
        ? `visitor-session: a session's Coder clean-up was given up for good after ${attempts} tries in round ${rounds + 1}, the last; it no longer counts against the visitor lab limit, and a person must check the host for its workspace (${where})`
        : `visitor-session: a session's Coder clean-up was given up after ${attempts} tries in round ${rounds + 1} of ${MAX_CLEANUP_ROUNDS + 1}; another round follows in an hour (${where})${again}`
    );
    return { outcome: 'given-up' };
  }
  log?.(
    `visitor-session: a session's Coder clean-up is not finished (${where}); try ${attempts} of ${MAX_CLEANUP_ATTEMPTS}${again}`
  );
  return { outcome: 'pending' };
}

/** The statuses whose records the sweep takes up again once their `retryAt` has come. */
const DUE_STATUSES = Object.freeze([
  SESSION_STATUS.cleanupPending,
  SESSION_STATUS.ending,
  SESSION_STATUS.provisioning,
  SESSION_STATUS.cleanupFailed,
]);

/**
 * The sweep. Ends every session past `expiresAt` (saved as `expired` once
 * Coder confirms its workspace and user are gone), and tries again every
 * record whose time has come: a clean-up Coder has not yet confirmed, a claim
 * whose holder never finished, a start whose process never finished, and a
 * given-up record due another round (#1388, #1403).
 *
 * Never throws for one bad session: a store failure that is not a lost race
 * is counted in `failed` and, when `log` is given, reported by kind only
 * (the code or error name, with no session id and no error text). It was once
 * swallowed here without a trace, which is how a reaper that saved nothing ran
 * unnoticed (#1383).
 *
 * @param {object} store
 * @param {Function} fetchImpl
 * @param {{ base: string, token: string } | null} config - null: Coder cannot be called, so sessions that need it stay pending
 * @param {object} [options]
 * @param {string} [options.nowIso]
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.limit] - the most sessions to take up; the rest wait for the next sweep (default MAX_SWEEP_SESSIONS)
 * @returns {Promise<{ reaped: number, finished: number, pending: number, failed: number }>}
 *   `reaped`: sessions past their hour that this call saved as expired.
 *   `finished`: sessions waiting on a clean-up that this call saved as over.
 *   `pending`: sessions Coder has not yet confirmed, to be tried again.
 *   `failed`: given up, kept changing, or could not be saved. One that a stop
 *   ended first is counted nowhere.
 */
export async function reapExpiredVisitorSessions(
  store,
  fetchImpl,
  config,
  { nowIso = new Date().toISOString(), log = null, limit = MAX_SWEEP_SESSIONS } = {}
) {
  const tally = { reaped: 0, finished: 0, pending: 0, failed: 0 };
  if (!store?.queryDocs) return tally;
  const nowMs = Date.parse(nowIso);

  let expiredSessions = [];
  try {
    expiredSessions = await store.queryDocs(SESSION_CONTAINER, EXPIRED_QUERY, [
      { name: '@type', value: VISITOR_JOB_TYPE },
      { name: '@status', value: SESSION_STATUS.active },
      { name: '@nowIso', value: nowIso },
    ]);
  } catch (error) {
    // A sweep that never ran must not look like one that found nothing.
    log?.(`visitor-session: the expired sessions could not be listed (${errorKind(error)})`);
    return tally;
  }

  // Waiting for a retry, a claim or a start whose holder never finished, and a given-up record due another round.
  let due = [];
  try {
    due = await store.queryDocs(SESSION_CONTAINER, DUE_QUERY, [
      { name: '@type', value: VISITOR_JOB_TYPE },
      { name: '@statuses', value: [...DUE_STATUSES] },
      { name: '@dueIso', value: nowIso },
    ]);
  } catch (error) {
    log?.(`visitor-session: the sessions waiting for a clean-up could not be listed (${errorKind(error)})`);
    due = [];
  }

  const work = [
    ...expiredSessions.map((session) => ({ session, endStatus: SESSION_STATUS.expired, retry: false })),
    ...(Array.isArray(due) ? due : []).map((session) => ({
      session,
      // What it was going to become, if that is one of the two final statuses; anything else is an expiry.
      endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(session.endStatus) ? session.endStatus : SESSION_STATUS.expired,
      retry: true,
    })),
  ];
  for (const { session, endStatus, retry } of work.slice(0, limit)) {
    try {
      const { outcome } = await endSession(store, fetchImpl, config, session, { endStatus, nowMs, log });
      if (outcome === 'done') tally[retry ? 'finished' : 'reaped'] += 1;
      if (outcome === 'pending') tally.pending += 1;
      if (outcome === 'given-up') tally.failed += 1;
      if (outcome === 'changed') {
        tally.failed += 1;
        log?.('visitor-session: a session kept changing and was not cleaned up');
      }
    } catch (error) {
      tally.failed += 1;
      log?.(`visitor-session: a session could not be saved (${errorKind(error)})`);
    }
  }
  return tally;
}

/**
 * The three queries on `lab_jobs`, as Cosmos runs them. The tests run these
 * very strings against their documents (`runCosmosQuery` in
 * test/cosmos-predicate.js), so a mistake in
 * one fails a test (#1403, item 8).
 */
export const EXPIRED_QUERY =
  'SELECT * FROM c WHERE c.type = @type AND c.status = @status AND c.expiresAt <= @nowIso';
export const DUE_QUERY =
  'SELECT * FROM c WHERE c.type = @type AND ARRAY_CONTAINS(@statuses, c.status) AND c.retryAt <= @dueIso';
export const HOLDING_QUERY = 'SELECT * FROM c WHERE c.type = @type AND ARRAY_CONTAINS(@statuses, c.status)';

/**
 * The records that may hold one of the host's workspace slots: a running
 * session, a start under way, and one whose clean-up Coder has not confirmed.
 */
const HOLDING_STATUSES = Object.freeze([
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
const givenUpForGood = (record) =>
  record.status === SESSION_STATUS.cleanupFailed && typeof record.retryAt !== 'string';

/**
 * May this record still hold a lab on the host? A running session (within its
 * hour or past it: until it is cleaned up its workspace is there), a start
 * under way, and one whose workspace Coder has not confirmed as deleted,
 * unless its clean-up was given up for good.
 */
function mayHoldLab(record) {
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
function holdsSlot(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return record.expiresAt > nowIso;
  return mayHoldLab(record);
}

/**
 * The documents that make a start atomic (#1464 review, finding A). They live
 * in `submission_quota` (partition key `/id`, beside the daily counters), and
 * each is taken with a create that Cosmos refuses with 409 when the id is
 * already there, so two requests cannot both take one, however close together
 * they run and whatever a query would have shown each of them.
 *
 *  - `visitor-start:<hash>`: one start at a time per visitor. It holds for
 *    PROVISION_LEASE_MS (`expiresAt`), is let go when the start ends, and a
 *    lock whose time has passed is taken over with a conditional replace.
 *  - `visitor-slot:<n>` for n below the concurrent limit: one per lab the
 *    visitors may hold at once, and every holder owns one (round 3): a
 *    record that may still hold a lab, or a start that has taken its slot and
 *    not yet written its record. Under the start lock, a holding record that
 *    no slot names is given one first, and only then does the start take its
 *    own, or is refused as full. A slot never ages out (`ttl: -1`). It is let
 *    go when its session no longer holds a lab, and one that was never let go
 *    (its process died) is taken over only once it is older than
 *    PROVISION_LEASE_MS and its holder no longer holds a lab, so the slots
 *    mend themselves and cannot stay full for ever.
 */
const QUOTA_CONTAINER = 'submission_quota';
export const START_LOCK_PREFIX = 'visitor-start:';
export const SLOT_PREFIX = 'visitor-slot:';

const isConflict = (error) => error?.code === 409 || error?.statusCode === 409;

/** Take the visitor's start lock, or null when another start of theirs holds it. Store faults are thrown. */
async function takeStartLock(store, clientHash, sessionId, nowMs) {
  const id = `${START_LOCK_PREFIX}${clientHash}`;
  const lock = {
    id,
    kind: 'visitor_start_lock',
    sessionId,
    expiresAt: new Date(nowMs + PROVISION_LEASE_MS).toISOString(),
    ttl: Math.ceil(PROVISION_LEASE_MS / 1000),
  };
  try {
    return (await store.createDoc(QUOTA_CONTAINER, lock)) ?? lock;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const current = await store.readDoc(QUOTA_CONTAINER, id, id);
  if (!current || current.expiresAt > new Date(nowMs).toISOString()) return null;
  try {
    return await store.replaceDocIfMatch(QUOTA_CONTAINER, { ...lock, _etag: current._etag }, { partitionKey: id });
  } catch (error) {
    if (lostRace(error)) return null;
    throw error;
  }
}

/** Let the start lock go by marking it run out. A failure is no fault: it runs out on its own. */
async function releaseStartLock(store, lock, nowMs) {
  if (!lock?._etag || typeof store.replaceDocIfMatch !== 'function') return;
  try {
    await store.replaceDocIfMatch(
      QUOTA_CONTAINER,
      { ...lock, sessionId: null, expiresAt: new Date(nowMs).toISOString() },
      { partitionKey: lock.id }
    );
  } catch {
    // Another start took it over, or it aged out: either way it is not ours.
  }
}

/** Is a taken slot free to take over? Let go, or old enough to judge and its session holds no lab. */
async function slotIsFree(store, slot, nowMs) {
  if (!slot.sessionId) return true;
  const takenMs = Date.parse(slot.takenAt);
  if (!Number.isFinite(takenMs) || takenMs > nowMs - PROVISION_LEASE_MS) return false;
  const holder = await store.readDoc(SESSION_CONTAINER, slot.sessionId, slot.sessionId);
  return !mayHoldLab(holder);
}

/**
 * A slot document never ages out (`ttl: -1` on the item, since the
 * container's own default is two hours) (#1464 review, round 3). It is let go
 * when its session's clean-up is confirmed (`releaseSlot`), or taken over
 * after the holder check (`slotIsFree`), and by nothing else: a slot that aged
 * out while its record still held a lab would let a new start take it while
 * the old workspace was still on the host.
 */
const SLOT_TTL_SECONDS = -1;

/**
 * Take one of the `max` slots for `holderId` (a new start's session, or a
 * holding record that no slot names yet): its number, or null when all are
 * held. A slot that already names the holder is its own, also when another
 * start wrote it a moment ago. Store faults are thrown.
 */
async function takeSlot(store, holderId, max, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  for (let n = 0; n < max; n += 1) {
    const id = `${SLOT_PREFIX}${n}`;
    const slot = { id, kind: 'visitor_slot', sessionId: holderId, takenAt: nowIso, ttl: SLOT_TTL_SECONDS };
    try {
      await store.createDoc(QUOTA_CONTAINER, slot);
      return n;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    const current = await store.readDoc(QUOTA_CONTAINER, id, id);
    if (current?.sessionId === holderId) return n;
    if (!current || !(await slotIsFree(store, current, nowMs))) continue;
    try {
      await store.replaceDocIfMatch(QUOTA_CONTAINER, { ...slot, _etag: current._etag }, { partitionKey: id });
      return n;
    } catch (error) {
      if (!lostRace(error)) throw error;
      const after = await store.readDoc(QUOTA_CONTAINER, id, id);
      if (after?.sessionId === holderId) return n;
    }
  }
  return null;
}

/** The ids the `max` slot documents name now (a slot let go names none). Store faults are thrown. */
async function slotHolders(store, max) {
  const ids = new Set();
  for (let n = 0; n < max; n += 1) {
    const id = `${SLOT_PREFIX}${n}`;
    const doc = await store.readDoc(QUOTA_CONTAINER, id, id);
    if (typeof doc?.sessionId === 'string' && doc.sessionId) ids.add(doc.sessionId);
  }
  return ids;
}

/**
 * Let a session's slot go, when its record says it no longer holds a lab.
 * Only the session that holds the slot lets it go; a failure is no fault,
 * because a slot that was not let go is taken over later (`slotIsFree`).
 */
async function releaseSlot(store, record, nowMs) {
  if (!Number.isInteger(record?.slot) || typeof store.replaceDocIfMatch !== 'function') return;
  const id = `${SLOT_PREFIX}${record.slot}`;
  try {
    const current = await store.readDoc(QUOTA_CONTAINER, id, id);
    if (!current || current.sessionId !== record.id) return;
    await store.replaceDocIfMatch(
      QUOTA_CONTAINER,
      { ...current, sessionId: null, freedAt: new Date(nowMs).toISOString() },
      { partitionKey: id }
    );
  } catch {
    // Taken over later by a start, once it is old enough.
  }
}

/**
 * A daily start is given back at most once, and a give-back that fails is
 * tried again (#1464 review, finding C and round 2). The start's counter
 * (`visitor-quota:<hash>:<day>`) is never decreased. Instead a start that made
 * no lab writes a refund document, `visitor-refund:<session id>`, with a
 * create: a second create of the same id is refused (409) and counts as done,
 * so however many requests or sweeps try, there is one refund per session.
 * The start then allows the daily limit plus the refunds of that counter
 * (`countRefunds`). A query that misses a refund just written only refuses a
 * start it could have allowed, which is the safe side.
 *
 * The record says where it is in `dailyCapRefund`: `pending` while the start
 * is under way or its refund is not yet written, `given` once the refund
 * document exists, `spent` once the session started. The marker turns to
 * `given` only after the document is written, so a refund that failed is
 * still `pending`, and the sweep writes it on its next try before it saves the
 * record as over.
 */
export const DAILY_CAP_REFUND = Object.freeze({ pending: 'pending', given: 'given', spent: 'spent' });
export const REFUND_PREFIX = 'visitor-refund:';
/** A refund lives as long as the counter it adds to (two days, the counter's own ttl). */
const REFUND_TTL_SECONDS = 86400 * 2;

/**
 * Does this record still owe its daily start back? Only a start that never
 * ran says `pending` (a session that started says `spent`, and one saved before
 * the marker existed says nothing), so the marker alone answers it, whatever
 * the record's status is now (a claim makes it `ending`).
 */
function refundOwed(record) {
  return record?.dailyCapRefund === DAILY_CAP_REFUND.pending && typeof record.dailyCap?.id === 'string';
}

/**
 * Write the refund document of a start that made no lab. True when it exists
 * now (written here, or by an earlier try: 409); false when it could not be
 * written, for the caller to try again later. Never throws.
 */
async function recordRefund(store, record, nowMs, log) {
  if (typeof store.createDoc !== 'function' || typeof record?.dailyCap?.id !== 'string') return false;
  try {
    await store.createDoc(QUOTA_CONTAINER, {
      id: `${REFUND_PREFIX}${record.id}`,
      kind: 'visitor_refund',
      quotaId: record.dailyCap.id,
      createdAt: new Date(nowMs).toISOString(),
      ttl: REFUND_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return true;
    log?.(`visitor-session: a daily start could not be given back yet (${errorKind(error)})`);
    return false;
  }
}

export const REFUND_QUERY = 'SELECT * FROM c WHERE c.kind = @kind AND c.quotaId = @quotaId';

/** How many starts of this counter were given back. Store faults are thrown. */
async function countRefunds(store, quotaId) {
  const rows = await store.queryDocs(QUOTA_CONTAINER, REFUND_QUERY, [
    { name: '@kind', value: 'visitor_refund' },
    { name: '@quotaId', value: quotaId },
  ]);
  return Array.isArray(rows) ? rows.length : 0;
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
    ...(isSafeSegment(user?.id) ? { coderUserId: user.id } : {}),
    ...(typeof user?.username === 'string' && user.username ? { coderUsername: user.username } : {}),
    ...(isSafeSegment(workspaceId) ? { workspaceId } : {}),
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
