/**
 * agent-content/keys.js — the pure half of the Agent Content API's key
 * (ADR 0037). Nothing here does I/O.
 *
 * Koda is the owner's content agent, run by an outside service (Muse). It
 * signs in to the site with ONE API key: a random secret the site shows the
 * owner once, on the Agents page's Koda tab, and then keeps only as a SHA-256
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
 * WHAT EACH KEY CAN REACH is a closed list of capabilities, each a switch on
 * the key's own tab. Each key starts with only the switches its row lists
 * (agent-keys.js), and a capability added later starts off. None can be
 * added here without code, because a capability is a route group the
 * handlers wire by name.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError } from '../http/error-response.js';
import { presentedKey } from '../presented-key.js';
import { DEFAULT_AGENT_KEY, agentKeyById, agentKeyByRecordId } from './agent-keys.js';

export { AGENT_KEYS, AGENT_KEY_IDS, agentKeyById, agentKeyByRecordId, isAgentUser } from './agent-keys.js';

/**
 * Koda's key, the first in the list (agent-keys.js). These three names are
 * kept as Koda's so every caller that meant "the agent key" before the site
 * could hold more than one still means Koda's.
 */
export const AGENT_ID = DEFAULT_AGENT_KEY.id;
export const AGENT_DISPLAY_NAME = DEFAULT_AGENT_KEY.displayName;
/** The key record: one document, in the admin_config partition. */
export const KEY_RECORD_ID = DEFAULT_AGENT_KEY.recordId;
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
    id: 'published.read',
    label: 'Read published posts',
    description: 'Read the published articles the public site shows, in the shape the site reads them.',
  },
  // The admin sections (ADR 0038). Each opens the routes admin-access.js lists
  // under it, through the admin role guard, with the same key.
  {
    id: 'admin.pipeline',
    label: 'Pipeline (New Content, Drafts, Review Queue, Editor, Live Pages)',
    description:
      'Read all content, create and edit articles, generate drafts and images, move content between review states, and read the queue and publish boards. No publishing, scheduling, unpublishing or deleting.',
  },
  {
    id: 'admin.enhanced',
    label: 'Enhanced (Listen & Learn, Labs, Frameworks, Coder Corner, Blogs)',
    description:
      'Read, create and edit Listen & Learn books and chapters and blog sources; read the lab estate. No deleting, no lab launches, no agent changes.',
  },
  {
    id: 'admin.brain',
    label: 'Second Brain',
    description:
      'Read, search, ask, create and edit your private notes and collections, acting as you. No reindex and no desktop sync routes.',
  },
  {
    id: 'admin.spotlight',
    label: 'Spotlight (Speaking, Certifications, Ambassador, Doc Vault)',
    description: 'Read, create and edit talks, credentials, applications, evidence and vault documents. No deleting or trashing.',
  },
  {
    id: 'admin.platform',
    label: 'Platform (Health, Integrations, Cost, Search Console, Settings and alerts)',
    description:
      'Read every Platform page: health, the integration status, the Cost page, Search Console and Platform Settings; read the alerts sent to your phone, the calendar alerts, job states and the review queue; run a connection test or a Search Console run; and acknowledge, resolve or reopen a workflow alert. No settings writes, keys or secrets, no change to the cost ledger, no sending an alert to your phone again, and no deleting.',
  },
  // The Cloudflare sections (#1905). Reading is one switch; each kind of
  // change is its own, so the owner opens only what a task needs. None of
  // them reaches what Terraform manages or the site's own address, and none
  // deletes (cloudflare/protected.js says what is refused and why). The
  // texts below promise no more than cloudflare/handlers.test.js proves.
  {
    id: 'admin.cloudflare',
    label: 'Cloudflare: read',
    description:
      "Read the site's Cloudflare zone on the Cloudflare page: its status, every zone setting, the DNS records, the rulesets and whether the Cloudflare token works. Rules in a phase that cannot be edited from the page are shown without what they carry, and secret-looking header values are hidden. No changes.",
  },
  {
    id: 'admin.cloudflare.settings',
    label: 'Cloudflare: change zone settings and purge the cache',
    description:
      'Change a zone setting (security level, caching, speed and the like) and purge the cache. Never the SSL mode, the minimum TLS version, Always Use HTTPS, HSTS or the certificate Cloudflare shows the site: only you change those, on the Cloudflare page. Each change is recorded in the audit log with its old and new value, and sent to your phone.',
  },
  {
    id: 'admin.cloudflare.dns',
    label: 'Cloudflare: add and edit DNS records',
    description:
      "Add or edit A, AAAA, CNAME, MX and TXT records. Never the site's own address (the apex and www), a record Terraform manages, the lab's records, a certificate check, or a wildcard over any of them, and never a delete. Each change is recorded and sent to your phone.",
  },
  {
    id: 'admin.cloudflare.rules',
    label: 'Cloudflare: edit rules',
    description:
      "Add rules and change existing ones in six kinds of phase: redirects, URL rewrites, response headers, configuration rules, custom security rules (never one that skips the other checks) and rate limiting (the API's rate limit lives there). It may not remove a rule: a list that leaves out a rule the phase has now is refused, and removing one is done by you on the Cloudflare page. Every other phase is read-only. These rules can still redirect or change requests to the API, or loosen its rate limit, so turn this on only for a task that needs it.",
  },
]);
export const CAPABILITY_IDS = Object.freeze(CAPABILITIES.map((capability) => capability.id));

