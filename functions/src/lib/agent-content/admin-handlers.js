/**
 * agent-content/admin-handlers.js — the routes behind each agent key's tab
 * (ADR 0037), all on one template, cms/agent-content/key. Every route takes
 * the key it acts on as `?agent=<id>`, checked against the list of agent
 * keys (agent-keys.js); with no `agent` it is Koda's, as it always was, and
 * an id the list does not have is refused with 400 before anything is read.
 *
 *   GET     the key's state (never the key), the capability list, the limits
 *           and the endpoints, for the tab to show              editor
 *   POST    make the key, or replace it (rotate); answers the plaintext ONCE   super_admin
 *   PATCH   { capabilities } — switch what the key may do                      super_admin
 *   DELETE  revoke: the hash is removed, the record keeps its history           super_admin
 *
 * THE PLAINTEXT IS ANSWERED ONCE, to the super_admin who pressed Generate,
 * so they can paste it into the secure field of whatever holds the key
 * (Muse's connector page, for Koda's). It is not stored
 * (keys.js keeps the hash), not logged (the audit row carries the hint only)
 * and not shown again: a lost key is rotated. This is different from the
 * Keys tab's credentials, which the app itself consumes from Key Vault and
 * therefore never need to be read back; an agent key is consumed outside the site.
 *
 * Writes are create-only or under the record's ETag (createDoc, then
 * replaceDocIfMatch) and each attempt rebuilds the record from a fresh read,
 * so a lost race never writes over a change it did not see. Two tabs that
 * press Generate together both get a key: the later write is a rotation and
 * the earlier key is dead at once, which is what Generate means.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { authoredMessage, errorResponse, isAuthoredError, errorFacts } from '../http/error-response.js';
import { describePolicy } from './admin-access.js';
import {
  AGENT_ID,
  API_BASE_PATH,
  CAPABILITIES,
  agentKeyById,
  buildKeyRecord,
  generateKey,
  normalizeCapabilities,
  presentKeyRecord,
} from './keys.js';
import { ENDPOINTS, LIMITS } from './handlers.js';

export const READ_ROLE = 'editor';
export const WRITE_ROLE = 'super_admin';
const WRITE_ATTEMPTS = 2;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Thrown inside a write's build step to answer with a refusal; the route wrapper returns it. */
class Answer extends Error {
  constructor(response) {
    super('answered');
    this.response = response;
  }
}
const NO_KEY = () =>
  new Answer(json(404, { ok: false, code: 'NO_KEY', error: 'There is no agent key yet. Generate one first.' }));

const actorOf = (user = {}) =>
  [user.email, user.preferred_username, user.oid, user.sub].find(Boolean) || 'admin';

const readRecord = (store, key) => store.readDoc('admin_config', key.recordId, ADMIN_CONFIG_PARTITION);

/** The `agent` a request names: from the query, or '' when it names none. */
function agentParam(request) {
  const fromQuery = request?.query?.get?.('agent');
  if (typeof fromQuery === 'string') return fromQuery;
  try {
    return new URL(request?.url || '', 'http://request.local').searchParams.get('agent') ?? '';
  } catch {
    return '';
  }
}

/** The agent key a request acts on: Koda's when it names none; throws a 400 answer for one not on the list. */
function keyOf(request) {
  const named = agentParam(request).trim();
  const key = agentKeyById(named || AGENT_ID);
  if (!key) {
    throw new Answer(json(400, { ok: false, code: 'UNKNOWN_AGENT', error: 'There is no agent key by that name.' }));
  }
  return key;
}

