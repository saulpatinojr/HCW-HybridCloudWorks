/**
 * The steps every ambassador route is built from (ADR 0033 §4): the context
 * a handler reads, the loaders that turn a request into a cleaned body and a
 * stored document or a refusal, the shared patch and delete shapes, and the
 * guard that names a Cosmos failure in one place — an absent container is
 * 503 NOT_PROVISIONED, never a 500.
 */
import { actorName } from '../auth/actor-name.js';
import { CONTAINER, NOT_PROVISIONED } from './model.js';
import { DEFAULT_PROGRAMS, SUPERSEDED_SEED_VALUES, currentSeedRevision } from './programs.js';
import { str } from './fields.js';
import { validateApplication, validateEvidence, validateProgram } from './validate.js';

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
    ctx.log.error?.('[ambassador] audit row failed', error);
  }
}

/** One seed as the stored document: enabled, ordered, stamped. */
function seededDoc(ctx, program, order) {
  const stamp = ctx.nowIso();
  return {
    ...program,
    docType: 'program',
    enabled: true,
    order,
    seeded: true,
    reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 30 },
    customFields: [],
    // A seed with a superseded history starts at its current revision, so
    // nothing of it is ever "corrected".
    ...(SUPERSEDED_SEED_VALUES[program.id]
      ? { seedRevision: currentSeedRevision(program.id) }
      : {}),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * The stored programs plus any DEFAULT_PROGRAMS entry the container does not
 * hold yet, inserted after the current highest `order`. An empty container
 * gets every seed in order (the first read); an existing one gets only the
 * seeds added since, so a program edited, disabled or soft-deleted by the
 * owner is never overwritten or brought back — a soft-deleted seed is absent
 * from `rows` but still stored, and the read of its id is what keeps it out.
 */
export async function ensureSeededPrograms(ctx, rows) {
  const current = await backfillSeedFields(ctx, rows);
  const present = new Set(current.map((row) => row.id));
  const missing = DEFAULT_PROGRAMS.filter((program) => !present.has(program.id));
  if (missing.length === 0) return current;
  let order = current.reduce((max, row) => Math.max(max, Number(row.order) || 0), 0);
  const added = [];
  for (const program of missing) {
    const stored = await ctx.store.readDoc(CONTAINER, program.id, program.id);
    if (stored) continue;
    order += 1;
    const inserted = await insertSeed(ctx, seededDoc(ctx, program, order));
    if (inserted) added.push(inserted);
  }
  return [...current, ...added];
}

/**
 * Create the seed atomically. Two overlapping reads can both find it
 * missing; the second's create answers 409, and the row the first inserted
 * — with whatever the owner edited since — wins: it is re-read and used as
 * stored, or left out when it was soft-deleted in the meantime. Nothing is
 * ever overwritten.
 */
async function insertSeed(ctx, doc) {
  try {
    return (await ctx.store.createDoc(CONTAINER, doc)) || doc;
  } catch (error) {
    if (error?.code !== 409) throw error;
    const stored = await ctx.store.readDoc(CONTAINER, doc.id, doc.id);
    return stored && !stored.softDeletedAt ? stored : null;
  }
}

const SEEDS_BY_ID = new Map(DEFAULT_PROGRAMS.map((program) => [program.id, program]));

const hasQuestions = (doc) =>
  Array.isArray(doc?.applicationQuestions) && doc.applicationQuestions.length > 0;

/** Plain objects with their keys sorted, so two equal values serialise alike. */
const canonical = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner
  );

/**
 * The fields a seed gained after it was stored that a stored seed may take
 * without losing an edit: the official `applicationQuestions` when the
 * document has none, `scoring` when it has none, and `parentProgramId` when
 * the seed became additional to another program. Each is a whole value
 * the owner has never set (missing or empty), so filling it in cannot
 * overwrite anything; the field's own editor takes over from there.
 */
