/**
 * agent-content/keys.js — the pure half of the Agent Content API's key
 * (ADR 0037). Nothing here does I/O.
 *
 * Koda is the owner's content agent, run by an outside service (Muse). It
 * signs in to the site with ONE API key: a random secret the site shows the
 * owner once, on the AI Engine's Koda tab, and then keeps only as a SHA-256
 * hash in one `admin_config` document. The plaintext is never stored, logged
 * or shown again; a lost key is replaced, not recovered.
 *
 * WHY A KEY AND NOT AN ENTRA TOKEN. Every other machine caller here signs in
 * with Entra (the lab agent's App Role, the brains' delegated scopes). Muse's
 * connector cannot: it sends one fixed secret in one header and nothing else,
 * so the choice is a key or no connection. What keeps the key narrow is below:
 * it opens the Drafts stage and the published reads, nothing in /api/cms/*,
 * and it is revoked by deleting one hash, with no cache in front of it.
 *
 * WHAT THE KEY CAN REACH is a closed list of capabilities, each a switch on
 * the Koda tab. All are on when a key is made; none can be added here without
 * code, because a capability is a route group the handlers wire by name.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError } from '../http/error-response.js';

/** The one agent this API serves. A second agent is a second record and a second tab. */
export const AGENT_ID = 'koda';
export const AGENT_DISPLAY_NAME = 'Koda';
/** The key record: one document, in the admin_config partition. */
export const KEY_RECORD_ID = 'agent_content_key:koda';
/** Keys start with this so a pasted value is recognisable, and a wrong paste is refused before any read. */
export const KEY_PREFIX = 'hcwk_';
/** 32 random bytes: 43 base64url characters after the prefix. */
export const KEY_RANDOM_BYTES = 32;
/** How much of the key the admin tab shows, so the owner can tell which key Muse holds. */
export const KEY_HINT_CHARS = 8;
/** Calls a minute, per key (the proposal asked for at least 120). */
export const REQUESTS_PER_MINUTE = 120;
/** The base path Muse calls, relative to the API host's `/api`. */
export const API_BASE_PATH = 'agent-content/v1';

/**
 * What the key may do. `id` is what the handlers wire by; the text is what
 * the Koda tab shows beside each switch.
 */
export const CAPABILITIES = Object.freeze([
  {
    id: 'drafts.read',
    label: 'Read drafts',
    description: 'List the drafts on the Drafts page and open any of them, body included.',
  },
  {
    id: 'drafts.write',
    label: 'Create and edit drafts',
    description:
      'Create a draft from fields or from a whole markdown file, and save changes to a draft or to an article from Drafts that is still in review.',
  },
  {
    id: 'drafts.review',
    label: 'Send to review and back',
    description: 'Move a draft to In Review, and move an article from Drafts back to Drafts.',
  },
  {
    id: 'drafts.delete',
    label: 'Delete drafts',
    description:
      'Delete a draft, or an article from Drafts that is still in review. Nothing live can be deleted.',
  },
  {
    id: 'published.read',
    label: 'Read published posts',
    description: 'Read the published articles the public site shows, in the shape the site reads them.',
  },
]);
export const CAPABILITY_IDS = Object.freeze(CAPABILITIES.map((capability) => capability.id));

/** The identity the Drafts routes record for Koda's writes (createdBy, updatedBy, audit rows). */
export const AGENT_USER = Object.freeze({
  oid: 'agent:koda',
  sub: 'agent:koda',
  preferred_username: 'koda (agent)',
  name: AGENT_DISPLAY_NAME,
  email: null,
  agent: AGENT_ID,
});

/** Thrown for input the owner can correct; the handler answers 400 with the message. */
export class AgentContentInputError extends AuthoredError {}

/** Every capability on: what a new key gets. */
export function defaultCapabilities() {
  return Object.fromEntries(CAPABILITY_IDS.map((id) => [id, true]));
}

/**
 * A capabilities change from the tab, merged over the stored switches.
 * Unknown ids and non-boolean values are refused by name.
 *
 * @param {unknown} input
 * @param {Record<string, boolean>} [base]
 * @returns {Record<string, boolean>}
 */
