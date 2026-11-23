/**
 * The Developer API tab's calls (ADR 0042): the admin routes for organizer
 * keys, under cms/developer-api/keys.
 *
 *   listDeveloperKeys()               GET     every key (never a key), the scopes,
 *                                             limits and endpoints                  editor
 *   createDeveloperKey(organizer)     POST    make a key; the answer carries
 *                                             `secret` ONCE                         super_admin
 *   rotateDeveloperKey(keyId)         POST    a new secret for the same organizer;
 *                                             the old one stops at once; ONCE       super_admin
 *   updateDeveloperKey(keyId, change) PATCH   scopes, organizer name or contact     super_admin
 *   revokeDeveloperKey(keyId)         DELETE  the next request with the key is
 *                                             refused                               super_admin
 *
 * The secret in a create or rotate answer goes to the screen once, for the
 * owner to hand to the organizer through a secure channel, and nowhere else:
 * not to storage, not to the console, not to a toast, not to the address.
 */
import { getJSON, postJSON, sendJSON } from '@/lib/api';

export const DEVELOPER_KEYS_ROUTE = 'cms/developer-api/keys';

/** The route of one key. The id is encoded, so a bad id cannot reach another path. */
export function developerKeyRoute(keyId) {
  return `${DEVELOPER_KEYS_ROUTE}/${encodeURIComponent(String(keyId ?? ''))}`;
}

export function listDeveloperKeys() {
  return getJSON(DEVELOPER_KEYS_ROUTE);
}

/** @param {{ organizerName: string, organizerContact?: string|null, scopes: string[] }} organizer */
export function createDeveloperKey({ organizerName, organizerContact, scopes }) {
  const body = { organizerName, scopes };
  if (organizerContact) body.organizerContact = organizerContact;
  return postJSON(DEVELOPER_KEYS_ROUTE, body);
}

export function rotateDeveloperKey(keyId) {
  return postJSON(`${developerKeyRoute(keyId)}/rotate`, {});
}

/** @param {{ scopes?: string[], organizerName?: string, organizerContact?: string|null }} change */
export function updateDeveloperKey(keyId, change) {
  return sendJSON(developerKeyRoute(keyId), 'PATCH', change);
}

export function revokeDeveloperKey(keyId) {
  return sendJSON(developerKeyRoute(keyId), 'DELETE');
}
