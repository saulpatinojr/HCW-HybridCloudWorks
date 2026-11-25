/**
 * developer-api/admin-handlers.js — the admin routes that make, rotate,
 * re-scope and revoke organizer keys for the Developer API (ADR 0042),
 * following the Koda key's routes (lib/agent-content/admin-handlers.js):
 *
 *   GET    cms/developer-api/keys                  every key (never a key), scopes, limits,  editor
 *                                                  and the last yearly clean-up run's counts
 *   POST   cms/developer-api/keys                  make a key; answers the plaintext ONCE    super_admin
 *   PATCH  cms/developer-api/keys/{keyId}          { scopes?, organizerName?, organizerContact? }  super_admin
 *   DELETE cms/developer-api/keys/{keyId}          revoke: the hash is removed at once       super_admin
 *   POST   cms/developer-api/keys/{keyId}/rotate   a new secret for the same organizer; once super_admin
 *
 * and the two routes the owner answers a speaker's erasure request with
 * (#1777; a talk proposal holds the speaker's name, email and bio):
 *
 *   POST   cms/developer-api/proposal-search       { speakerEmail } -> where that address has proposals  super_admin
 *   DELETE cms/developer-api/proposals/{submissionId}   delete one proposal, whoever's call it is on     super_admin
 *
 * The search takes the address in the body, never the query string (addresses
 * end up in logs), and answers ids, event ids, statuses and dates only: enough
 * to delete, nothing of what the speaker wrote. Each search and each delete
 * writes one audit row (owner decision 2026-11-23 for the search: a record of
 * who looked a person up). Neither route's audit row or log line carries the
 * address, any part of it or a hash of it, and the search's row does not carry
 * the proposal ids either: it says who searched, when, how many were found
 * and whether the list was cut short.
 *
 * THE PLAINTEXT IS ANSWERED ONCE, to the super_admin who pressed Generate or
 * Rotate, so they can hand it to the organizer through a secure channel. It is
 * not stored (keys.js keeps the hash), not logged (the audit row carries the
 * hint only) and not shown again.
 *
 * Writes are create-only or under the record's ETag, and each attempt
 * rebuilds the record from a fresh read, so a lost race never writes over a
 * change it did not see.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { authoredMessage, errorResponse, isAuthoredError } from '../http/error-response.js';
import { ENDPOINTS, LIMITS } from './handlers.js';
import {
  API_BASE_PATH,
  DeveloperApiInputError,
  MAX_ORGANIZER_CONTACT,
  MAX_ORGANIZER_NAME,
  SCOPES,
  buildKeyRecord,
  generateKey,
  isKeyId,
  keyRecordId,
  normalizeKeyRequest,
  normalizeScopes,
  presentKeyRecord,
} from './keys.js';
import { Answer, WRITE_ATTEMPTS, actorOf, audit, json } from './admin-shared.js';
import { eraseProposal, findProposals, lastProposalCleanup } from './proposal-erasure.js';

export { MAX_PROPOSALS_FOUND } from './proposal-erasure.js';

export const READ_ROLE = 'editor';
export const WRITE_ROLE = 'super_admin';
/** The most organizer keys the list reads. Far above any real count; a cap so the read is bounded. */
export const MAX_KEYS = 500;

const NO_KEY = () => new Answer(json(404, { ok: false, code: 'NO_KEY', error: 'There is no organizer key with that id.' }));

const optionalText = (value, name, max) => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new DeveloperApiInputError(`${name} must be text.`);
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new DeveloperApiInputError(`${name} must be at most ${max} characters.`);
  return trimmed || null;
};

const readRecord = (store, keyId) => store.readDoc('admin_config', keyRecordId(keyId), ADMIN_CONFIG_PARTITION);

/** The key's record, or the 404 thrown: absent, or not an organizer key. */
async function readKeyRecord(store, keyId) {
  const current = await readRecord(store, keyId);
  if (!current || current.kind !== 'developer_api_key') throw NO_KEY();
  return current;
}

