/**
 * The agent key tabs' pure half (ADR 0037): what the API's answer becomes on
 * the screen. No I/O, no React, so every sentence the owner reads is testable
 * without a render. Koda's tab reads exactly as it always has; another key's
 * tab uses the same sentences with its own name and no outside service.
 */
import { KODA_KEY_TAB } from './agentKeys';

/**
 * The words a tab uses for its key: its name, its agent id, what holds the
 * key on the other side (Muse, for Koda's; the key itself, for any other),
 * where the key is pasted, and which switches a new key starts with
 * (`true` for all, or the capability ids that start on).
 *
 * @param {{ id: string, displayName: string, switchesOnWhenMade?: boolean|string[],
 *   description?: string, secureField?: string }} [agent]
 */
export function agentWords(agent = KODA_KEY_TAB) {
  const koda = agent.id === KODA_KEY_TAB.id;
  const field = agent.secureField || `the secure field ${agent.displayName} asks for`;
  return {
    id: agent.id,
    name: agent.displayName,
    koda,
    client: koda ? 'Muse' : agent.displayName,
    // "pasted into …" and "Paste the key into …"
    pasteTarget: koda ? 'Muse' : field,
    secureField: koda ? 'Muse’s secure field' : field,
    revealText: koda
      ? 'Copy it into Muse’s secure connector page now. The site keeps a fingerprint, not the key: if it is lost, rotate it.'
      : `Copy it now and paste it into ${field}. The site keeps only its hash, not the key: if it is lost, rotate it.`,
    description: agent.description || null,
    switchesOnWhenMade: agent.switchesOnWhenMade ?? true,
  };
}

/**
 * What a new key's switches start as, in the owner's words: all on, or the
 * labels of the ones that start on and that everything else is off.
 *
 * @param {ReturnType<typeof agentWords>} words
 * @param {Array<{ id: string, label: string }>} [catalogue]
 */
export function startingSwitches(words, catalogue = []) {
  const made = words.switchesOnWhenMade;
  if (made === true) return 'All are on for a new key.';
  const on = Array.isArray(made) ? made : [];
  if (!on.length) return 'All are off for a new key: turn on only what this key needs.';
  const labels = on.map((id) => catalogue.find((c) => c.id === id)?.label || id);
  return `A new key starts with only ${labels.join(' and ')} on; everything else is off until you turn it on.`;
}

const KODA_WORDS = agentWords();

/** A date-time the way the other admin pages show one, or a dash. */
export function whenText(iso, { locale = 'en-US', timeZone = 'America/Chicago' } = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

/**
 * The key's state, as one word and one sentence.
 *
 * @param {{ present?: boolean, active?: boolean, keyHint?: string|null, createdAt?: string|null,
 *   rotatedAt?: string|null, revokedAt?: string|null, lastUsedAt?: string|null }} key
 */
export function keyState(key = {}, words = KODA_WORDS) {
  if (!key.present) {
    return {
      status: 'none',
      label: 'No key yet',
      tone: 'muted',
      sentence: `${words.name} cannot reach the site until a key is generated here and pasted into ${words.pasteTarget}.`,
    };
  }
  if (!key.active) {
    return {
      status: 'revoked',
      label: 'Revoked',
      tone: 'danger',
      sentence: `The key ${key.keyHint || ''}… was revoked on ${whenText(key.revokedAt)}. Generate a new one to reconnect ${words.name}.`,
    };
  }
  const since = key.rotatedAt
    ? `rotated ${whenText(key.rotatedAt)}`
    : `made ${whenText(key.createdAt)}`;
  const used = key.lastUsedAt ? `last used ${whenText(key.lastUsedAt)}` : 'not used yet';
  return {
    status: 'active',
    label: 'Active',
    tone: 'ok',
    sentence: `Key ${key.keyHint || ''}…, ${since}, ${used}.`,
  };
}

/**
 * One row per capability: the catalogue's text and the key's switch. A
 * switch the answer does not carry reads as the key's default: on for
 * Koda's (`true`), and for another key on only when its list names it.
 *
 * @param {Array<{ id: string, label: string, description: string }>} catalogue
 * @param {Record<string, boolean>} switches
 * @param {boolean|string[]} [defaults]
 */
export function capabilityRows(catalogue = [], switches = {}, defaults = true) {
  const byDefault = (id) => (Array.isArray(defaults) ? defaults.includes(id) : defaults === true);
  return catalogue.map((capability) => {
    const stored = switches[capability.id];
    // Koda's rule, unchanged: anything but a stored false is on.
    if (defaults === true) return { ...capability, on: stored !== false };
    return { ...capability, on: typeof stored === 'boolean' ? stored : byDefault(capability.id) };
  });
}

/** The endpoint list grouped by the capability it needs, for the "What <key> can reach" card. */
export function endpointGroups(endpoints = [], catalogue = []) {
  const labels = Object.fromEntries(catalogue.map((c) => [c.id, c.label]));
  const groups = new Map();
  for (const endpoint of endpoints) {
    const id = endpoint.capability || 'status';
    if (!groups.has(id)) {
      groups.set(id, { id, label: labels[id] || 'Always (no capability needed)', endpoints: [] });
    }
    groups.get(id).endpoints.push(`${endpoint.method} ${endpoint.path}`);
  }
  return [...groups.values()];
}

/**
 * The connector form's values, every one non-secret, so the owner can copy
 * them field by field. `secret` is never part of this.
 *
 * @param {{ host: string, url: string }} address
 * @param {number} requestsPerMinute
 * @param {ReturnType<typeof agentWords>} [words]
 */
export function connectorValues(address, requestsPerMinute, words = KODA_WORDS) {
  return [
    {
      field: 'Provider host',
      value: address.host,
      note: `The host ${words.client} is allowed to call.`,
    },
    {
      field: 'Base URL',
      value: address.url,
      note: 'Every endpoint is this address plus a path from the list below.',
    },
    {
      field: 'Authentication',
      value: 'API key, sent as Authorization: Bearer <the key>',
      note: `One header, one secret. Paste the key into ${words.secureField} only, never into chat.`,
    },
    {
      field: 'First test call',
      value: `GET ${address.url}/status`,
      note: 'Harmless. Answers the capabilities that are on and this limit.',
    },
    {
      field: 'Limit',
      value: `${requestsPerMinute} requests a minute`,
      note: 'Beyond it the API answers 429 with a Retry-After header.',
    },
  ];
}
