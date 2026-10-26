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
import { recordLabStart } from './lab-starts.js';

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

export async function reapExpiredVisitorSessions(
  store,
  fetchImpl,
  config,
  { nowIso = new Date().toISOString() } = {}
) {
  if (!store?.queryDocs) return { reaped: 0 };
  const query =
    'SELECT * FROM c WHERE c.type = @type AND c.status = @status AND c.expiresAt <= @nowIso';
  const parameters = [
    { name: '@type', value: VISITOR_JOB_TYPE },
    { name: '@status', value: 'active' },
    { name: '@nowIso', value: nowIso },
  ];
  let expiredSessions = [];
  try {
    expiredSessions = await store.queryDocs('lab_jobs', query, parameters);
  } catch {
    return { reaped: 0 };
  }

  let reaped = 0;
  for (const session of expiredSessions) {
    if (config) {
      if (session.workspaceId) {
        await deleteVisitorWorkspace(fetchImpl, config, session.workspaceId);
      }
      if (session.coderUserId) {
        await deleteVisitorUser(fetchImpl, config, session.coderUserId);
      }
    }
    try {
      if (store.replaceDocIfMatch) {
        await store.replaceDocIfMatch(
          'lab_jobs',
          session.id,
          {
            ...session,
            status: 'expired',
            endedAt: nowIso,
          },
          session._etag
        );
      } else if (store.upsertDoc) {
        await store.upsertDoc('lab_jobs', {
          ...session,
          status: 'expired',
          endedAt: nowIso,
        });
      }
      reaped += 1;
    } catch {
      // ignore concurrent reap race
    }
  }
  return { reaped };
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
          'lab_jobs',
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
        'lab_jobs',
        'SELECT * FROM c WHERE c.type = @type AND c.status = @status',
        [
          { name: '@type', value: VISITOR_JOB_TYPE },
          { name: '@status', value: 'active' },
        ]
      );
      // Reclaim capacity from expired sessions
      const expired = activeSessions.filter((s) => s.expiresAt <= nowIso);
      if (expired.length > 0) {
        await reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
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

      await store.createDoc('lab_jobs', doc);

      // The start is real from here: count it, once, as plain per-lab-per-day
      // numbers (lab-starts.js). A counter fault is logged by code only and
      // never reaches the visitor, whose session already exists.
      try {
        const counted = await recordLabStart(store, { labId, nowMs });
        if (!counted.counted) {
          context?.error?.(`visitor-session: lab start not counted (${counted.reason})`);
        }
      } catch (err) {
        context?.error?.(`visitor-session: lab start not counted (${err?.code ?? 'error'})`);
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

      const doc = await store.readDoc('lab_jobs', sessionId, sessionId);
      if (!doc || doc.type !== VISITOR_JOB_TYPE) {
        return jsonResponse({ ok: false, error: 'Session not found' }, 404);
      }

      const config = readBrokerConfig(env);
      if (config) {
        if (doc.workspaceId) {
          await deleteVisitorWorkspace(fetchImpl, config, doc.workspaceId);
        }
        if (doc.coderUserId) {
          await deleteVisitorUser(fetchImpl, config, doc.coderUserId);
        }
      }

      const nowIso = new Date(clock()).toISOString();
      if (store.replaceDocIfMatch) {
        await store.replaceDocIfMatch(
          'lab_jobs',
          sessionId,
          {
            ...doc,
            status: 'ended',
            endedAt: nowIso,
          },
          doc._etag
        );
      } else if (store.upsertDoc) {
        await store.upsertDoc('lab_jobs', {
          ...doc,
          status: 'ended',
          endedAt: nowIso,
        });
      }

      return jsonResponse({ ok: true, status: 'ended' });
    },
  };
}
