/**
 * config-collections.js — the client-id configuration collections of the
 * admin integrations surface (lib/aiEngine.js): ai_providers and
 * mcp_servers.
 *
 *   - Both use CLIENT-CHOSEN ids (`setDoc(doc(db, col, p.id))` with seed ids
 *     like 'vertex', 'replicate-mcp'), so PUT upserts at the route id —
 *     unlike the addDoc-style collections where the server mints the id.
 *   - mcp_servers documents can carry an OAuth token (setMcpOAuthToken). The
 *     aiEngine comment says the browser never reads it back and relied on
 *     rules to someday block it; here list/get responses actually strip
 *     `oauthToken` — writes accept it, reads never return it.
 *   - Every mcp_servers write passes the URL and key-name checks of
 *     ai/mcp-policy.js (ADR 0033, security finding), and since the 2026-10-06
 *     review (AP-B1) the key-to-host binding: a shared integration key may
 *     only be named on a server at its vendor's host, a write that moves
 *     where a credential is sent needs `super_admin`, and every write here
 *     leaves an `admin_audit_logs` row.
 *   - Since #995 (2026-10-07) a server may carry `allowedTools`, the only
 *     tools `mcpProxy` will call on it. A server whose key requires a list
 *     (PUBLER_API_KEY) cannot be saved without one, any write that names
 *     `allowedTools` needs `super_admin`, and so does switching such a
 *     server on or off: enabling it is what puts its tools in reach.
 *   - Since 2026-10-08 the OAuth Connect flow (ai/mcp-oauth.js) keeps four
 *     more fields on a server — `oauth` and `oauthClient` (readable),
 *     `oauthClientSecret` and `oauthPending` (write-only). No config write
 *     can set any of them; only the cms/mcp/.../oauth routes do. A write
 *     that changes a server's URL, transport, key or sign-in method resets
 *     its status to untested and clears its last error, and one that moves
 *     the URL or sign-in method of an OAuth-connected server disconnects it.
 *     Changing `authType`, and switching an OAuth Connect server on or off,
 *     need super_admin. No body on either collection may name a nested
 *     path (`a.b`): Cosmos patches those inside a field these checks read
 *     whole (nestedFieldError).
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * aiConfigChanged); the factory at the bottom only wires them.
 */
import {
  requiresToolAllowlist,
  usesOAuthConnect,
  validateMcpKeyBinding,
  validateMcpToolPolicy,
  validateMcpUrl,
} from '../ai/mcp.js';
import { json, LIST_WINDOW, validBody } from '../http/admin-handler.js';
import { authoredMessage } from '../http/error-response.js';
import { AUDIT_TTL_SECONDS } from '../audit.js';

/** Route-segment → container allowlist for the client-id config collections. */
const CONFIG_COLLECTIONS = {
  'ai-providers': 'ai_providers',
  'mcp-servers': 'mcp_servers',
};

/** Allowlists for config collections (AP-B6). */
export const AI_PROVIDER_FIELDS = Object.freeze([
  'id',
  'name',
  'enabled',
  'order',
  'apiKeyEnvVar',
  'model',
  'defaultModel',
  'baseUrl',
  'apiVersion',
  'temperature',
  'maxTokens',
  'timeoutMs',
  'models',
  'description',
  'notes',
  'status',
  'lastError',
  'lastTestedAt',
  'createdAt',
  'updatedAt',
]);

export const MCP_SERVER_FIELDS = Object.freeze([
  'id',
  'name',
  'url',
  'transport',
  'apiKeyEnvVar',
  'enabled',
  'order',
  'authType',
  'allowedTools',
  'oauthToken',
  'oauthRefreshToken',
  'description',
  'notes',
  'headers',
  'status',
  'lastError',
  'lastTestedAt',
  'tools',
  'createdAt',
  'updatedAt',
]);

// The token values are write-only, but consumers need to know whether one is
// stored (RecordingsPage renders 'connected' from status + token presence,
// and since 2026-09-05 shows whether the 12-hour refresh timer has a refresh
// token to work with) — so reads carry a boolean in place of each. The OAuth
// Connect flow's client secret and pending sign-in (PKCE verifier, state
// hash) are write-only too (2026-10-08, ai/mcp-oauth.js), with no boolean:
// nothing on the page needs to know they exist.
const stripOAuthToken = ({
  oauthToken,
  oauthRefreshToken,
  oauthClientSecret: _clientSecret,
  oauthPending: _pending,
  ...rest
}) => ({
  ...rest,
  hasOauthToken: Boolean(oauthToken),
  hasOauthRefreshToken: Boolean(oauthRefreshToken),
});

