/**
 * The Koda tab's pure half (ADR 0037): what the API's answer becomes on the
 * screen. No I/O, no React, so every sentence the owner reads is testable
 * without a render.
 */

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
export function keyState(key = {}) {
  if (!key.present) {
    return {
      status: 'none',
      label: 'No key yet',
      tone: 'muted',
      sentence: 'Koda cannot reach the site until a key is generated here and pasted into Muse.',
    };
  }
  if (!key.active) {
    return {
      status: 'revoked',
      label: 'Revoked',
      tone: 'danger',
      sentence: `The key ${key.keyHint || ''}… was revoked on ${whenText(key.revokedAt)}. Generate a new one to reconnect Koda.`,
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
 * One row per capability: the catalogue's text and the key's switch.
 *
 * @param {Array<{ id: string, label: string, description: string }>} catalogue
 * @param {Record<string, boolean>} switches
 */
export function capabilityRows(catalogue = [], switches = {}) {
  return catalogue.map((capability) => ({
    ...capability,
    on: switches[capability.id] !== false,
  }));
}

/** The endpoint list grouped by the capability it needs, for the "What Koda can reach" card. */
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
 */
export function connectorValues(address, requestsPerMinute) {
  return [
    { field: 'Provider host', value: address.host, note: 'The host Muse is allowed to call.' },
    {
      field: 'Base URL',
      value: address.url,
      note: 'Every endpoint is this address plus a path from the list below.',
    },
    {
      field: 'Authentication',
      value: 'API key, sent as Authorization: Bearer <the key>',
      note: 'One header, one secret. Paste the key into Muse’s secure field only, never into chat.',
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
