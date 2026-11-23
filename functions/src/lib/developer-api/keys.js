/**
 * developer-api/keys.js — the pure half of the organizer keys for the
 * Developer API (ADR 0042). Nothing here does I/O.
 *
 * An organizer is a person who runs a community event and calls this API from
 * their own code. Each one gets their OWN key, made by a super_admin in the
 * admin, shown once, and then kept only as a SHA-256 hash in one
 * `admin_config` document per organizer. The plaintext is never stored,
 * logged or shown again; a lost key is rotated, not recovered.
 *
 * WHY THE KEY CARRIES ITS OWN ID. Koda's key (ADR 0037) is one record, so the
 * guard always knows which record to read. Here there are many organizers, and
 * the guard must still read exactly ONE record per request: no query, no
 * cache, so revoking a key cuts the very next request. So the key is
 * `hcdk_<keyId>_<secret>`: the guard takes the id from the key, point-reads
 * `developer_api_key:<keyId>`, and compares the hash of the whole key in
 * constant time. The id alone is useless without the secret.
 *
 * WHY `hcdk_` AND NOT `hcwk_`. A distinct prefix means an organizer key can
 * never be mistaken for Koda's key by either guard: each refuses the other's
 * shape before any read.
 *
 * WHAT A KEY CAN REACH is a closed list of scopes (ADR 0042 decision 2). No
 * scope publishes anything: publishing stays a human act in the admin
 * (decision 6), and there is no scope to switch on that would change that.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError } from '../http/error-response.js';

/** Keys start with this, so a pasted value is recognisable and a wrong paste is refused before any read. */
export const KEY_PREFIX = 'hcdk_';
/** The key id: 8 random bytes as 16 lower-case hex characters. */
export const KEY_ID_BYTES = 8;
/** The secret part: 32 random bytes, 43 base64url characters. */
export const KEY_SECRET_BYTES = 32;
/** How much of the key the admin shows, so the owner can tell keys apart. Never enough to use. */
export const KEY_HINT_CHARS = 8;
/** Keyed calls a minute, per key. */
export const REQUESTS_PER_MINUTE = 120;
/** The base path organizers call, relative to the API host's `/api`. */
export const API_BASE_PATH = 'developer/v1';
/** The `admin_config` id prefix of an organizer key record. */
export const KEY_RECORD_PREFIX = 'developer_api_key:';
/** Organizer name: what the admin list and the audit rows show. */
export const MAX_ORGANIZER_NAME = 120;
/** Contact note on a key (an email or a line of text), for the owner only. */
export const MAX_ORGANIZER_CONTACT = 254;

const KEY_ID_RE = /^[0-9a-f]{16}$/;
const KEY_SHAPE_RE = /^hcdk_([0-9a-f]{16})_([A-Za-z0-9_-]{40,64})$/;

/** What a key may do. `id` is what the routes check; the text is what the admin shows. */
export const SCOPES = Object.freeze([
  {
    id: 'events:read',
    label: 'Read events',
    description:
      'Read your own events, drafts included. (Published events are public and need no key.) Used by Phase 2.',
  },
  {
    id: 'events:write',
    label: 'Create and edit events',
    description:
      'Create events in draft, build the program, manage sponsors and duplicate a past event. Never publishes. Used by Phase 2.',
  },
  {
    id: 'cfs:manage',
    label: 'Manage calls for speakers',
    description:
      'Open and close a call for speakers on your events, list the talk proposals sent to it, and accept or reject them.',
  },
]);
export const SCOPE_IDS = Object.freeze(SCOPES.map((scope) => scope.id));

/** Thrown for input the owner or organizer can correct; the handler answers 400 with the message. */
export class DeveloperApiInputError extends AuthoredError {}

/** The `admin_config` id of a key record. */
export function keyRecordId(keyId) {
  return `${KEY_RECORD_PREFIX}${keyId}`;
}

/** Is this a key id this module makes? Checked before any id reaches a read. */
export function isKeyId(value) {
  return typeof value === 'string' && KEY_ID_RE.test(value);
}

/**
 * A new key: the prefix, a fresh id and a fresh secret. `keyId` is passed on a
 * rotation, so the organizer's record (and its history) stays the same one.
 *
 * @param {{ keyId?: string, random?: (size: number) => Buffer }} [options]
 * @returns {{ keyId: string, secret: string }}
 */
export function generateKey({ keyId, random = randomBytes } = {}) {
  const id = keyId && isKeyId(keyId) ? keyId : random(KEY_ID_BYTES).toString('hex');
  return { keyId: id, secret: `${KEY_PREFIX}${id}_${random(KEY_SECRET_BYTES).toString('base64url')}` };
}

/** SHA-256 of the whole key, hex: the only form the site stores. */
export function hashKey(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/** The prefix, the id and the first characters of the secret, for the admin list. */
export function keyHint(secret) {
  const parsed = parseKey(secret);
  if (!parsed) return null;
  return `${KEY_PREFIX}${parsed.keyId}_${parsed.rest.slice(0, KEY_HINT_CHARS)}`;
}

/**
 * The id inside a key this site issued, or null for anything else. Checked
 * before any read, so a random bearer token costs nothing.
 */
export function parseKey(value) {
  if (typeof value !== 'string') return null;
  const match = KEY_SHAPE_RE.exec(value);
  return match ? { keyId: match[1], rest: match[2] } : null;
}

/** Does this look like an organizer key? */
export function looksLikeKey(value) {
  return parseKey(value) !== null;
}

/** Header names, besides Authorization, a client may put the key in. */
export const KEY_HEADERS = Object.freeze(['x-api-key']);

/**
 * The key a request presents: `Authorization: Bearer <key>`, the bare key as
 * the whole Authorization value, or an `X-API-Key` header (ADR 0042 decision
 * 2, the same shapes ADR 0037 accepts). A non-empty Authorization wins. A
 * query string is never read: addresses end up in logs.
 *
 * @param {{ headers?: { get?: (name: string) => string | null } }} request
 * @returns {string | null}
 */
export function developerKeyFrom(request) {
  const read = (name) => {
    const value = request?.headers?.get?.(name);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const authorization = read('authorization');
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer) return bearer[1].trim() || null;
    return looksLikeKey(authorization) ? authorization : null;
  }
  for (const name of KEY_HEADERS) {
    const value = read(name);
    if (value) return value;
  }
  return null;
}

