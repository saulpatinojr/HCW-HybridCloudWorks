/**
 * The steps every ambassador route is built from (ADR 0033 §4): the context
 * a handler reads, the loaders that turn a request into a cleaned body and a
 * stored document or a refusal, the shared patch and delete shapes, and the
 * guard that names a Cosmos failure in one place — an absent container is
 * 503 NOT_PROVISIONED, never a 500.
 */
import { actorName } from '../auth/actor-name.js';
import { CONTAINER, NOT_PROVISIONED } from './model.js';
import { listOrSeedPrograms } from './seeding.js';
import { str } from './fields.js';
import { validateApplication, validateEvidence, validateProgram } from './validate.js';
import { errorFacts } from '../http/error-response.js';

export { ensureSeededPrograms, seedBackfillFor } from './seeding.js';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** A step that cannot go on, carrying the response to send instead. */
export const refuse = (status, body) => ({ error: json(status, body) });

const MAX_DOC_JSON = 200_000;
const LIST_WINDOW = 2000;

/** A Cosmos 404 raised by a query or write is the container itself being absent. */
export function isNotProvisioned(error) {
  if (!error || error.code !== 404) return false;
  const text = String(error.message || error.body?.message || '');
  return /Resource Not Found|Owner resource does not exist|NotFound/i.test(text) || !text;
}

const SELECT_KIND = `SELECT TOP ${LIST_WINDOW} * FROM c WHERE c.docType = @docType AND (NOT IS_DEFINED(c.softDeletedAt) OR IS_NULL(c.softDeletedAt))`;

export const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
export const byUpdatedDesc = (a, b) =>
  String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));

/** The three document kinds, as the shared create, patch and delete steps need them. */
export const KINDS = Object.freeze({
  program: { docType: 'program', label: 'Program', validate: validateProgram },
  application: { docType: 'application', label: 'Application', validate: validateApplication },
  evidence: { docType: 'evidence', label: 'Evidence', validate: validateEvidence },
});

// ── the context every handler reads ───────────────────────────────────────────

/** The request body as a JSON object within `max` characters, or null; a route with a larger payload (the CSV import) names its own cap. */
async function readJsonObject(request, max = MAX_DOC_JSON) {
  const body = await request.json().catch(() => null);
  const isObject = body && typeof body === 'object' && !Array.isArray(body);
  return isObject && JSON.stringify(body).length <= max ? body : null;
}