/** Replace an existing record under its ETag, rebuilt from a fresh read; one retry on a lost race. */
async function rewrite(store, keyId, build) {
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readKeyRecord(store, keyId);
    const next = build(current);
    try {
      return (
        (await store.replaceDocIfMatch(
          'admin_config',
          { ...next, _etag: current._etag },
          { partitionKey: ADMIN_CONFIG_PARTITION },
        )) || next
      );
    } catch (error) {
      if (error?.code !== 409 && error?.code !== 412) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

const describe = () => ({
  scopes: SCOPES,
  limits: LIMITS,
  basePath: `/api/${API_BASE_PATH}`,
  endpoints: ENDPOINTS.map(([method, path, who]) => ({ method, path, who })),
});

const keyIdOf = (request) => {
  const keyId = request.params?.keyId;
  if (!isKeyId(keyId)) throw NO_KEY();
  return keyId;
};

/**
 * One route: the role check first, then `work`. An early answer (Answer) is
 * sent as it is, a refusal this code wrote is the 400, anything else the 500.
 */
const route = (deps, role, what, work) => async (request, context) => {
  const auth = await deps.guard.requireRole(request, role);
  if (auth.error) return auth.error;
  try {
    return await work(deps, { request, context, user: auth.user });
  } catch (error) {
    if (error instanceof Answer) return error.response;
    if (isAuthoredError(error)) {
      return json(400, { ok: false, code: 'INVALID', error: authoredMessage(error, `Could not ${what}.`) });
    }
    return errorResponse(context, `Failed to ${what}`, error, 500, request);
  }
};

const body = (request) => request.json().catch(() => null);

/** GET cms/developer-api/keys */
async function listKeys(deps) {
  const rows = await deps.store.queryDocs(
    'admin_config',
    `SELECT TOP ${MAX_KEYS} * FROM c WHERE c.kind = 'developer_api_key' ORDER BY c.createdAt DESC`,
    [],
    { partitionKey: ADMIN_CONFIG_PARTITION },
  );
  return json(200, {
    ok: true,
    keys: (rows || []).map(presentKeyRecord),
    ...describe(),
    proposalCleanup: await lastProposalCleanup(deps),
  });
}

/** POST cms/developer-api/keys — { organizerName, organizerContact?, scopes }. The plaintext is in this answer only. */
async function createKey(deps, { request, user }) {
  const organizer = normalizeKeyRequest(await body(request));
  const { keyId, secret } = deps.generate();
  const record = buildKeyRecord({ keyId, secret, actor: actorOf(user), organizer, now: deps.now });
  const written = (await deps.store.createDoc('admin_config', record)) || record;
  await audit(deps, 'developer_api_key_generated', {
    user,
    request,
    keyId,
    details: { keyHint: written.keyHint, scopes: written.scopes },
  });
  return json(201, { ok: true, key: presentKeyRecord(written), secret, shownOnce: true, ...describe() });
}

/** POST cms/developer-api/keys/{keyId}/rotate — a new secret; the old one stops at once. */
async function rotateKey(deps, { request, user }) {
  const keyId = keyIdOf(request);
  // A revoked key stays revoked: rotating it would quietly bring back its
  // scopes and its calls. A new key is a deliberate act with its own row.
  const current = await readKeyRecord(deps.store, keyId);
  if (current.revokedAt) {
    return json(409, {
      ok: false,
      code: 'KEY_REVOKED',
      error: 'This key is revoked and cannot be rotated. Make a new key for the organizer instead.',
    });
  }
  const { secret } = deps.generate({ keyId });
  const written = await rewrite(deps.store, keyId, (latest) => {
    if (latest.revokedAt) {
      throw new Answer(json(409, { ok: false, code: 'KEY_REVOKED', error: 'This key was revoked meanwhile.' }));
    }
    return {
      ...latest,
      ...buildKeyRecord({ keyId, secret, actor: actorOf(user), organizer: latest, now: deps.now, previous: latest }),
    };
  });
  await audit(deps, 'developer_api_key_rotated', { user, request, keyId, details: { keyHint: written.keyHint } });
  return json(200, { ok: true, key: presentKeyRecord(written), secret, shownOnce: true });
}

/** The fields a PATCH changes, checked; refused when it changes none. */
function keyChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeveloperApiInputError('Send a JSON object with scopes, organizerName or organizerContact.');
  }
  const change = {};
  if (input.scopes !== undefined) change.scopes = normalizeScopes(input.scopes);
  if (input.organizerName !== undefined) {
    const name = optionalText(input.organizerName, 'organizerName', MAX_ORGANIZER_NAME);
    if (!name) throw new DeveloperApiInputError('organizerName cannot be empty.');
    change.organizerName = name;
  }
  if (input.organizerContact !== undefined) {
    change.organizerContact = optionalText(input.organizerContact, 'organizerContact', MAX_ORGANIZER_CONTACT);
  }
  if (Object.keys(change).length === 0) {
    throw new DeveloperApiInputError('Nothing to change: send scopes, organizerName or organizerContact.');
  }
  return change;
}

