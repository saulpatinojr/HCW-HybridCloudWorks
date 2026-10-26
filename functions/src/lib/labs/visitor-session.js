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
 * be our Cloudflare, the helper refuses and so do these routes (403
 * FORBIDDEN, before any read, write or call to Turnstile or Coder): a quota
 * counted on an address the caller can choose is not a quota. People behind
 * one shared network address count as one visitor, as they do for every other
 * anonymous quota here.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ORIGIN_NOT_VERIFIED, assertClientIdentity, resolvedSetting } from '../auth/client-identity.js';
import { isSiteOrigin, turnstileConfigured, turnstileSecret, verifyTurnstileToken, VISITOR_TURNSTILE_ACTION } from './public-lock.js';
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
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Failed to create Coder user: HTTP ${res.status} ${errorBody}`);
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
    throw new Error(`Failed to list Coder templates: HTTP ${res.status}`);
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
    throw new Error(`Failed to list Coder organizations: HTTP ${orgRes.status}`);
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
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Failed to create visitor workspace: HTTP ${res.status} ${errorBody}`);
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
 * A session's life, in `status` (#1388).
 *
 *   active ──claim──▶ ending ──both Coder deletes confirmed──▶ ended | expired
 *                       │
 *                       └─ Coder has not confirmed yet ─▶ cleanup_pending ──retry──▶ ending ...
 *                                                              │
 *                                          MAX_CLEANUP_ATTEMPTS tries used ─▶ cleanup_failed
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
 */
export const SESSION_STATUS = Object.freeze({
  active: 'active',
  ending: 'ending',
  cleanupPending: 'cleanup_pending',
  ended: 'ended',
  expired: 'expired',
  cleanupFailed: 'cleanup_failed',
});

/** Tries at a clean-up before it is given up (and left for a person, see the runbook). */
export const MAX_CLEANUP_ATTEMPTS = 5;
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
 * Can this record be taken up by a stop or the sweep now? An `active` one, or
 * one that is cleaning up (`ending`: a claim whose lease has run out) or
 * waiting for its next try (`cleanup_pending`) whose time has come.
 */
function claimable(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return true;
  const waiting = [SESSION_STATUS.ending, SESSION_STATUS.cleanupPending].includes(record.status);
  return waiting && typeof record.retryAt === 'string' && record.retryAt <= nowIso;
}

/**
 * Take a session for clean-up, under the ETag it was read with, so that only
 * one request does the Coder calls: the winner gets `ending`, with a lease, a
 * count of tries and a longer `ttl`; the loser is refused with a 412.
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
 * @returns {Promise<{ outcome: 'claimed', session: object } | { outcome: 'taken-elsewhere' | 'gone' | 'changed' }>}
 */