/**
 * The identity an agent key's writes are recorded under (createdBy,
 * updatedBy, audit rows): `agent:<id>` and `<id> (agent)`, from its row.
 *
 * @param {{ id: string, displayName: string }} entry a row of AGENT_KEYS
 */
export function agentUserOf(entry) {
  return Object.freeze({
    oid: `agent:${entry.id}`,
    sub: `agent:${entry.id}`,
    preferred_username: `${entry.id} (agent)`,
    name: entry.displayName,
    email: null,
    agent: entry.id,
  });
}

/** Koda's identity. */
export const AGENT_USER = agentUserOf(DEFAULT_AGENT_KEY);

/** Thrown for input the owner can correct; the handler answers 400 with the message. */
export class AgentContentInputError extends AuthoredError {}

/**
 * The row a caller means: the one named, or Koda's when none is named, so
 * every older caller reads as before. An id that names no row has none
 * (null), and its switches are all off.
 */
const rowFor = (agentId) => (agentId === undefined ? DEFAULT_AGENT_KEY : agentKeyById(agentId));

/**
 * The agent a key record belongs to: by its document id, else by the agent
 * it names. A record with neither is Koda's, as every record was before the
 * site could hold more than one key; one that names an id the list does not
 * have belongs to none, so its switches read as off.
 */
export function agentIdOfRecord(record) {
  if (typeof record?.id === 'string') return agentKeyByRecordId(record.id)?.id ?? null;
  if (typeof record?.agent === 'string') return agentKeyById(record.agent)?.id ?? null;
  return AGENT_ID;
}

/**
 * What a new key gets: the capabilities its row lists (agent-keys.js
 * `switchesOnWhenMade`; Koda's lists the nine that existed before the
 * Cloudflare switches, Claude Publisher's reading and writing drafts, Claude
 * Network Guy's reading Cloudflare), and none for an id the list
 * does not have. There is no delete switch to turn on: the key
 * never deletes (owner instruction 2026-11-01: create, produce and review,
 * never delete), so the v1 delete route is gone.
 *
 * @param {string} [agentId] Koda's when absent
 */
export function defaultCapabilities(agentId) {
  const made = rowFor(agentId)?.switchesOnWhenMade;
  const on = (id) => made === true || (Array.isArray(made) && made.includes(id));
  return Object.fromEntries(CAPABILITY_IDS.map((id) => [id, on(id)]));
}

/**
 * A capabilities change from the tab, merged over the stored switches.
 * Unknown ids and non-boolean values are refused by name.
 *
 * @param {unknown} input
 * @param {Record<string, boolean>} [base]
 * @param {string} [agentId] whose defaults fill a switch neither names; Koda's when absent
 * @returns {Record<string, boolean>}
 */