/**
 * Fields only the OAuth Connect flow writes (ai/mcp-oauth-handlers.js), never
 * a config write. `oauth.tokenEndpoint` is where the refresh token is POSTed
 * and `oauthPending` is what a callback is checked against, so a browser that
 * could set either could have a stored refresh token sent to a host it
 * chose. They are dropped from every PUT and PATCH body, silently, because a
 * form round-tripping a read carries the readable two back; a PUT keeps the
 * stored values (carryForwardTokens).
 */
const SERVER_MANAGED_OAUTH_FIELDS = Object.freeze([
  'oauth',
  'oauthClient',
  'oauthClientSecret',
  'oauthPending',
]);

function withoutServerManagedFields(container, fields) {
  if (container !== 'mcp_servers') return fields;
  const kept = { ...fields };
  for (const key of SERVER_MANAGED_OAUTH_FIELDS) delete kept[key];
  return kept;
}

/**
 * The sentence refusing a body that names a nested path, or null
 * (2026-10-08, security review of the OAuth Connect change). A PATCH reaches
 * Cosmos as field-path operations, and `a.b` is a NESTED write
 * (cosmos-client.js toJsonPointer): `oauth.tokenEndpoint` would slip past the
 * whole-field guard above and point the refresh — refresh token and client
 * secret — at a host an editor chose, and `allowedTools.0` would slip past
 * #995's super_admin rule. Every check on these routes reads top-level
 * fields whole, and no caller writes a nested one, so no dotted name is
 * accepted on either collection.
 */
function nestedFieldError(fields) {
  const nested = Object.keys(fields).find((key) => key.includes('.'));
  return nested
    ? `Field "${nested.slice(0, 80)}" names a nested path; send the whole top-level field instead.`
    : null;
}

/** The fields whose change makes a server's last test result meaningless. */
const CONNECTION_FIELDS = Object.freeze(['url', 'transport', 'apiKeyEnvVar', 'authType']);

