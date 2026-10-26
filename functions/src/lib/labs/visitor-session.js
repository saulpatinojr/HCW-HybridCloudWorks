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
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { resolvedSetting } from '../auth/client-identity.js';
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

export function readBrokerConfig(env = process.env) {
  const coderConfig = readCoderConfig(env);
  if (!coderConfig) return null;
  const brokerToken = resolvedSetting(env?.[CODER_BROKER_TOKEN_SETTING]) || coderConfig.token;
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

export async function createVisitorCoderUser(fetchImpl, config, { username, email, password }) {
  const res = await fetchImpl(`${config.base}/api/v2/users`, {
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
    `${config.base}/api/v2/organizations/${defaultOrg.id}/members/${userId}/workspaces`,
    {
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

export async function deleteVisitorWorkspace(fetchImpl, config, workspaceId) {
  try {
    const res = await fetchImpl(`${config.base}/api/v2/workspaces/${workspaceId}/builds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Coder-Session-Token': config.token,
      },
      body: JSON.stringify({ transition: 'delete' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteVisitorUser(fetchImpl, config, userId) {
  try {
    const res = await fetchImpl(`${config.base}/api/v2/users/${userId}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'Coder-Session-Token': config.token,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SESSION_CONTAINER = 'lab_jobs';

/** How many times a finish is tried when another writer keeps changing the record. */
const FINISH_ATTEMPTS = 3;

/** A write that lost to another writer: the record changed (412) or is gone (404). */
const lostRace = (error) =>
  [412, 404].some((code) => error?.code === code || error?.statusCode === code);

/**
 * What went wrong, for a log line: the error's code or its name, never its text,
 * and only when it looks like a code (a status number, `ECONNRESET`, `TypeError`).
 */
function errorKind(error) {
  const kind = String(error?.code ?? error?.statusCode ?? error?.name ?? 'error');
  return /^[A-Za-z0-9_.-]{1,40}$/.test(kind) ? kind : 'error';
}

/**
 * Save that a session is over (`ended` by its visitor, `expired` by the
 * reaper), under the ETag the session was read with.
 *
 * `replaceDocIfMatch(containerName, document, options)` takes the whole
 * document, `_etag` inside it, and the partition key in the options. This was
 * once called as `(container, id, document, etag)` in two places, which the
 * real store cannot take, so neither a stop nor a reap ever saved (#1383).
 * Both now go through here, so the call is written once.
 *
 * Losing the race is not a failure. A stop and a reap, or two stops, can reach
 * the same session at once; the loser's write is refused with a 412, and the
 * loser reads the record again: if it is no longer `active`, the other writer
 * finished it and the loser has nothing left to do. If it is still active,
 * something else changed it and the finish is tried again on the new version.
 * Any other error is a real failure and is thrown.
 *
 * @param {object} store
 * @param {object} session - the stored record, with the `_etag` it was read with
 * @param {'ended' | 'expired'} status
 * @param {string} endedAt - ISO time
 * @returns {Promise<'written' | 'finished-elsewhere' | 'gone' | 'changed'>}
 *   `written`: this call saved it. `finished-elsewhere`: it was already ended
 *   or expired by another writer. `gone`: its record has aged out (its `ttl`).
 *   `changed`: it kept changing and is still active, so nothing was saved.
 */
async function finishSession(store, session, status, endedAt) {
  if (typeof store.replaceDocIfMatch !== 'function') {
    // A store without conditional writes, which the Functions app never has
    // (labs-public-http.js hands it cosmos-client.js's): unconditional. One
    // that cannot save at all must not report that it did.
    if (typeof store.upsertDoc !== 'function') {
      throw new TypeError('The store given to the visitor sessions cannot save a session record.');
    }
    await store.upsertDoc(SESSION_CONTAINER, { ...session, status, endedAt });
    return 'written';
  }

  let current = session;
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    try {
      await store.replaceDocIfMatch(
        SESSION_CONTAINER,
        { ...current, status, endedAt },
        { partitionKey: current.id }
      );
      return 'written';
    } catch (error) {
      if (!lostRace(error)) throw error;
    }
    current = await store.readDoc(SESSION_CONTAINER, session.id, session.id);
    if (!current) return 'gone';
    if (current.status !== 'active') return 'finished-elsewhere';
  }
  return 'changed';
}

/**
 * Delete a session's Coder workspace and user. True when Coder accepted both
 * calls, or when there was nothing to call (no broker config, or a record with
 * no workspace or user).
 *
 * The answer is reported to the caller's log and nothing more: the record is
 * saved as over either way, so a refused delete is not tried again. That is the
 * design this module was written to, and it was hidden while the save never
 * worked (the record stayed `active`, so every later request ran the deletes
 * again). Making the final status depend on a confirmed clean-up is its own
 * change, tracked in #1388.
 */
async function cleanUpCoder(fetchImpl, config, session) {
  if (!config) return true;
  let accepted = true;
  if (session.workspaceId) {
    accepted = (await deleteVisitorWorkspace(fetchImpl, config, session.workspaceId)) && accepted;
  }
  if (session.coderUserId) {
    accepted = (await deleteVisitorUser(fetchImpl, config, session.coderUserId)) && accepted;
  }
  return accepted;
}

/**
 * Delete the Coder workspace and user of every session past `expiresAt`, and
 * save each as `expired`.
 *
 * Never throws for one bad session: a store failure that is not a lost race
 * is counted in `failed` and, when `log` is given, reported by kind only
 * (the code or error name, with no session id and no error text). It was once
 * swallowed here without a trace, which is how a reaper that saved nothing ran
 * unnoticed (#1383).
 *
 * @param {object} store
 * @param {Function} fetchImpl
 * @param {{ base: string, token: string } | null} config - null skips Coder
 * @param {object} [options]
 * @param {string} [options.nowIso]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ reaped: number, failed: number }>} `reaped` counts the
 *   sessions this call saved as expired; one a stop ended first is not counted
 */
export async function reapExpiredVisitorSessions(
  store,
  fetchImpl,
  config,
  { nowIso = new Date().toISOString(), log = null } = {}
) {
  if (!store?.queryDocs) return { reaped: 0, failed: 0 };
  const query =
    'SELECT * FROM c WHERE c.type = @type AND c.status = @status AND c.expiresAt <= @nowIso';
  const parameters = [
    { name: '@type', value: VISITOR_JOB_TYPE },
    { name: '@status', value: 'active' },
    { name: '@nowIso', value: nowIso },
  ];
  let expiredSessions = [];
  try {
    expiredSessions = await store.queryDocs(SESSION_CONTAINER, query, parameters);
  } catch (error) {
    // A sweep that never ran must not look like one that found nothing.
    log?.(`visitor-session: the expired sessions could not be listed (${errorKind(error)})`);
    return { reaped: 0, failed: 0 };
  }

  let reaped = 0;
  let failed = 0;
  for (const session of expiredSessions) {
    if (!(await cleanUpCoder(fetchImpl, config, session))) {
      log?.('visitor-session: Coder did not accept every clean-up call for an expired session');
    }
    try {
      const outcome = await finishSession(store, session, 'expired', nowIso);
      if (outcome === 'written') reaped += 1;
      if (outcome === 'changed') {
        failed += 1;
        log?.('visitor-session: an expired session kept changing and was not saved');
      }
    } catch (error) {
      failed += 1;
      log?.(`visitor-session: an expired session could not be saved (${errorKind(error)})`);
    }
  }
  return { reaped, failed };
}

export function createVisitorSessionHandlers({
  store,
  identity,
  fetchImpl = fetch,
  limiter = null,
  clock = () => Date.now(),
}) {
  const jsonResponse = (body, status = 200, headers = {}) => ({
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      ...headers,
    },
    body: JSON.stringify(body),
  });

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

      const client = identity?.fromRequest ? identity.fromRequest(request) : null;
      const clientHash = client?.anonymousKey ? client.anonymousKey() : 'unidentified';
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

      // Proactively reap any expired sessions in background
      const expired = activeSessions.filter((s) => s.expiresAt <= nowIso);
      if (expired.length > 0) {
        // No `log` here: this runs after the answer is sent, and a Functions
        // context must not be written to once its invocation has ended.
        reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
      }

      // Filter unexpired active sessions
      const liveSessions = activeSessions.filter((s) => s.expiresAt > nowIso);
      const myActiveSession = liveSessions.find((s) => s.clientHash === clientHash);

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

      const client = identity?.fromRequest ? identity.fromRequest(request) : null;
      const clientHash = client?.anonymousKey ? client.anonymousKey() : 'unidentified';
      const clientIp = client?.trustedClientIp ? client.trustedClientIp() : null;
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
      // Reclaim capacity from expired sessions
      const expired = activeSessions.filter((s) => s.expiresAt <= nowIso);
      if (expired.length > 0) {
        await reapExpiredVisitorSessions(store, fetchImpl, config, {
          nowIso,
          log: (line) => context?.warn?.(line),
        }).catch(() => {});
      }

      const liveSessions = activeSessions.filter((s) => s.expiresAt > nowIso);
      const existing = liveSessions.find((s) => s.clientHash === clientHash);
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

      const doc = await store.readDoc(SESSION_CONTAINER, sessionId, sessionId);
      if (!doc || doc.type !== VISITOR_JOB_TYPE) {
        return jsonResponse({ ok: false, error: 'Session not found' }, 404);
      }

      // Already ended, or expired by the reaper: whoever finished it did the
      // Coder clean-up, so a second stop (a double click, a retry) has nothing to do.
      if (doc.status !== 'active') {
        return jsonResponse({ ok: true, status: 'ended' });
      }

      if (!(await cleanUpCoder(fetchImpl, readBrokerConfig(env), doc))) {
        context?.warn?.('visitor-session: Coder did not accept every clean-up call for an ended session');
      }

      const nowIso = new Date(clock()).toISOString();
      const outcome = await finishSession(store, doc, 'ended', nowIso);
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