async function writeAudit(ctx, action, auth, request, details) {
  try {
    await ctx.store.upsertDoc('admin_audit_logs', {
      id: ctx.uuid(),
      action,
      userId: auth.user?.oid || auth.user?.sub || null,
      userEmail: auth.user?.email || null,
      timestamp: ctx.nowIso(),
      details,
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    ctx.log.error?.('[ambassador] audit row failed', errorFacts(error));
  }
}

export function createContext({ store, now, uuid, log }) {
  const nowIso = () => now().toISOString();
  const ctx = {
    store,
    uuid,
    log,
    nowIso,
    today: () => nowIso().slice(0, 10),
    listKind: (docType) =>
      store.queryDocs(CONTAINER, SELECT_KIND, [{ name: '@docType', value: docType }]),
    readKind: async (docType, id) => {
      const doc = await store.readDoc(CONTAINER, id, id);
      return doc && doc.docType === docType && !doc.softDeletedAt ? doc : null;
    },
    readBody: readJsonObject,
    audit: (action, auth, request, details) => writeAudit(ctx, action, auth, request, details),
    listPrograms: () => listOrSeedPrograms(ctx),
  };
  return ctx;
}

// ── the shared steps ──────────────────────────────────────────────────────────

/** The route's `{id}` and the stored document of that kind, or the refusal. */
export async function loadExisting(ctx, request, kind) {
  const id = str(request.params?.id, 200);
  if (!id) return refuse(400, { error: 'id required' });
  const existing = await ctx.readKind(kind.docType, id);
  if (!existing) return refuse(404, { error: `${kind.label} ${id} not found` });
  return { id, existing };
}

/** A non-empty body cleaned as a partial patch, and the document it patches. */
export async function loadPatch(ctx, request, kind) {
  const id = str(request.params?.id, 200);
  if (!id) return refuse(400, { error: 'id required' });
  const body = await ctx.readBody(request);
  if (!body || Object.keys(body).length === 0)
    return refuse(400, { error: 'Body must be a non-empty JSON object' });
  const checked = kind.validate(body, { partial: true });
  if (checked.error) return refuse(400, { error: checked.error });
  const existing = await ctx.readKind(kind.docType, id);
  if (!existing) return refuse(404, { error: `${kind.label} ${id} not found` });
  return { id, existing, updates: checked.value };
}

/** A JSON body cleaned as a full write. */
export async function loadCreate(ctx, request, kind) {
  const body = await ctx.readBody(request);
  if (!body) return refuse(400, { error: 'Body must be a JSON object' });
  const checked = kind.validate(body);
  if (checked.error) return refuse(400, { error: checked.error });
  return { body, value: checked.value };
}

/** Stamp a new document of `kind` with its identity and timestamps. */
export function stamped(ctx, kind, doc, auth) {
  const stamp = ctx.nowIso();
  return {
    ...doc,
    id: `${kind.docType}-${ctx.uuid()}`,
    docType: kind.docType,
    createdAt: stamp,
    ...(auth ? { createdBy: actorName(auth.user) } : {}),
    updatedAt: stamp,
  };
}

/**
 * A program's `parentProgramId`, checked against the catalogue: the parent
 * must exist, must not be the program itself, must not have a parent of its
 * own, and the program being parented must not have children of its own
 * (one level — additional requirements, not a tree). Null or an empty
 * string clears it. Returns the 400 to answer, or null when fine.
 *
 * Two super_admin PATCHes interleaving inside one read-then-write window
 * could still both pass (A under B and B under A); the catalogue has one
 * editor and no lock is taken for that. The readers are built so the
 * outcome is visible rather than silent: `programsInPlay` (frontend model)
 * lists a program whose parent is itself parented at top level, so nothing
 * disappears, and the next PATCH on either row is refused by the rules here.
 */
export async function checkParentProgram(ctx, value, selfId = null) {
  if (!('parentProgramId' in value)) return null;
  const parentId = value.parentProgramId;
  if (!parentId) value.parentProgramId = null;
  const reason = parentId ? await parentRefusal(ctx, parentId, selfId) : null;
  return reason ? json(400, { error: reason }) : null;
}

/** The sentence refusing `parentId` as a parent of `selfId`, or null when it may be one. */
async function parentRefusal(ctx, parentId, selfId) {
  if (selfId && parentId === selfId) return 'A program cannot be additional to itself';
  const parent = await ctx.readKind('program', parentId);
  if (!parent) return `Unknown parentProgramId ${parentId}`;
  if (parent.parentProgramId) {
    return `${parent.name} is itself additional to another program; one level only`;
  }
  if (selfId) {
    // The effective catalogue — seeds filled in and backfilled — not only
    // the stored rows: a seeded child not yet inserted, or not yet carrying
    // its parent, would otherwise appear on the next read under a program
    // that just took a parent of its own (#883 review).
    const children = (await ctx.listPrograms()).filter((p) => p.parentProgramId === selfId);
    if (children.length > 0) {
      return `${children.map((c) => c.name).join(', ')} ${children.length === 1 ? 'is' : 'are'} already additional to this program; one level only`;
    }
  }
  return null;
}

/**
 * PATCH {kind}/{id}: the cleaned fields over the stored document, audited.
 * `check(ctx, loaded)` may answer a response to refuse the write after the
 * body passed its validator — the program parent rule lives there.
 */
export function patchHandler(kind, { action, details, check = null }) {
  return async (ctx, request, auth) => {
    const loaded = await loadPatch(ctx, request, kind);
    if (loaded.error) return loaded.error;
    const refused = check ? await check(ctx, loaded) : null;
    if (refused) return refused;
    const updated = await ctx.store.patchDoc(CONTAINER, loaded.id, {
      ...loaded.updates,
      updatedAt: ctx.nowIso(),
    });
    await ctx.audit(action, auth, request, details(loaded));
    return json(200, { success: true, item: updated });
  };
}

/** DELETE {kind}/{id}: soft, audited; `extra` is what else the mark sets. */
export function deleteHandler(kind, { action, details, extra = {} }) {
  return async (ctx, request, auth) => {
    const loaded = await loadExisting(ctx, request, kind);
    if (loaded.error) return loaded.error;
    await ctx.store.patchDoc(CONTAINER, loaded.id, {
      softDeletedAt: ctx.nowIso(),
      ...extra,
      updatedAt: ctx.nowIso(),
    });
    await ctx.audit(action, auth, request, details(loaded));
    return json(200, { success: true, id: loaded.id });
  };
}

/** Every handler: role, then the body, then one place a Cosmos failure is named. */
export function guardedHandler({ guard, ctx }, role, name, fn) {
  return async (request, context) => {
    const auth = await guard.requireRole(request, role);
    if (auth.error) return auth.error;
    try {
      return await fn(ctx, request, auth);
    } catch (error) {
      if (isNotProvisioned(error)) return json(503, NOT_PROVISIONED);
      (context?.error || ctx.log.error)?.(`${name} failed:`, errorFacts(error));
      return json(500, { error: `Failed to ${name}` });
    }
  };
}