/** One audit row for a key change. Best effort: a failed row is logged, never answered. */
async function audit({ store, now, uuid, log }, action, { key, user, request, details = {} }) {
  try {
    await store.upsertDoc('admin_audit_logs', {
      id: uuid(),
      timestamp: now().toISOString(),
      action,
      userId: user.oid || user.sub || null,
      userEmail: user.email || null,
      resourceType: 'agent_content_key',
      resourceId: key.id,
      details,
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    log.error?.(`[agent-content] audit row ${action} failed`, errorFacts(error));
  }
}

/** One write of the record: a create when there is none, otherwise a replace under the ETag this attempt read. */
async function writeOnce(store, current, next) {
  if (!current) return (await store.createDoc('admin_config', next)) || next;
  // The ETag travels inside the document (cosmos-call-shape.js): the
  // replace is conditional on the version this attempt read.
  return (
    (await store.replaceDocIfMatch(
      'admin_config',
      { ...next, _etag: current._etag },
      { partitionKey: ADMIN_CONFIG_PARTITION },
    )) || next
  );
}

/**
 * Create the record, or replace it under its ETag; one retry on a lost
 * race. `build` receives the record as this attempt read it (null before
 * the first key), so a retry works from the latest version, never from a
 * value computed before the race.
 */
async function write(store, key, build) {
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readRecord(store, key);
    const next = build(current);
    try {
      return await writeOnce(store, current, next);
    } catch (error) {
      if (error?.code !== 409 && error?.code !== 412) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

const describe = (record, key) => ({
  ok: true,
  agent: key.id,
  displayName: key.displayName,
  switchesOnWhenMade: key.switchesOnWhenMade,
  key: presentKeyRecord(record, key.id),
  capabilities: CAPABILITIES,
  limits: LIMITS,
  basePath: `/api/${API_BASE_PATH}`,
  endpoints: ENDPOINTS.map(([method, path, capability]) => ({ method, path, capability })),
  adminAccess: describePolicy(record, key.id),
});

/** A route: the role check, then `work`, with its refusals and failures turned into answers. */
function route(guard, role, what, work) {
  return async (request, context) => {
    const auth = await guard.requireRole(request, role);
    if (auth.error) return auth.error;
    try {
      return await work({ request, context, user: auth.user, key: keyOf(request) });
    } catch (error) {
      if (error instanceof Answer) return error.response;
      if (isAuthoredError(error)) {
        return json(400, { ok: false, code: 'INVALID', error: authoredMessage(error, `Could not ${what}.`) });
      }
      return errorResponse(context, `Failed to ${what}`, error, 500);
    }
  };
}

/** POST cms/agent-content/key — make or rotate. The plaintext is in this answer and nowhere else. */
async function generateKeyWork(deps, { request, user, key }) {
  const { store, now, generate } = deps;
  const secret = generate();
  const actor = actorOf(user);
  let rotated = false;
  const written = await write(store, key, (current) => {
    rotated = Boolean(current?.keyHash || current?.revokedAt);
    return { ...(current || {}), ...buildKeyRecord({ secret, actor, now, previous: current, agentId: key.id }) };
  });
  await audit(deps, rotated ? 'agent_content_key_rotated' : 'agent_content_key_generated', {
    key,
    user,
    request,
    details: { keyHint: written.keyHint },
  });
  return json(201, { ...describe(written, key), secret, shownOnce: true });
}

/** PATCH cms/agent-content/key — { capabilities: { id: boolean } } */
async function updateCapabilitiesWork(deps, { request, user, key }) {
  const { store, now } = deps;
  const body = await request.json().catch(() => ({}));
  // The change is one or more switches, merged over the switches as they
  // are at write time (inside the build, so a retry after a lost race
  // merges over the other tab's change instead of reverting it).
  const change = normalizeCapabilities(body?.capabilities, {}, key.id);
  const asked = Object.keys(body?.capabilities || {});
  const written = await write(store, key, (latest) => {
    if (!latest) throw NO_KEY();
    const merged = { ...normalizeCapabilities(null, latest.capabilities || {}, key.id) };
    for (const id of asked) merged[id] = change[id];
    return {
      ...latest,
      capabilities: merged,
      capabilitiesChangedAt: now().toISOString(),
      capabilitiesChangedBy: actorOf(user),
    };
  });
  await audit(deps, 'agent_content_capabilities_changed', {
    key,
    user,
    request,
    details: { capabilities: written.capabilities },
  });
  return json(200, describe(written, key));
}

/** DELETE cms/agent-content/key — revoke. The next request with the old key is 401. */
async function revokeKeyWork(deps, { request, user, key }) {
  const { store, now } = deps;
  const current = await readRecord(store, key);
  if (!current || !current.keyHash) {
    return json(200, describe(current, key));
  }
  const written = await write(store, key, (latest) => {
    const { keyHash: _removed, ...rest } = latest;
    return { ...rest, revokedAt: now().toISOString(), revokedBy: actorOf(user) };
  });
  await audit(deps, 'agent_content_key_revoked', { key, user, request, details: { keyHint: written.keyHint } });
  return json(200, describe(written, key));
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard the admin role guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, upsertDoc: Function }} deps.store
 *   `upsertDoc` writes audit rows only.
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => string} [deps.generate] the key generator (keys.js generateKey)
 * @param {object} [deps.log]
 */
export function createAgentContentAdminHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  generate = generateKey,
  log = {},
}) {
  const deps = { store, now, uuid, generate, log };
  return {
    /** GET cms/agent-content/key */
    getKey: route(guard, READ_ROLE, 'read the agent key', async ({ key }) =>
      json(200, describe(await readRecord(store, key), key)),
    ),

    /** POST cms/agent-content/key — make or rotate. The plaintext is in this answer and nowhere else. */
    generateKey: route(guard, WRITE_ROLE, 'generate the agent key', (args) => generateKeyWork(deps, args)),

    /** PATCH cms/agent-content/key — { capabilities: { id: boolean } } */
    updateCapabilities: route(guard, WRITE_ROLE, 'change the agent key', (args) => updateCapabilitiesWork(deps, args)),

    /** DELETE cms/agent-content/key — revoke. The next request with the old key is 401. */
    revokeKey: route(guard, WRITE_ROLE, 'revoke the agent key', (args) => revokeKeyWork(deps, args)),
  };
}
