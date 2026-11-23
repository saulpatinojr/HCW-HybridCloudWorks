/**
 * The Developer API tab's pure half (ADR 0042): what the API's answer about
 * organizer keys becomes on the screen. No I/O, no React, so every sentence
 * the owner reads is testable without a render. Follows kodaView.js.
 */
import { whenText } from './kodaView';

export { whenText };

/** The API's own limits on the two text fields (functions/src/lib/developer-api/keys.js). */
export const MAX_ORGANIZER_NAME = 120;
export const MAX_ORGANIZER_CONTACT = 254;

/**
 * One key's state, as one word and one sentence.
 *
 * @param {{ active?: boolean, keyHint?: string|null, createdAt?: string|null,
 *   rotatedAt?: string|null, revokedAt?: string|null, lastUsedAt?: string|null }} key
 */
export function keyState(key = {}) {
  const hint = key.keyHint ? `${key.keyHint}…` : 'This key';
  if (!key.active) {
    return {
      status: 'revoked',
      label: 'Revoked',
      tone: 'danger',
      sentence: `${hint} was revoked on ${whenText(key.revokedAt)} and is refused. Make a new key for this organizer to reconnect them.`,
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
    sentence: `${hint}, ${since}, ${used}.`,
  };
}

/** Active keys first, each group in the order the API sent (newest first). */
export function orderKeys(keys = []) {
  const list = Array.isArray(keys) ? keys : [];
  return [...list.filter((k) => k.active), ...list.filter((k) => !k.active)];
}

/**
 * One row per scope: the catalogue's text and whether this key has it.
 *
 * @param {Array<{ id: string, label: string, description: string }>} catalogue
 * @param {string[]} chosen
 */
export function scopeRows(catalogue = [], chosen = []) {
  const set = new Set(Array.isArray(chosen) ? chosen : []);
  return catalogue.map((scope) => ({ ...scope, on: set.has(scope.id) }));
}

/** The scopes a key has, by their labels, for the list. */
export function scopeText(chosen = [], catalogue = []) {
  const labels = Object.fromEntries(catalogue.map((s) => [s.id, s.label]));
  const names = (Array.isArray(chosen) ? chosen : []).map((id) => labels[id] || id);
  return names.length ? names.join(', ') : 'No scopes';
}

/**
 * The scope list after one switch, in the catalogue's order, the order the
 * API keeps them in.
 */
export function withScope(chosen = [], id, on, catalogue = []) {
  const set = new Set(Array.isArray(chosen) ? chosen : []);
  if (on) set.add(id);
  else set.delete(id);
  const order = catalogue.map((s) => s.id);
  return [...order.filter((x) => set.has(x)), ...[...set].filter((x) => !order.includes(x))];
}

/** Who may call an endpoint, in words. `who` is `public`, `key` or a scope id. */
export function whoText(who, catalogue = []) {
  if (who === 'public') return 'Anyone, no key needed';
  if (who === 'key') return 'Any organizer key';
  const scope = catalogue.find((s) => s.id === who);
  return `A key with “${scope ? scope.label : who}”`;
}

/** The endpoint list as lines and who may call each, for the "What a key can reach" card. */
export function endpointRows(endpoints = [], catalogue = []) {
  return (Array.isArray(endpoints) ? endpoints : []).map((e) => ({
    line: `${e.method} ${e.path}`,
    who: whoText(e.who, catalogue),
  }));
}

/**
 * The values an organizer needs to connect, every one non-secret, so the
 * owner can send them with the key. The key itself is never part of this.
 *
 * @param {{ host: string, url: string }} address
 * @param {{ keyedRequestsPerMinute?: number }} limits
 */
export function connectionValues(address, limits = {}) {
  const perMinute = limits?.keyedRequestsPerMinute ?? 120;
  return [
    {
      field: 'Base URL',
      value: address.url,
      note: 'Every endpoint is this address plus a path from the list below.',
    },
    {
      field: 'Authentication',
      value: 'Authorization: Bearer <the key>',
      note: 'An X-API-Key header also works. Never in the address: addresses end up in logs.',
    },
    {
      field: 'First test call',
      value: `GET ${address.url}/status`,
      note: 'Harmless. Answers which scopes the key has.',
    },
    {
      field: 'Limit',
      value: `${perMinute} requests a minute per key`,
      note: 'Beyond it the API answers 429 with a Retry-After header.',
    },
  ];
}

/**
 * What is wrong with the New key form, in one sentence, or null when it can
 * be sent. The API checks the same things; this only saves the round trip.
 *
 * @param {{ organizerName?: string, organizerContact?: string, scopes?: string[] }} form
 */
export function newKeyProblem(form = {}) {
  const name = String(form.organizerName || '').trim();
  if (!name) return 'Give the organizer’s name.';
  if (name.length > MAX_ORGANIZER_NAME) {
    return `The organizer’s name must be at most ${MAX_ORGANIZER_NAME} characters.`;
  }
  if (String(form.organizerContact || '').trim().length > MAX_ORGANIZER_CONTACT) {
    return `The contact must be at most ${MAX_ORGANIZER_CONTACT} characters.`;
  }
  if (!Array.isArray(form.scopes) || form.scopes.length === 0) {
    return 'Choose at least one thing the key may do.';
  }
  return null;
}