const fieldChanged = (fields, existing, key) =>
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
function connectionChangeEffects(container, fields, existing) {
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

/** What a read of this container returns: tokens stripped for mcp_servers. */
const readableDoc = (container, doc) => (container === 'mcp_servers' ? stripOAuthToken(doc) : doc);

/**
 * The checks every mcp_servers write passes (ADR 0033, security finding):
 * the URL is https and the key name is on the allowlist.
 * Only the fields present are checked, so a PATCH that flips `enabled` on a
 * server saved before the allowlist still goes through; the next Sync or
 * call refuses the bad field with the same sentence.
 */
function mcpWriteError(fields, existing = null) {
  const touchesUrl = Object.prototype.hasOwnProperty.call(fields, 'url');
  const touchesKey = Object.prototype.hasOwnProperty.call(fields, 'apiKeyEnvVar');
  const touchesTools = Object.prototype.hasOwnProperty.call(fields, 'allowedTools');
  try {
    if (touchesUrl) validateMcpUrl(fields.url);
    // The key-to-host binding (AP-B1) is a property of the pair, so a PATCH
    // that moves one half is checked against the stored other half: a URL
    // change on a server holding a shared key, or a shared key placed on a
    // server at the wrong host, is refused either way.
    if (touchesUrl || touchesKey) {
      validateMcpKeyBinding({
        url: touchesUrl ? fields.url : existing?.url,
        apiKeyEnvVar: touchesKey ? fields.apiKeyEnvVar : existing?.apiKeyEnvVar,
      });
    }
    // The tool list is a property of the pair too (#995): a key that needs
    // a list placed on a server without one, or the list removed from a
    // server whose key needs it, is refused either way. A PUT that omits
    // the list keeps the stored one (carryForwardTokens), so the stored
    // half is the right one to check against.
    if (touchesKey || touchesTools) {
      validateMcpToolPolicy({
        apiKeyEnvVar: touchesKey ? fields.apiKeyEnvVar : existing?.apiKeyEnvVar,
        allowedTools: touchesTools ? fields.allowedTools : existing?.allowedTools,
      });
    }
  } catch (error) {
    // McpPolicyError sentences are authored; anything else is not shown (#945).
    return authoredMessage(error, 'The MCP server settings were refused.');
  }
  return null;
}

/** The write checks for this container: the error sentence, or null. */
const writeError = (container, fields, existing = null) =>
  container === 'mcp_servers'
    ? mcpWriteError(fields, existing) ?? connectTokenWriteError(fields, existing)
    : null;

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
const needsSuperAdmin = (container, fields, existing) =>
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
function putChangeOf(incoming, doc, existing) {
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
function connectTokenWriteError(fields, existing) {
  const named = ['oauthToken', 'oauthRefreshToken'].filter((key) =>
    Object.prototype.hasOwnProperty.call(fields, key)
  );
  if (named.length === 0) return null;
  if (!usesOAuthConnect(existing ?? {}) && !usesOAuthConnect({ ...existing, ...fields })) return null;
  return `${named.join(' and ')} on a server that signs in with Connect is set by Connect, not by a configuration write. Use Connect or Disconnect on its card.`;
}

/** The `admin_audit_logs.action` every ai_providers / mcp_servers write records. */
export const CONFIG_AUDIT_ACTION = 'ai_config_updated';

/** The audit row for a config write: field names, and the routing values
 * (a URL and a setting NAME, neither a secret) before and after. Best
 * effort, like every audit writer here: the save has landed. */
async function auditConfigWrite(ctx, context, { container, id, user, existing, fields, action }) {
  try {
    const routing = (doc) => ({
      url: doc?.url ?? null,
      apiKeyEnvVar: doc?.apiKeyEnvVar ?? null,
      allowedTools: doc?.allowedTools ?? null,
    });
    await ctx.store.upsertDoc('admin_audit_logs', {
      id: ctx.uuid(),
      action: CONFIG_AUDIT_ACTION,
      userId: user?.oid || user?.sub || null,
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: ctx.now().toISOString(),
      ttl: AUDIT_TTL_SECONDS,
      details: {
        collection: container,
        documentId: id,
        operation: action,
        fields: Object.keys(fields || {}).filter(
          (k) => !['oauthToken', 'oauthRefreshToken'].includes(k)
        ),
        before: existing ? routing(existing) : null,
        after: action === 'delete' ? null : routing({ ...existing, ...fields }),
      },
      compliance: { schemaVersion: 2, appendOnly: true },
    });
  } catch (auditError) {
    context.warn?.(
      `${action} ${container}/${id} saved but the audit row failed: ${auditError?.message || auditError}`
    );
  }
}

/**
 * putConfig is a full replace, and reads never return `oauthToken`
 * (deliberately — it is write-only). So a read-modify-write round trip
 * from any edit form would silently delete a stored token. Carry it
 * forward unless the caller explicitly supplied a new one; an explicit
 * empty string still clears it, which is how a token is revoked (T-314).
 * Same rule for the refresh token the 12-hour timer rotates with.
 */
function carryForwardTokens(doc, incoming, existing) {
  // `allowedTools` rides along for a different reason (#995): a PUT that
  // omits it must not widen a server back to every tool, so an omitted list
  // keeps the stored one. Only a write that names it, at super_admin,
  // changes it. The OAuth Connect fields (2026-10-08) are never in a PUT
  // body at all (SERVER_MANAGED_OAUTH_FIELDS), so they always carry.
  // `authType` for the same reason as the list (review of #1019): a PUT that
  // left it out turned an OAuth Connect server into a plain one, past the
  // super_admin rule that reads only the fields a body names, with its
  // tokens carried forward. Changing the sign-in method is a write that
  // names it.
  for (const key of ['oauthToken', 'oauthRefreshToken', 'allowedTools', 'authType', ...SERVER_MANAGED_OAUTH_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key) && existing?.[key] !== undefined) {
      doc[key] = existing[key];
    }
  }
}

/**
 * A PUT body as the document it stores, less the read artefacts:
 * `{ incoming }` or `{ error }` (a sentence).
 *
 * `hasOauthToken` is a READ artefact — stripOAuthToken synthesises it so
 * consumers can render connection state without seeing the token. An edit
 * form round-tripping a read back into this handler would otherwise persist
 * the boolean into the stored document, where it would then shadow the real
 * value on the next read.
 */
function validateConfigFieldTypes(container, fields) {
  if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if (fields.order !== undefined && fields.order !== null) {
    const o = Number(fields.order);
    if (!Number.isInteger(o) || o < 0) return 'order must be a non-negative integer';
  }
  if (fields.name !== undefined && fields.name !== null && typeof fields.name !== 'string') {
    return 'name must be a string';
  }
  if (fields.apiKeyEnvVar !== undefined && fields.apiKeyEnvVar !== null && typeof fields.apiKeyEnvVar !== 'string') {
    return 'apiKeyEnvVar must be a string or null';
  }
  if (container === 'mcp_servers') {
    if (fields.allowedTools !== undefined && fields.allowedTools !== null) {
      if (!Array.isArray(fields.allowedTools) || fields.allowedTools.some((t) => typeof t !== 'string')) {
        return 'allowedTools must be an array of strings';
      }
    }
    if (fields.transport !== undefined && fields.transport !== null && typeof fields.transport !== 'string') {
      return 'transport must be a string';
    }
  }
  if (container === 'ai_providers') {
    if (fields.temperature !== undefined && fields.temperature !== null) {
      const t = Number(fields.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2) return 'temperature must be a number between 0 and 2';
    }
    if (fields.maxTokens !== undefined && fields.maxTokens !== null) {
      const m = Number(fields.maxTokens);
      if (!Number.isInteger(m) || m < 1) return 'maxTokens must be a positive integer';
    }
    if (fields.models !== undefined && fields.models !== null) {
      if (!Array.isArray(fields.models) || fields.models.some((m) => typeof m !== 'string')) {
        return 'models must be an array of strings';
      }
    }
  }
  return null;
}

function putDocumentOf(container, body, existing = null) {
  const { hasOauthToken: _ignored, hasOauthRefreshToken: _ignored2, ...fields } = body;
  const nested = nestedFieldError(fields);
  if (nested) return { error: nested };
  const incoming = withoutServerManagedFields(container, fields);

  const allowlist = container === 'ai_providers' ? AI_PROVIDER_FIELDS : MCP_SERVER_FIELDS;
  const unknown = Object.keys(incoming).filter((key) => !allowlist.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s) for ${container}: ${unknown.join(', ')}` };
  }
  const typeErr = validateConfigFieldTypes(container, incoming);
  if (typeErr) return { error: typeErr };

  const problem = writeError(container, incoming, existing);
  return problem ? { error: problem } : { incoming };
}

/** Route id, stored document and checked body of a PUT: `{ id, existing, incoming }` or `{ error }` holding the response. */
async function prepareConfigPut(store, container, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body) return { error: json(400, { error: 'Body must be a JSON object' }) };
  const existing = await store.readDoc(container, id, id);
  const checked = putDocumentOf(container, body, existing);
  return checked.error
    ? { error: json(400, { error: checked.error }) }
    : { id, existing, incoming: checked.incoming };
}

/**
 * The fields a PATCH body changes, less the id and the read artefacts:
 * `{ updates }` or `{ error }` (a sentence).
 *
 * `hasOauthToken` is dropped for the same reason putConfig drops it: it is
 * synthesised by stripOAuthToken on every read, so a form that PATCHes a
 * field it read back would persist a boolean snapshot of the token's
 * presence next to the token. Reads recompute it, so it never shadows the
 * real value — it is simply a stale copy of a secret's state, written into
 * the document, that a later revoke would not clear.
 */
function patchUpdatesOf(container, body, existing = null) {
  const {
    id: _ignored,
    hasOauthToken: _readArtefact,
    hasOauthRefreshToken: _readArtefact2,
    ...fields
  } = body;
  const nested = nestedFieldError(fields);
  if (nested) return { error: nested };
  const updates = withoutServerManagedFields(container, fields);
  if (Object.keys(updates).length === 0) {
    return { error: 'Body must contain at least one updatable field' };
  }

  const allowlist = container === 'ai_providers' ? AI_PROVIDER_FIELDS : MCP_SERVER_FIELDS;
  const unknown = Object.keys(updates).filter((key) => !allowlist.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s) for ${container}: ${unknown.join(', ')}` };
  }
  const typeErr = validateConfigFieldTypes(container, updates);
  if (typeErr) return { error: typeErr };

  const problem = writeError(container, updates, existing);
  return problem ? { error: problem } : { updates };
}

