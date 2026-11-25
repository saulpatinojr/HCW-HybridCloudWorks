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
 * The document's fields and types are in ./config-fields.js, and what a
 * write changes besides its fields, and who may make it, in
 * ./config-policy.js.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * aiConfigChanged); the factory at the bottom only wires them.
 */
import {
  usesOAuthConnect,
  validateMcpKeyBinding,
  validateMcpToolPolicy,
  validateMcpUrl,
} from '../ai/mcp.js';
import { json, LIST_WINDOW, validBody } from '../http/admin-handler.js';
import { authoredMessage, errorFacts } from '../http/error-response.js';
import { AUDIT_TTL_SECONDS } from '../audit.js';
import {
  AI_PROVIDER_FIELDS,
  carryForwardTokens,
  MCP_SERVER_FIELDS,
  nestedFieldError,
  readableDoc,
  validateConfigFieldTypes,
  withoutServerManagedFields,
} from './config-fields.js';
import {
  connectionChangeEffects,
  connectTokenWriteError,
  needsSuperAdmin,
  putChangeOf,
} from './config-policy.js';

export { AI_PROVIDER_FIELDS, MCP_SERVER_FIELDS } from './config-fields.js';

/** Route-segment → container allowlist for the client-id config collections. */
const CONFIG_COLLECTIONS = {
  'ai-providers': 'ai_providers',
  'mcp-servers': 'mcp_servers',
};

/**
 * The checks every mcp_servers write passes (ADR 0033, security finding):
 * the URL is https and the key name is on the allowlist.
 * Only the fields present are checked, so a PATCH that flips `enabled` on a
 * server saved before the allowlist still goes through; the next Sync or
 * call refuses the bad field with the same sentence.
 */
