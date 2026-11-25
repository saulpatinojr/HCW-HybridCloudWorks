/**
 * config-policy.js — what a config write on `mcp_servers` does beyond the
 * fields it names, and which writes need `super_admin`. Pure. The routes,
 * and the history of each rule, are in ./config-collections.js.
 */
import { requiresToolAllowlist, usesOAuthConnect } from '../ai/mcp.js';

/** The fields whose change makes a server's last test result meaningless. */
export const CONNECTION_FIELDS = Object.freeze(['url', 'transport', 'apiKeyEnvVar', 'authType']);

export const fieldChanged = (fields, existing, key) =>
  Object.prototype.hasOwnProperty.call(fields, key) &&
  String(fields[key] ?? '').trim() !== String(existing?.[key] ?? '').trim();

/**
 * What a config write on `mcp_servers` changes besides the fields it names
 * (2026-10-08). A server whose URL, transport, key or sign-in method changed
 * has not been tested in its new shape, so its status goes back to
 * `untested` and the previous error goes — a red "SSE GET returned HTTP 401"
 * from the old configuration must not sit on the card of the new one. And a
 * server connected through OAuth Connect loses that connection when its URL
 * or sign-in method changes: the token was issued for the old resource
 * (RFC 8707) and is not sent anywhere else.
 */
export function connectionChangeEffects(container, fields, existing) {
  if (container !== 'mcp_servers' || !existing) return {};
  if (!CONNECTION_FIELDS.some((key) => fieldChanged(fields, existing, key))) return {};
  const effects = { status: 'untested', lastError: null };
  const reroutes = fieldChanged(fields, existing, 'url') || fieldChanged(fields, existing, 'authType');
  // A sign-in in progress is cleared too: its token would be for the old resource.
  if (reroutes && (existing.oauth || existing.oauthPending)) {
    Object.assign(effects, { oauthToken: null, oauthRefreshToken: null, oauth: null, oauthPending: null });
  }
  return effects;
}

/**
 * Whether a write on `mcp_servers` moves where a credential is sent (AP-B1):
 * a new server, a URL change, or a key-name change. Flipping `enabled`,
 * renaming, reordering or storing an OAuth token on an existing server is
 * not that. Writes that are need `super_admin`, the same role that seeds the
 * keys themselves (admin-secrets.js), because routing a stored key is the
 * other half of that decision.
 */
function movesCredentialRouting(container, fields, existing) {
  if (container !== 'mcp_servers') return false;
  if (!existing) return true;
  // `authType` since 2026-10-08: it decides whether a server signs in with
  // OAuth Connect, and changing it on a connected server disconnects it
  // (connectionChangeEffects), so an editor could otherwise cut off a
  // super_admin's sign-in.
  return (
    fieldChanged(fields, existing, 'url') ||
    fieldChanged(fields, existing, 'apiKeyEnvVar') ||
    fieldChanged(fields, existing, 'authType')
  );
}

/**
 * Whether a write on `mcp_servers` changes which tools can be called (#995):
 * any body that names `allowedTools`, or one that names `enabled` on a
 * server whose key requires a tool list or that signs in with OAuth Connect
 * (2026-10-08: its tools act on the account a super_admin signed in with,
 * and Hostinger's can change VPS, DNS and domain settings). Those need
 * `super_admin` like a routing move. An editor may still switch Firecrawl,
 * Plaud and the keyless servers on and off, as before.
 */
function changesToolReach(container, fields, existing) {
  if (container !== 'mcp_servers') return false;
  const has = (key) => Object.prototype.hasOwnProperty.call(fields, key);
  if (has('allowedTools')) return true;
  if (!has('enabled')) return false;
  const keyName = has('apiKeyEnvVar') ? fields.apiKeyEnvVar : existing?.apiKeyEnvVar;
  return requiresToolAllowlist(keyName) || usesOAuthConnect({ ...existing, ...fields });
}

/** The writes that need `super_admin` on top of `editor`. */
export const needsSuperAdmin = (container, fields, existing) =>
  movesCredentialRouting(container, fields, existing) ||
  changesToolReach(container, fields, existing);

/** The fields whose omission from a PUT changes the stored server. */
const PUT_JUDGED_FIELDS = Object.freeze([...CONNECTION_FIELDS, 'enabled']);

/**
 * A PUT body as the change it makes to the stored server (review of #1019).
 * PUT is a full replacement, so a field the body leaves out is gone
 * afterwards unless carryForwardTokens keeps it; the checks above read the
 * fields a body names, so each such omission is named here as a change to
 * null. Without it an editor's PUT that left out `enabled` switched an OAuth
 * Connect server off, and one that left out `url`, unseen by the super_admin
 * rule and by connectionChangeEffects.
 */
export function putChangeOf(incoming, doc, existing) {
  if (!existing) return incoming;
  const judged = { ...incoming };
  for (const key of PUT_JUDGED_FIELDS) {
    // A stored false or empty value left out changes nothing.
    const held = existing[key] !== undefined && existing[key] !== null && existing[key] !== false && existing[key] !== '';
    const dropped = doc[key] === undefined && held;
    if (!Object.prototype.hasOwnProperty.call(judged, key) && dropped) judged[key] = null;
  }
  return judged;
}

/**
 * The OAuth Connect credentials on a config write: refused (review of
 * #1019). They are written by Connect and refreshed by the timer, for the
 * account a super_admin signed in with; a config write that set them would
 * leave the card reading Connected while every call acted on whatever
 * account the editor's token belonged to. Plaud's pasted token keeps its
 * path: it is not an OAuth Connect server (usesOAuthConnect).
 */
export function connectTokenWriteError(fields, existing) {
  const named = ['oauthToken', 'oauthRefreshToken'].filter((key) =>
    Object.prototype.hasOwnProperty.call(fields, key)
  );
  if (named.length === 0) return null;
  if (!usesOAuthConnect(existing ?? {}) && !usesOAuthConnect({ ...existing, ...fields })) return null;
  return `${named.join(' and ')} on a server that signs in with Connect is set by Connect, not by a configuration write. Use Connect or Disconnect on its card.`;
}