export function normalizeCapabilities(input, base = defaultCapabilities()) {
  if (input === undefined || input === null) return { ...defaultCapabilities(), ...base };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentContentInputError('capabilities must be an object of switches.');
  }
  const next = { ...defaultCapabilities(), ...base };
  for (const [id, value] of Object.entries(input)) {
    if (!CAPABILITY_IDS.includes(id)) {
      throw new AgentContentInputError(`Not a capability: ${id}`);
    }
    if (typeof value !== 'boolean') {
      throw new AgentContentInputError(`${id} must be true or false.`);
    }
    next[id] = value;
  }
  return next;
}

/** The capabilities a record allows, as the list of ids that are on. */
export function enabledCapabilities(record = {}) {
  const switches = { ...defaultCapabilities(), ...(record.capabilities || {}) };
  return CAPABILITY_IDS.filter((id) => switches[id] !== false);
}

/** A new key: the prefix and 32 random bytes, base64url. */
export function generateKey(random = randomBytes) {
  return `${KEY_PREFIX}${random(KEY_RANDOM_BYTES).toString('base64url')}`;
}

/** SHA-256 of the key, hex: the only form the site stores. */
export function hashKey(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/** The prefix and the first characters of a key, for the tab. Never enough to use. */
export function keyHint(secret) {
  return String(secret).slice(0, KEY_PREFIX.length + KEY_HINT_CHARS);
}

/** Does this look like a key this site issued? Checked before any read, so random bearer tokens cost nothing. */
export function looksLikeKey(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(KEY_PREFIX) &&
    /^[A-Za-z0-9_-]{40,64}$/.test(value.slice(KEY_PREFIX.length))
  );
}

/**
 * Does the presented key hash to the stored hash? Compared in constant time
 * over the two digests, which are always the same length.
 */
export function hashMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const presented = Buffer.from(hashKey(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * The record a Generate (or Rotate) writes. Only the hash and the hint of the
 * secret are kept. `previous` carries the switches and the first creation
 * across a rotation, so rotating the key does not reset what Koda may do.
 */
export function buildKeyRecord({ secret, actor, now = () => new Date(), previous = null }) {
  const stamp = now().toISOString();
  return {
    id: KEY_RECORD_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    agent: AGENT_ID,
    keyHash: hashKey(secret),
    keyHint: keyHint(secret),
    createdAt: previous?.createdAt || stamp,
    createdBy: previous?.createdBy || actor,
    rotatedAt: previous ? stamp : null,
    rotatedBy: previous ? actor : null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    capabilities: normalizeCapabilities(null, previous?.capabilities || {}),
    version: 1,
  };
}

/** Can this record authenticate a caller? A revoked record keeps its history but no hash. */
export function isUsable(record) {
  return Boolean(record && typeof record.keyHash === 'string' && !record.revokedAt);
}

/**
 * What the tab is told about the key. Never the hash: the response is a
 * projection built field by field, so a field added to the record later does
 * not reach the browser by accident.
 */
export function presentKeyRecord(record) {
  if (!record) {
    return { present: false, active: false, capabilities: defaultCapabilities() };
  }
  return {
    present: true,
    active: isUsable(record),
    keyHint: record.keyHint || null,
    createdAt: record.createdAt || null,
    createdBy: record.createdBy || null,
    rotatedAt: record.rotatedAt || null,
    rotatedBy: record.rotatedBy || null,
    lastUsedAt: record.lastUsedAt || null,
    revokedAt: record.revokedAt || null,
    revokedBy: record.revokedBy || null,
    capabilities: { ...defaultCapabilities(), ...(record.capabilities || {}) },
  };
}

/** The minute a request falls in, for the per-minute counter. */
export function minuteBucket(nowMs) {
  return Math.floor(nowMs / 60_000);
}

/** The counter document for this minute (submission_quota expires them after two hours). */
export function quotaKeyFor(nowMs) {
  return `agent-content:${AGENT_ID}:${minuteBucket(nowMs)}`;
}

/** Seconds until the next minute starts, for Retry-After (at least 1). */
export function secondsToNextMinute(nowMs) {
  return Math.max(1, Math.ceil((60_000 - (nowMs % 60_000)) / 1000));
}