/** PATCH cms/developer-api/keys/{keyId} — scopes and the organizer's name or contact. */
async function updateKey(deps, { request, user }) {
  const keyId = keyIdOf(request);
  const change = keyChange(await body(request));
  const written = await rewrite(deps.store, keyId, (current) => ({
    ...current,
    ...change,
    changedAt: deps.now().toISOString(),
    changedBy: actorOf(user),
  }));
  await audit(deps, 'developer_api_key_changed', {
    user,
    request,
    keyId,
    details: { fields: Object.keys(change), scopes: written.scopes },
  });
  return json(200, { ok: true, key: presentKeyRecord(written) });
}

/** DELETE cms/developer-api/keys/{keyId} — revoke. The next request with the key is 401. */
async function revokeKey(deps, { request, user }) {
  const keyId = keyIdOf(request);
  const current = await readKeyRecord(deps.store, keyId);
  if (!current.keyHash) return json(200, { ok: true, key: presentKeyRecord(current) });
  const written = await rewrite(deps.store, keyId, (latest) => {
    const { keyHash: _removed, ...rest } = latest;
    return { ...rest, revokedAt: deps.now().toISOString(), revokedBy: actorOf(user) };
  });
  await audit(deps, 'developer_api_key_revoked', { user, request, keyId, details: { keyHint: written.keyHint } });
  return json(200, { ok: true, key: presentKeyRecord(written) });
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard the admin role guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, queryDocs: Function,
 *   deleteDocIfMatch: Function, upsertDoc: Function }} deps.store `upsertDoc` writes audit rows only;
 *   `deleteDocIfMatch` deletes a proposal for an erasure request
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {(options?: object) => { keyId: string, secret: string }} [deps.generate]
 * @param {object} [deps.log]
 */
export function createDeveloperApiAdminHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  generate = generateKey,
  log = {},
}) {
  const deps = { guard, store, now, uuid, generate, log };
  return {
    listKeys: route(deps, READ_ROLE, 'list the organizer keys', listKeys),
    createKey: route(deps, WRITE_ROLE, 'make the organizer key', createKey),
    rotateKey: route(deps, WRITE_ROLE, 'rotate the organizer key', rotateKey),
    updateKey: route(deps, WRITE_ROLE, 'change the organizer key', updateKey),
    revokeKey: route(deps, WRITE_ROLE, 'revoke the organizer key', revokeKey),
    findProposals: route(deps, WRITE_ROLE, 'search the proposals', findProposals),
    eraseProposal: route(deps, WRITE_ROLE, 'delete the proposal', eraseProposal),
  };
}