async function claimSession(store, session, endStatus, nowMs) {
  const claimOf = (record) => ({
    ...record,
    status: SESSION_STATUS.ending,
    // Only the two final statuses a session can have; a record that says anything else gets the one asked for.
    endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(record.endStatus) ? record.endStatus : endStatus,
    endedAt: record.endedAt ?? new Date(nowMs).toISOString(),
    // A count: a negative or fractional one would never reach the bound.
    cleanupAttempts: (Number.isInteger(record.cleanupAttempts) && record.cleanupAttempts >= 0 ? record.cleanupAttempts : 0) + 1,
    retryAt: new Date(nowMs + CLEANUP_LEASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  });

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
      const saved = await store.replaceDocIfMatch(SESSION_CONTAINER, claimOf(current), {
        partitionKey: current.id,
      });
      return { outcome: 'claimed', session: saved };
    } catch (error) {
      if (!lostRace(error)) throw error;
    }
    current = await store.readDoc(SESSION_CONTAINER, session.id, session.id);
    if (!current) return { outcome: 'gone' };
    if (!claimable(current, nowIso)) return { outcome: 'taken-elsewhere' };
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
 * A record with no workspace id but with the visitor's Coder user and a
 * workspace name is a start that failed after the user was made (its workspace
 * call timed out or was refused). Coder may still have made the workspace, so
 * it is looked up by owner and name before it is taken as gone. A workspace
 * the lookup does not find counts as gone for this try only (`workspaceGone`
 * is not saved): the user delete, which Coder refuses while the user has a
 * workspace, is the confirmation, and a workspace that turns up later is found
 * by the next try's lookup.
 *
 * @returns {Promise<{ workspaceGone: boolean, workspaceGoneSaved: boolean, workspaceId: string | undefined, userGone: boolean, workspace: string, user: string }>}
 *   the two halves; `workspaceGoneSaved` is whether `workspaceGone` may be
 *   written to the record; `workspaceId` is the one the record had or the
 *   lookup found; and for each half a short safe word for the log (`ok`,
 *   `gone`, `found`, `not found`, `HTTP 417`, `lookup mismatch`, `timeout`,
 *   `network`, `skipped`, `unconfigured`, `done`, `none`)
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
    userGone: Boolean(session.userGone) || !session.coderUserId,
    workspace: session.workspaceGone ? 'done' : 'none',
    user: session.userGone ? 'done' : 'none',
  };
  if (needsLookup) {
    if (!config) {
      result.workspace = 'unconfigured';
    } else {
      const found = await lookUpWorkspaceCall(fetchImpl, config, session);
      result.workspace = found.kind;
      if (found.id) result.workspaceId = found.id;
      if (found.missing) result.workspaceGone = true;
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
    }
  }
  if (!result.userGone) {
    if (!config) {
      result.user = 'unconfigured';
    } else if (!result.workspaceGone) {
      result.user = 'skipped';
    } else {
      const call = await deleteUserCall(fetchImpl, config, session.coderUserId);
      result.userGone = call.confirmed;
      result.user = call.kind;
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
 * @returns {Promise<{ outcome: 'done' | 'pending' | 'given-up' | 'taken-elsewhere' | 'gone' | 'changed' }>}
 *   `done`: both deletes confirmed and the record is saved as over. `pending`:
 *   not yet, it will be tried again. `given-up`: the last try was used. The
 *   rest: another request has it, its record has aged out, or it kept changing.
 */
async function endSession(store, fetchImpl, config, session, { endStatus, nowMs, log = null }) {
  const claim = await claimSession(store, session, endStatus, nowMs);
  if (claim.outcome !== 'claimed') return { outcome: claim.outcome };

  const claimed = claim.session;
  const steps = await cleanUpCoder(fetchImpl, config, claimed);
  const attempts = claimed.cleanupAttempts;
  const finished = steps.workspaceGone && steps.userGone;
  const givenUp = !finished && attempts >= MAX_CLEANUP_ATTEMPTS;
  const nowIso = new Date(nowMs).toISOString();

  const { retryAt: _lease, ...rest } = claimed;
  // A workspace id the lookup found is kept, so a later try deletes it without looking again.
  const found = steps.workspaceId ? { workspaceId: steps.workspaceId } : {};
  let next;
  if (finished) {
    next = { ...rest, ...found, status: claimed.endStatus, workspaceGone: true, userGone: true, ttl: VISITOR_DOC_TTL_SECONDS };
  } else if (givenUp) {
    next = {
      ...rest,
      ...found,
      status: SESSION_STATUS.cleanupFailed,
      workspaceGone: steps.workspaceGoneSaved,
      userGone: steps.userGone,
      cleanupAt: nowIso,
      ttl: VISITOR_FAILED_DOC_TTL_SECONDS,
    };
  } else {
    next = {
      ...rest,
      ...found,
      status: SESSION_STATUS.cleanupPending,
      workspaceGone: steps.workspaceGoneSaved,
      userGone: steps.userGone,
      cleanupAt: nowIso,
      retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS * attempts).toISOString(),
      ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    };
  }

  if (typeof store.replaceDocIfMatch === 'function') {
    try {
      await store.replaceDocIfMatch(SESSION_CONTAINER, next, { partitionKey: next.id });
    } catch (error) {
      if (!lostRace(error)) throw error;
      // The record changed while Coder was being called (the lease ran out and
      // another request took it over, or it aged out). That request owns it now.
      return { outcome: 'taken-elsewhere' };
    }
  } else {
    await store.upsertDoc(SESSION_CONTAINER, next);
  }

  if (finished) return { outcome: 'done' };
  const where = `workspace ${steps.workspace}, user ${steps.user}`;
  if (givenUp) {
    log?.(`visitor-session: a session's Coder clean-up was given up after ${attempts} tries (${where})`);
    return { outcome: 'given-up' };
  }
  log?.(
    `visitor-session: a session's Coder clean-up is not finished (${where}); try ${attempts} of ${MAX_CLEANUP_ATTEMPTS}`
  );
  return { outcome: 'pending' };
}

/**
 * The sweep. Ends every session past `expiresAt` (saved as `expired` once
 * Coder confirms its workspace and user are gone), and tries again every
 * session whose clean-up Coder has not yet confirmed and whose next try is due
 * (#1388).
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

  const expiredQuery =
    'SELECT * FROM c WHERE c.type = @type AND c.status = @status AND c.expiresAt <= @nowIso';
  const dueQuery =
    'SELECT * FROM c WHERE c.type = @type AND c.status = @status AND c.retryAt <= @dueIso';
  const parametersFor = (status, extra) => [
    { name: '@type', value: VISITOR_JOB_TYPE },
    { name: '@status', value: status },
    extra,
  ];

  let expiredSessions = [];
  try {
    expiredSessions = await store.queryDocs(
      SESSION_CONTAINER,
      expiredQuery,
      parametersFor(SESSION_STATUS.active, { name: '@nowIso', value: nowIso })
    );
  } catch (error) {
    // A sweep that never ran must not look like one that found nothing.
    log?.(`visitor-session: the expired sessions could not be listed (${errorKind(error)})`);
    return tally;
  }

  // Waiting for a retry, and a claim whose holder never finished (its lease ran out).
  let due = [];
  try {
    for (const status of [SESSION_STATUS.cleanupPending, SESSION_STATUS.ending]) {
      due.push(
        ...(await store.queryDocs(
          SESSION_CONTAINER,
          dueQuery,
          parametersFor(status, { name: '@dueIso', value: nowIso })
        ))
      );
    }
  } catch (error) {
    log?.(`visitor-session: the sessions waiting for a clean-up could not be listed (${errorKind(error)})`);
    due = [];
  }

  const work = [
    ...expiredSessions.map((session) => ({ session, endStatus: SESSION_STATUS.expired, retry: false })),
    ...due.map((session) => ({
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
 * Keep a record of a start that failed after Coder made the visitor's user, so
 * the sweep deletes the user, and the workspace if Coder made one.
 *
 * It is a `cleanup_pending` record carrying what the sweep reads: the Coder
 * user's id and name, the workspace's name (there is no workspace id: the call
 * that would have given it timed out or was refused), and the retry fields. The
 * first try waits CLEANUP_RETRY_BASE_MS so that a create Coder is still
 * finishing can finish. It has no `clientHash` and was never given to a
 * visitor, so no stop request can reach it: only the sweep does.
 *
 * Never throws: the visitor is being answered with a 502 whatever happens
 * here, and a store that is down must not turn that into something else. The
 * log says by kind that the note could not be written, and nothing more.
 */
async function noteUnfinishedStart(store, { user, fallbackUsername, workspaceName, labId, nowMs, context }) {
  const nowIso = new Date(nowMs).toISOString();
  const record = {
    id: randomUUID(),
    type: VISITOR_JOB_TYPE,
    status: SESSION_STATUS.cleanupPending,
    endStatus: SESSION_STATUS.ended,
    startFailed: true,
    labId,
    coderUserId: user.id,
    coderUsername: user.username ?? fallbackUsername,
    workspaceName,
    createdAt: nowIso,
    endedAt: nowIso,
    cleanupAttempts: 0,
    workspaceGone: false,
    userGone: false,
    cleanupAt: nowIso,
    retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
  try {
    await store.createDoc(SESSION_CONTAINER, record);
  } catch (error) {
    context?.error?.(`visitor-session: a failed start could not be noted for clean-up (${errorKind(error)})`);
  }
}

/**
 * Who is calling: the hashed key their sessions and daily quota are filed
 * under, and the address Cloudflare's Turnstile is given.
 *
 * Both come from the real client identity helper, as public-submit.js reads
 * them. Two cases are refused, with a log line that names nothing:
 *  - `anonymousKey` throws ORIGIN_NOT_VERIFIED when the request cannot be shown
 *    to have come through our Cloudflare (and we are not in dev): the helper
 *    failing closed.
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
  const clientIp = identity.trustedClientIp(request);
  if (key.trusted && clientIp === null) return refused();
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
  limiter = null,
  clock = () => Date.now(),
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

      // Check active sessions
      let activeSessions = [];
      try {
        activeSessions = await store.queryDocs(
          SESSION_CONTAINER,
          'SELECT * FROM c WHERE c.type = @type AND c.status = @status',
          [
            { name: '@type', value: VISITOR_JOB_TYPE },
            { name: '@status', value: 'active' },
          ]
        );
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

      // Filter unexpired active sessions
      const liveSessions = activeSessions.filter((s) => s.expiresAt > nowIso);
      // Only the caller's own session is ever described: its id and address
      // are what ends it or opens it, so they are not handed to anyone else.
      const myActiveSession = liveSessions.find((s) => sameClient(s.clientHash, clientHash));

      const maxConcurrent = readVisitorMaxConcurrent(env);
      const capacityReached = liveSessions.length >= maxConcurrent;

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
          activeCount: liveSessions.length,
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

      // Verify Turnstile
      const verification = await verifyTurnstileToken({
        fetch: fetchImpl,
        secret: turnstileSecret(env),
        token: turnstileToken,
        remoteIp: clientIp,
        action: VISITOR_TURNSTILE_ACTION,
      });

      if (!verification.ok) {
        const status = verification.kind === 'unavailable' ? 503 : 403;
        return jsonResponse({
          ok: false,
          code: verification.kind === 'unavailable' ? 'TURNSTILE_UNAVAILABLE' : 'TURNSTILE_FAILED',
          reason: verification.detail,
        }, status);
      }

      // Check daily quota per client
      const day = utcDay(nowMs);
      const quotaKey = `visitor-quota:${clientHash}:${day}`;
      const allowed = await takeDailyCap(store, {
        container: 'submission_quota',
        id: quotaKey,
        kind: 'visitor_session_daily',
        day,
        nowIso,
        limit: VISITOR_CLIENT_DAILY_LIMIT,
        ttlSeconds: 86400 * 2,
      });

      if (!allowed) {
        return jsonResponse({
          ok: false,
          code: DOOR_CODES.client_rate_limited,
          reason: DOOR_REASONS[DOOR_CODES.client_rate_limited],
        }, 429);
      }

      // Check active concurrency
      const activeSessions = await store.queryDocs(
        SESSION_CONTAINER,
        'SELECT * FROM c WHERE c.type = @type AND c.status = @status',
        [
          { name: '@type', value: VISITOR_JOB_TYPE },
          { name: '@status', value: 'active' },
        ]
      );
      // Reclaim capacity from expired sessions (and, on the way, retry any
      // clean-up Coder has not confirmed). Waited for only when a session is
      // past its hour, so its log lines can be written; a retry alone runs
      // behind the answer, without a log, as the status route's does.
      const expired = activeSessions.filter((s) => s.expiresAt <= nowIso);
      if (retrySweepDue(nowMs)) {
        sweepRan(nowMs);
        if (expired.length > 0) {
          await reapExpiredVisitorSessions(store, fetchImpl, config, {
            nowIso,
            log: (line) => context?.warn?.(line),
          }).catch(() => {});
        } else {
          reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
        }
      }

      const liveSessions = activeSessions.filter((s) => s.expiresAt > nowIso);
      const existing = liveSessions.find((s) => sameClient(s.clientHash, clientHash));
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
      if (liveSessions.length >= maxConcurrent) {
        return jsonResponse({
          ok: false,
          code: DOOR_CODES.capacity_full,
          reason: DOOR_REASONS[DOOR_CODES.capacity_full],
        }, 503);
      }

      // Provision ephemeral Coder user & workspace
      const creds = generateVisitorCredentials();
      const workspaceName = VALID_LAB_WORKSPACES[labId];
      let user;
      let workspaceInfo;
      try {
        user = await createVisitorCoderUser(fetchImpl, config, creds);
        workspaceInfo = await createVisitorWorkspace(fetchImpl, config, {
          userId: user.id,
          username: user.username,
          workspaceName,
          labId,
        });
      } catch (err) {
        context?.error?.('visitor-session: provisioning failure', err?.message);
        // The Coder user exists, and Coder may yet make (or already have made)
        // the workspace whose call gave no answer. No visitor was told of a
        // session, so nothing else would ever clean either up (#1388).
        if (user?.id) {
          await noteUnfinishedStart(store, {
            user,
            fallbackUsername: creds.username,
            workspaceName,
            labId,
            nowMs: clock(),
            context,
          });
        }
        return jsonResponse({
          ok: false,
          code: DOOR_CODES.coder_unavailable,
          reason: DOOR_REASONS[DOOR_CODES.coder_unavailable],
        }, 502);
      }

      const sessionId = randomUUID();
      const expiresAtIso = new Date(nowMs + VISITOR_SESSION_DURATION_MS).toISOString();

      const doc = {
        id: sessionId,
        type: VISITOR_JOB_TYPE,
        status: 'active',
        clientHash,
        labId,
        coderUserId: user.id,
        coderUsername: user.username,
        workspaceId: workspaceInfo.workspace.id,
        workspaceName,
        accessUrl: workspaceInfo.accessUrl,
        createdAt: nowIso,
        expiresAt: expiresAtIso,
        ttl: VISITOR_DOC_TTL_SECONDS,
      };

      await store.createDoc(SESSION_CONTAINER, doc);

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

      // Already over, or another request is cleaning it up, or it is waiting for
      // its next try: a second stop (a double click, a retry) has nothing to do,
      // and the answer is the same. A clean-up Coder has not confirmed whose
      // next try is due is tried again here, by whoever asks next.
      const nowMs = clock();
      if (!claimable(doc, new Date(nowMs).toISOString())) {
        return jsonResponse({ ok: true, status: 'ended' });
      }

      // Only the request that claims the record calls Coder; Coder's answer
      // decides whether the record is saved as ended or left to be retried, and
      // either way the visitor's End is answered as done.
      const { outcome } = await endSession(store, fetchImpl, readBrokerConfig(env), doc, {
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

      return jsonResponse({ ok: true, status: 'ended' });
    },
  };
}