/** Route id, stored document and checked body of a PATCH: `{ id, updates }` or `{ error }` holding the response. */
async function prepareConfigPatch(store, container, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body || Object.keys(body).length === 0) {
    return { error: json(400, { error: 'Body must be a non-empty JSON object' }) };
  }
  const existing = await store.readDoc(container, id, id);
  if (!existing) return { error: json(404, { error: `${container} ${id} not found` }) };
  const checked = patchUpdatesOf(container, body, existing);
  return checked.error
    ? { error: json(400, { error: checked.error }) }
    : { id, existing, updates: checked.updates };
}

/** GET /api/cms/{ai-providers|mcp-servers} — order asc; tokens stripped. */
async function listConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const container = CONFIG_COLLECTIONS[request.params.collection];
  if (!container) return json(404, { error: 'Unknown collection' });
  try {
    const rows = await ctx.store.queryDocs(container, `SELECT TOP ${LIST_WINDOW} * FROM c`, []);
    const items = rows
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .map((doc) => readableDoc(container, doc));
    return json(200, { success: true, items, total: items.length });
  } catch (error) {
    context.error(`listConfig(${container}) failed:`, error);
    return json(500, { error: 'Failed to list configuration' });
  }
}

/** PUT /api/cms/{collection}/{id} — setDoc semantics at a client id. */
async function putConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const container = CONFIG_COLLECTIONS[request.params.collection];
  if (!container) return json(404, { error: 'Unknown collection' });
  try {
    const prepared = await prepareConfigPut(ctx.store, container, request);
    if (prepared.error) return prepared.error;
    const { id, existing, incoming } = prepared;

    const nowIso = ctx.now().toISOString();
    const doc = {
      ...incoming,
      id,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    // Judged on the document the PUT stores, omissions included (putChangeOf).
    let change = incoming;
    if (container === 'mcp_servers') {
      carryForwardTokens(doc, incoming, existing);
      change = putChangeOf(incoming, doc, existing);
    }

    if (needsSuperAdmin(container, change, existing)) {
      const elevated = await ctx.guard.requireRole(request, 'super_admin');
      if (elevated.error) return elevated.error;
    }
    if (container === 'mcp_servers') Object.assign(doc, connectionChangeEffects(container, change, existing));
    await ctx.store.upsertDoc(container, doc);
    if (container === 'ai_providers') ctx.aiConfigChanged();
    await auditConfigWrite(ctx, context, {
      container,
      id,
      user: auth.user,
      existing,
      fields: incoming,
      action: 'put',
    });
    return json(200, { success: true, id, item: readableDoc(container, doc) });
  } catch (error) {
    context.error(`putConfig(${container}) failed:`, error);
    return json(500, { error: 'Failed to save configuration' });
  }
}