function mcpWriteError(fields, existing = null) {
  const touches = (key) => Object.prototype.hasOwnProperty.call(fields, key);
  // What the server holds after the write: the body's value when it names
  // the field, the stored one when it does not.
  const after = (key) => (touches(key) ? fields[key] : existing?.[key]);
  try {
    if (touches('url')) validateMcpUrl(fields.url);
    // The key-to-host binding (AP-B1) is a property of the pair, so a PATCH
    // that moves one half is checked against the stored other half: a URL
    // change on a server holding a shared key, or a shared key placed on a
    // server at the wrong host, is refused either way.
    if (touches('url') || touches('apiKeyEnvVar')) {
      validateMcpKeyBinding({ url: after('url'), apiKeyEnvVar: after('apiKeyEnvVar') });
    }
    // The tool list is a property of the pair too (#995): a key that needs
    // a list placed on a server without one, or the list removed from a
    // server whose key needs it, is refused either way. A PUT that omits
    // the list keeps the stored one (carryForwardTokens), so the stored
    // half is the right one to check against.
    if (touches('apiKeyEnvVar') || touches('allowedTools')) {
      validateMcpToolPolicy({
        apiKeyEnvVar: after('apiKeyEnvVar'),
        allowedTools: after('allowedTools'),
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
      `${action} on ${container} saved but the audit row failed: ${errorFacts(auditError)}`
    );
  }
}

/**
 * The checks a PUT and a PATCH share, once the read artefacts and the
 * server-managed fields are gone: known field names, their types, and the
 * write checks. The error sentence, or null.
 */
function fieldsError(container, fields, existing) {
  const allowlist = container === 'ai_providers' ? AI_PROVIDER_FIELDS : MCP_SERVER_FIELDS;
  const unknown = Object.keys(fields).filter((key) => !allowlist.includes(key));
  if (unknown.length > 0) {
    return `Unknown field(s) for ${container}: ${unknown.join(', ')}`;
  }
  return validateConfigFieldTypes(container, fields) ?? writeError(container, fields, existing);
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
function putDocumentOf(container, body, existing = null) {
  const { hasOauthToken: _ignored, hasOauthRefreshToken: _ignored2, ...fields } = body;
  const nested = nestedFieldError(fields);
  if (nested) return { error: nested };
  const incoming = withoutServerManagedFields(container, fields);
  const problem = fieldsError(container, incoming, existing);
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
  const problem = fieldsError(container, updates, existing);
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

/**
 * The editor check every route makes, and the container its route segment
 * names: `{ auth, container }`, or `{ error }` holding the response.
 */
async function openConfigRoute(ctx, request) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return { error: auth.error };
  const container = CONFIG_COLLECTIONS[request.params.collection];
  if (!container) return { error: json(404, { error: 'Unknown collection' }) };
  return { auth, container };
}

/** When a write needs `super_admin` on top of `editor`: the refusal response, or null. */
async function superAdminRefusal(guard, request, needed) {
  if (!needed) return null;
  const elevated = await guard.requireRole(request, 'super_admin');
  return elevated.error || null;
}

/** After a write lands: drop the router's cache for an ai_providers change, then write the audit row. */
async function afterConfigWrite(ctx, context, entry) {
  if (entry.container === 'ai_providers') ctx.aiConfigChanged();
  await auditConfigWrite(ctx, context, entry);
}

/**
 * The document a PUT stores, and the change it makes. The change is judged
 * on the document the PUT stores, omissions included (putChangeOf).
 */
function putDocumentAndChange(nowIso, container, { id, existing, incoming }) {
  const doc = {
    ...incoming,
    id,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  if (container !== 'mcp_servers') return { doc, change: incoming };
  carryForwardTokens(doc, incoming, existing);
  return { doc, change: putChangeOf(incoming, doc, existing) };
}

/** GET /api/cms/{ai-providers|mcp-servers} — order asc; tokens stripped. */
async function listConfig(ctx, request, context) {
  const route = await openConfigRoute(ctx, request);
  if (route.error) return route.error;
  const { container } = route;
  try {
    const rows = await ctx.store.queryDocs(container, `SELECT TOP ${LIST_WINDOW} * FROM c`, []);
    const items = rows
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .map((doc) => readableDoc(container, doc));
    return json(200, { success: true, items, total: items.length });
  } catch (error) {
    context.error(`listConfig(${container}) failed:`, errorFacts(error));
    return json(500, { error: 'Failed to list configuration' });
  }
}

/** PUT /api/cms/{collection}/{id} — setDoc semantics at a client id. */
async function putConfig(ctx, request, context) {
  const route = await openConfigRoute(ctx, request);
  if (route.error) return route.error;
  const { auth, container } = route;
  try {
    const prepared = await prepareConfigPut(ctx.store, container, request);
    if (prepared.error) return prepared.error;
    const { id, existing, incoming } = prepared;
    const { doc, change } = putDocumentAndChange(ctx.now().toISOString(), container, prepared);

    const refusal = await superAdminRefusal(ctx.guard, request, needsSuperAdmin(container, change, existing));
    if (refusal) return refusal;
    if (container === 'mcp_servers') Object.assign(doc, connectionChangeEffects(container, change, existing));
    await ctx.store.upsertDoc(container, doc);
    await afterConfigWrite(ctx, context, {
      container,
      id,
      user: auth.user,
      existing,
      fields: incoming,
      action: 'put',
    });
    return json(200, { success: true, id, item: readableDoc(container, doc) });
  } catch (error) {
    context.error(`putConfig(${container}) failed:`, errorFacts(error));
    return json(500, { error: 'Failed to save configuration' });
  }
}

/** PATCH /api/cms/{collection}/{id} — setEnabled / model / token / url patches. */
async function patchConfig(ctx, request, context) {
  const route = await openConfigRoute(ctx, request);
  if (route.error) return route.error;
  const { auth, container } = route;
  try {
    const prepared = await prepareConfigPatch(ctx.store, container, request);
    if (prepared.error) return prepared.error;
    const refusal = await superAdminRefusal(
      ctx.guard,
      request,
      needsSuperAdmin(container, prepared.updates, prepared.existing)
    );
    if (refusal) return refusal;
    const updated = await ctx.store.patchDoc(container, prepared.id, {
      ...prepared.updates,
      ...connectionChangeEffects(container, prepared.updates, prepared.existing),
      updatedAt: ctx.now().toISOString(),
    });
    await afterConfigWrite(ctx, context, {
      container,
      id: prepared.id,
      user: auth.user,
      existing: prepared.existing,
      fields: prepared.updates,
      action: 'patch',
    });
    return json(200, { success: true, item: readableDoc(container, updated) });
  } catch (error) {
    context.error(`patchConfig(${container}) failed:`, errorFacts(error));
    return json(500, { error: 'Failed to update configuration' });
  }
}

/** DELETE /api/cms/{collection}/{id} */
async function deleteConfig(ctx, request, context) {
  const route = await openConfigRoute(ctx, request);
  if (route.error) return route.error;
  const { auth, container } = route;
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    // Read before the decision, and a failed read fails the delete: deleting
    // an OAuth Connect server removes its tokens, which is Disconnect by
    // another name, and Disconnect is super_admin (review of #1019).
    const existing = await ctx.store.readDoc(container, id, id);
    const refusal = await superAdminRefusal(
      ctx.guard,
      request,
      container === 'mcp_servers' && usesOAuthConnect(existing ?? {})
    );
    if (refusal) return refusal;
    await ctx.store.deleteDoc(container, id);
    await afterConfigWrite(ctx, context, {
      container,
      id,
      user: auth.user,
      existing,
      fields: {},
      action: 'delete',
    });
    return json(200, { success: true });
  } catch (error) {
    context.error(`deleteConfig(${container}) failed:`, errorFacts(error));
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