export function normalizeCapabilities(input, base = undefined, agentId = undefined) {
  base ??= defaultCapabilities(agentId);
  if (input === undefined || input === null) return { ...defaultCapabilities(agentId), ...base };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentContentInputError('capabilities must be an object of switches.');
  }
  const next = { ...defaultCapabilities(agentId), ...base };
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

/**
 * A record's switches, with the defaults of the key it belongs to filling
 * any switch it never stored: on for Koda's, and for a key added later only
 * the ones its row starts on.
 */
export function capabilitySwitches(record = {}) {
  const defaults = defaultCapabilities(agentIdOfRecord(record));
  const stored = record?.capabilities || {};
  // A stored true or false wins; anything else (absent, or not a boolean)
  // takes the key's default, as Koda's record has always been read.
  const extra = Object.fromEntries(
    Object.entries(stored).filter(([id]) => !Object.hasOwn(defaults, id)),
  );
  const known = Object.fromEntries(
    CAPABILITY_IDS.map((id) => [id, typeof stored[id] === 'boolean' ? stored[id] : defaults[id]]),
  );
  return { ...known, ...extra };
}

/** The capabilities a record allows, as the list of ids that are on. */
export function enabledCapabilities(record = {}) {
  const switches = capabilitySwitches(record || {});
  return CAPABILITY_IDS.filter((id) => switches[id] === true);
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

/** Header names, besides Authorization, a connector may put an API key in. */
export const KEY_HEADERS = Object.freeze(['x-api-key', 'x-agent-key']);

/**
 * The key a request presents, in any of the shapes connectors send:
 * `Authorization: Bearer <key>`, the bare key as the whole Authorization value
 * (a connector that drops the scheme), or an X-API-Key / X-Agent-Key header.
 * A non-empty Authorization wins; one that is absent or blank is the same
 * thing, and the key headers are read. Muse's first calls on 2026-11-01
 * carried a working key in one of the other shapes and were refused for it;
 * the same hash compare sits behind every shape, so reading them costs
 * nothing. A query string is never read: URLs end up in logs.
 *
 * Lives here, not in guard.js, because the admin role guard (admin-access.js)
 * asks the same question to decide which path a request takes.
 *
 * @param {{ headers?: { get?: (name: string) => string | null } }} request
 * @returns {string | null}
 */
export function agentKeyFrom(request) {
  return presentedKey(request, { keyHeaders: KEY_HEADERS, looksLikeKey });
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
 * across a rotation, so rotating the key does not reset what it may do.
 * `agentId` names the key (Koda's when absent); a new key's switches are its
 * row's `switchesOnWhenMade`.
 */
export function buildKeyRecord({ secret, actor, now = () => new Date(), previous = null, agentId = AGENT_ID }) {
  const entry = agentKeyById(agentId);
  if (!entry) throw new Error('buildKeyRecord: not an agent key');
  const stamp = now().toISOString();
  return {
    id: entry.recordId,
    configScope: ADMIN_CONFIG_PARTITION,
    agent: entry.id,
    keyHash: hashKey(secret),
    keyHint: keyHint(secret),
    createdAt: previous?.createdAt || stamp,
    createdBy: previous?.createdBy || actor,
    rotatedAt: previous ? stamp : null,
    rotatedBy: previous ? actor : null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    capabilities: normalizeCapabilities(null, previous?.capabilities || {}, entry.id),
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
export function presentKeyRecord(record, agentId = undefined) {
  if (!record) {
    return { present: false, active: false, capabilities: defaultCapabilities(agentId) };
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
    capabilities: capabilitySwitches(record),
  };
}

/** The minute a request falls in, for the per-minute counter. */
export function minuteBucket(nowMs) {
  return Math.floor(nowMs / 60_000);
}

/** The counter document for this minute and this key (submission_quota expires them after two hours). */
export function quotaKeyFor(nowMs, agentId = AGENT_ID) {
  return `agent-content:${agentId}:${minuteBucket(nowMs)}`;
}

/** Seconds until the next minute starts, for Retry-After (at least 1). */
export function secondsToNextMinute(nowMs) {
  return Math.max(1, Math.ceil((60_000 - (nowMs % 60_000)) / 1000));
}