/** PATCH /api/cms/{collection}/{id} — setEnabled / model / token / url patches. */
async function patchConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const container = CONFIG_COLLECTIONS[request.params.collection];
  if (!container) return json(404, { error: 'Unknown collection' });
  try {
    const prepared = await prepareConfigPatch(ctx.store, container, request);
    if (prepared.error) return prepared.error;
    if (needsSuperAdmin(container, prepared.updates, prepared.existing)) {
      const elevated = await ctx.guard.requireRole(request, 'super_admin');
      if (elevated.error) return elevated.error;
    }
    const updated = await ctx.store.patchDoc(container, prepared.id, {
      ...prepared.updates,
      ...connectionChangeEffects(container, prepared.updates, prepared.existing),
      updatedAt: ctx.now().toISOString(),
    });
    if (container === 'ai_providers') ctx.aiConfigChanged();
    await auditConfigWrite(ctx, context, {
      container,
      id: prepared.id,
      user: auth.user,
      existing: prepared.existing,
      fields: prepared.updates,
      action: 'patch',
    });
    return json(200, { success: true, item: readableDoc(container, updated) });
  } catch (error) {
    context.error(`patchConfig(${container}) failed:`, error);
    return json(500, { error: 'Failed to update configuration' });
  }
}

/** DELETE /api/cms/{collection}/{id} */
async function deleteConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const container = CONFIG_COLLECTIONS[request.params.collection];
  if (!container) return json(404, { error: 'Unknown collection' });
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    // Read before the decision, and a failed read fails the delete: deleting
    // an OAuth Connect server removes its tokens, which is Disconnect by
    // another name, and Disconnect is super_admin (review of #1019).
    const existing = await ctx.store.readDoc(container, id, id);
    if (container === 'mcp_servers' && usesOAuthConnect(existing ?? {})) {
      const elevated = await ctx.guard.requireRole(request, 'super_admin');
      if (elevated.error) return elevated.error;
    }
    await ctx.store.deleteDoc(container, id);
    if (container === 'ai_providers') ctx.aiConfigChanged();
    await auditConfigWrite(ctx, context, {
      container,
      id,
      user: auth.user,
      existing,
      fields: {},
      action: 'delete',
    });
    return json(200, { success: true });
  } catch (error) {
    context.error(`deleteConfig(${container}) failed:`, error);
    return json(500, { error: 'Failed to delete configuration' });
  }
}

/** @param {{ guard: object, store: object, now: () => Date, aiConfigChanged: () => void }} ctx */
export function createConfigCollectionHandlers(ctx) {
  return {
    listConfig: (request, context) => listConfig(ctx, request, context),
    putConfig: (request, context) => putConfig(ctx, request, context),
    patchConfig: (request, context) => patchConfig(ctx, request, context),
    deleteConfig: (request, context) => deleteConfig(ctx, request, context),
  };
}