const BACKFILL_FIELDS = [
  ['applicationQuestions', (stored, seed) => hasQuestions(seed) && !hasQuestions(stored)],
  ['scoring', (stored, seed) => Boolean(seed.scoring) && !stored.scoring],
  // Absent, not falsy: the owner clearing "Additional to" stores an explicit
  // null, and that is an edit to keep, not a gap to fill (#881 review).
  [
    'parentProgramId',
    (stored, seed) => Boolean(seed.parentProgramId) && !('parentProgramId' in stored),
  ],
  // Absent, as for parentProgramId: the owner clearing it stores null.
  ['upkeep', (stored, seed) => Boolean(seed.upkeep) && !('upkeep' in stored)],
];

/**
 * Give a stored seed (`seeded: true`, the id in DEFAULT_PROGRAMS, listed so
 * not soft-deleted) the fields the seed gained since it was stored, when the
 * document has none of its own: one patch per program that needs it, on the
 * stored ETag where the store exposes one. Nothing else on the document is
 * touched — requirements, description, enabled, order, membership and every
 * other field stay as the owner left them. A program the owner created, or a
 * seed already carrying its own value, is left alone.
 */
async function backfillSeedFields(ctx, rows) {
  const out = [];
  for (const stored of rows) {
    const patch = seedBackfillFor(stored, SEEDS_BY_ID.get(stored.id));
    if (!patch) {
      out.push(stored);
      continue;
    }
    const patched = await ctx.store.patchDoc(
      CONTAINER,
      stored.id,
      { ...patch, updatedAt: ctx.nowIso() },
      stored._etag ? { ifMatch: stored._etag } : {}
    );
    // Field names only: telemetry carries no document id (CodeRabbit on #1077).
    ctx.log.info?.(`[ambassador] seed backfill: ${Object.keys(patch).join(', ')}`);
    out.push(patched || { ...stored, ...patch });
  }
  return out;
}

/**
 * What a stored program should take from its seed: the BACKFILL_FIELDS it
 * has none of, as the patch to write, or null when there is nothing to do —
 * no seed for the id, a program the owner made (not `seeded`), or a seed
 * already carrying its own values. Pure, so the decision is testable alone.
 */
export function seedBackfillFor(stored, seed) {
  if (!seed || stored?.seeded !== true) return null;
  const patch = {};
  for (const [field, wanted] of BACKFILL_FIELDS) {
    if (wanted(stored, seed)) patch[field] = seed[field];
  }
  // Once per revision (programs.js SUPERSEDED_SEED_VALUES): a field still
  // holding the value of any earlier seed above the stored revision was
  // never edited, so the current seed's value replaces it, and the stamp
  // keeps a later deliberate return to an old value from being corrected
  // again. Every step above the stored revision is read, not only the last,
  // so a row that missed a revision is still matched against what it holds
  // (CodeRabbit on #1304).
  const history = SUPERSEDED_SEED_VALUES[seed.id]?.revisions || [];
  const storedRevision = Number(stored.seedRevision) || 1;
  const target = currentSeedRevision(seed.id);
  if (history.length > 0 && storedRevision < target) {
    const missed = history.filter((step) => step.revision > storedRevision);
    for (const field of new Set(missed.flatMap((step) => Object.keys(step.fields)))) {
      if (!(field in seed) || !(field in stored)) continue;
      const held = canonical(stored[field]);
      const replaced = missed.some(
        (step) => field in step.fields && canonical(step.fields[field]) === held
      );
      if (replaced) patch[field] = seed[field];
    }
    patch.seedRevision = target;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Every program, the seeds filled in on every read, in display order. */
async function listOrSeedPrograms(ctx) {
  const programs = await ensureSeededPrograms(ctx, await ctx.listKind('program'));
  return programs.sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name))
  );
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
      (context?.error || ctx.log.error)?.(`${name} failed:`, error);
      return json(500, { error: `Failed to ${name}` });
    }
  };
}