/** Does the presented key hash to the stored hash? Constant time over two equal-length digests. */
export function hashMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const presented = Buffer.from(hashKey(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * The scopes of a new or changed key, from the admin's list. Unknown ids and
 * duplicates are refused by name; an empty list is refused, because a key that
 * can do nothing is a mistake, not a choice.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeScopes(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new DeveloperApiInputError(`scopes must be a non-empty list of: ${SCOPE_IDS.join(', ')}.`);
  }
  const out = [];
  for (const value of input) {
    if (typeof value !== 'string' || !SCOPE_IDS.includes(value)) {
      throw new DeveloperApiInputError(`Not a scope: ${String(value).slice(0, 40)}`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return SCOPE_IDS.filter((id) => out.includes(id));
}

/** A trimmed, length-capped single-line text field, or the error sentence. */
function textField(value, name, max, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DeveloperApiInputError(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new DeveloperApiInputError(`${name} must be text.`);
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed && required) throw new DeveloperApiInputError(`${name} is required.`);
  if (trimmed.length > max) throw new DeveloperApiInputError(`${name} must be at most ${max} characters.`);
  return trimmed || null;
}

/**
 * What the admin sends to make a key: the organizer's name, an optional
 * contact, and the scopes. Nothing else is read.
 */
export function normalizeKeyRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DeveloperApiInputError('Send a JSON object with organizerName and scopes.');
  }
  return {
    organizerName: textField(body.organizerName, 'organizerName', MAX_ORGANIZER_NAME, { required: true }),
    organizerContact: textField(body.organizerContact, 'organizerContact', MAX_ORGANIZER_CONTACT, {
      required: false,
    }),
    scopes: normalizeScopes(body.scopes),
  };
}

/**
 * The record a Generate writes, or the record a Rotate rewrites. Only the hash
 * and the hint of the secret are kept. `previous` carries the organizer, the
 * scopes and the first creation across a rotation.
 */
export function buildKeyRecord({ keyId, secret, actor, organizer, now = () => new Date(), previous = null }) {
  const stamp = now().toISOString();
  return {
    id: keyRecordId(keyId),
    configScope: ADMIN_CONFIG_PARTITION,
    kind: 'developer_api_key',
    keyId,
    organizerName: previous?.organizerName || organizer.organizerName,
    organizerContact: previous ? previous.organizerContact || null : organizer.organizerContact || null,
    scopes: previous?.scopes || organizer.scopes,
    keyHash: hashKey(secret),
    keyHint: keyHint(secret),
    createdAt: previous?.createdAt || stamp,
    createdBy: previous?.createdBy || actor,
    rotatedAt: previous ? stamp : null,
    rotatedBy: previous ? actor : null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    version: 1,
  };
}

/** Can this record authenticate a caller? A revoked record keeps its history but no hash. */
export function isUsable(record) {
  return Boolean(
    record && record.kind === 'developer_api_key' && typeof record.keyHash === 'string' && !record.revokedAt,
  );
}

/** The scopes a record allows, filtered to the scopes this code knows. */
export function scopesOf(record = {}) {
  const stored = Array.isArray(record?.scopes) ? record.scopes : [];
  return SCOPE_IDS.filter((id) => stored.includes(id));
}

/**
 * What the admin is told about a key. Never the hash: a projection built
 * field by field, so a field added to the record later does not reach the
 * browser by accident.
 */
export function presentKeyRecord(record) {
  return {
    keyId: record.keyId || null,
    organizerName: record.organizerName || null,
    organizerContact: record.organizerContact || null,
    scopes: scopesOf(record),
    active: isUsable(record),
    keyHint: record.keyHint || null,
    createdAt: record.createdAt || null,
    createdBy: record.createdBy || null,
    rotatedAt: record.rotatedAt || null,
    rotatedBy: record.rotatedBy || null,
    lastUsedAt: record.lastUsedAt || null,
    revokedAt: record.revokedAt || null,
    revokedBy: record.revokedBy || null,
  };
}

/** The identity the routes record for an organizer's writes (audit rows, ownership). */
export function organizerUser(record) {
  return Object.freeze({
    oid: `developer:${record.keyId}`,
    sub: `developer:${record.keyId}`,
    name: record.organizerName || 'organizer',
    email: null,
    preferred_username: `${record.organizerName || 'organizer'} (developer key)`,
    developerKeyId: record.keyId,
    keyHint: record.keyHint || null,
  });
}

/** The minute a request falls in, for the per-key counter. */
export function minuteBucket(nowMs) {
  return Math.floor(nowMs / 60_000);
}

/** The counter document for this key and minute (submission_quota expires them after two hours). */
export function quotaKeyFor(keyId, nowMs) {
  return `developer-api:${keyId}:${minuteBucket(nowMs)}`;
}

/** Seconds until the next minute starts, for Retry-After (at least 1). */
export function secondsToNextMinute(nowMs) {
  return Math.max(1, Math.ceil((60_000 - (nowMs % 60_000)) / 1000));
}
