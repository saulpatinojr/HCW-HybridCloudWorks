// The work behind each Second Brain route. handlers.js wraps each one in
// the owner check and the error answer; every function here takes `ctx`
// first: `{ repo, sources, indexer, env, enqueue, ai }`.
import { buildNewDraftDocument, validateDraftFields } from '../cms/drafts.js';
import { validateTaxonomyFieldsWithStore } from '../cms/taxonomy-fields.js';
import {
  RECORDS,
  fail,
  clean,
  validateRecord,
  readJson,
  ID,
  digest,
  text,
} from './model.js';
import { askBrain } from './assistant.js';

const OWN_TYPES = ['note', 'topic', 'project', 'conflict'];
const SYNC_ERRORS = [
  'none',
  'offline',
  'authentication',
  'conflict',
  'unavailable',
];

export const queryOf = (request) =>
  request.query || new URL(request.url).searchParams;
export const safeNumber = (value, fallback, max) =>
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= max
    ? Number(value)
    : fallback;
export const summary = (item) => {
  const {
    body,
    searchable: _searchable,
    tokens: _tokens,
    ...rest
  } = clean(item);
  return { ...rest, excerpt: text(body, 300) };
};

const isActiveCollection = (collection) =>
  collection &&
  !collection.archived &&
  ['topic', 'project'].includes(collection.type);

export async function write({ repo, sources }, body) {
  const item = validateRecord(body.item);
  if (!Number.isSafeInteger(body.version) || body.version < 0)
    fail(400, 'INVALID', 'A base version is required.');
  for (const id of item.collections) {
    const collection = await repo.read(id);
    if (!isActiveCollection(collection))
      fail(400, 'INVALID', 'Choose an active topic or project.');
  }
  const saved = await repo.commit(item, {
    version: body.version,
    mutationId: body.mutationId,
  });
  // The authored save already succeeded. Index failure cannot invite an
  // overwrite; queued reconciliation repairs it and the UI reports it.
  let indexPending = false;
  try {
    await sources.indexItem(saved);
  } catch {
    indexPending = true;
  }
  return { item: saved, indexPending };
}

export async function getItem({ repo, sources }, id) {
  if (!ID.test(id || '')) fail(400, 'INVALID', 'Invalid item id.');
  const item = await sources.get(id);
  if (!item) fail(404, 'NOT_FOUND', 'Item no longer available.');
  return {
    item: clean(item),
    backlinks: (await repo.backlinks(id)).map(summary),
  };
}

export const get = (ctx, request) => getItem(ctx, request.params.id);

export async function save(ctx, request) {
  return write(ctx, await readJson(request));
}

export async function status({ repo, env }) {
  return {
    enabled: true,
    indexing: clean(await repo.read('indexing')),
    sync: clean(await repo.read('sync-status')),
    aiEnabled: env.BRAIN_AI_ENABLED === 'true',
    syncClientId: env.BRAIN_SYNC_CLIENT_ID || null,
    tenantId: env.BRAIN_OWNER_TENANT_ID,
    audience: env.ENTRA_API_AUDIENCE,
  };
}

export async function list({ repo }, request) {
  const q = queryOf(request);
  const limit = 50;
  const items = await repo.list({
    after: text(q.get('after'), 128),
    limit,
    archived: q.get('archived') === 'true',
    type: OWN_TYPES.includes(q.get('type')) ? q.get('type') : null,
  });
  return {
    items: items.map(summary),
    after: items.length === limit ? items.at(-1).seq : null,
  };
}

export async function history(ctx, request) {
  await getItem(ctx, request.params.id);
  const before =
    safeNumber(
      queryOf(request).get('before'),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ) || Number.MAX_SAFE_INTEGER;
  const items = await ctx.repo.history(request.params.id, before);
  return {
    items: items.map(clean),
    before: items.length === 50 ? items.at(-1).seq : null,
  };
}

export async function search({ repo, sources }, request) {
  const body = await readJson(request);
  const found = await sources.search({
    q: text(body.q, 300),
    cursor: typeof body.cursor === 'string' ? body.cursor : null,
    kind: text(body.kind, 20),
  });
  return {
    ...found,
    items: found.items.map(summary),
    indexing: clean(await repo.read('indexing')),
  };
}

export async function graph({ sources }, request) {
  const q = queryOf(request);
  const page = await sources.search({
    cursor: q.get('cursor'),
    limit: 100,
  });
  return {
    nodes: page.items.map(summary),
    edges: page.items.flatMap((item) => edgesOf(item, page.items)),
    cursor: page.cursor,
    hasMore: page.hasMore,
  };
}

// One item's edges: its links, its collections, and up to three items on
// the same page that share a tag.
function edgesOf(item, items) {
  const edges = [];
  for (const target of item.links || [])
    edges.push({ from: item.id, to: target, kind: 'explicit' });
  for (const target of item.collections || [])
    edges.push({ from: item.id, to: target, kind: 'membership' });
  for (const related of items
    .filter((b) => b.id !== item.id && item.tags.some((t) => b.tags.includes(t)))
    .slice(0, 3))
    edges.push({ from: item.id, to: related.id, kind: 'suggested' });
  return edges;
}

export async function reindex({ repo, indexer, enqueue }) {
  const job = await indexer.start();
  await enqueue({ ownerId: repo.ownerId });
  return { indexing: clean(job) };
}

const isDraftableNote = (note) =>
  note && ['note', 'conflict'].includes(note.type) && !note.archived;

export async function draft({ repo }, request, auth) {
  const body = await readJson(request);
  const note = await repo.read(request.params.id);
  if (!isDraftableNote(note))
    fail(404, 'NOT_FOUND', 'Choose an active note.');
  if (!ID.test(body.requestId || ''))
    fail(400, 'INVALID', 'A stable requestId is required.');
  const id = `brain_${digest(`${repo.ownerId}/${note.id}/${body.requestId}`).slice(0, 48)}`;
  const fields = validateDraftFields(body.fields);
  await validateTaxonomyFieldsWithStore(repo.store, fields);
  const draftDocument = buildNewDraftDocument({
    id,
    fields,
    editor: auth.user.oid,
  });
  const requestHash = digest(JSON.stringify(fields));
  const provenance = await ensureProvenance(repo, {
    id,
    note,
    requestHash,
    draftDocument,
  });
  if (provenance.requestHash !== requestHash)
    fail(
      409,
      'CONFLICT',
      'This draft request already used different text. Start a new request for a different draft.',
    );
  const old = await repo.store.readDoc('content', id);
  if (old && old.createdBy !== auth.user.oid)
    fail(409, 'CONFLICT', 'Draft identity conflict.');
  if (!old) await createIgnoringConflict(repo.store, 'content', provenance.draftDocument);
  return { id, href: '/admin/drafts', existing: Boolean(old) };
}

// The record of which note a draft came from, made once (create-only): a
// second request with the same id reads the one already there.
async function ensureProvenance(repo, { id, note, requestHash, draftDocument }) {
  const provenanceId = `provenance_${id}`;
  const existing = await repo.read(provenanceId);
  if (existing) return existing;
  try {
    return await repo.store.createDoc(RECORDS, {
      id: provenanceId,
      ownerId: repo.ownerId,
      type: 'provenance',
      contentId: id,
      noteId: note.id,
      noteVersion: note.version,
      sourceIds: note.links,
      collectionIds: note.collections,
      createdAt: new Date().toISOString(),
      requestHash,
      draftDocument,
    });
  } catch (error) {
    if (Number(error.code) !== 409) throw error;
    return repo.read(provenanceId);
  }
}

async function createIgnoringConflict(store, container, doc) {
  try {
    await store.createDoc(container, doc);
  } catch (error) {
    if (Number(error.code) !== 409) throw error;
  }
}

export async function context({ repo }, request) {
  const id = text(queryOf(request).get('contentId'), 128);
  if (!ID.test(id)) fail(400, 'INVALID', 'Content id is required.');
  const refId = `ref_${digest(`content/${id}`).slice(0, 40)}`;
  const notes = await repo.backlinks(refId);
  const provenance = await repo.read(`provenance_${id}`);
  if (provenance) await addOriginNote(repo, notes, provenance.noteId);
  return {
    sourceId: refId,
    items: notes.map(summary),
    provenance: originOf(provenance),
  };
}

// The note a draft was made from, added when it is active and not listed yet.
async function addOriginNote(repo, notes, noteId) {
  const note = await repo.read(noteId);
  if (note && !note.archived && !notes.some((n) => n.id === note.id))
    notes.push(note);
}

function originOf(provenance) {
  if (!provenance) return null;
  return {
    noteId: provenance.noteId,
    noteVersion: provenance.noteVersion,
    sourceIds: provenance.sourceIds,
    collectionIds: provenance.collectionIds,
  };
}

export async function ask({ repo, sources, ai, env }, request) {
  if (env.BRAIN_AI_ENABLED !== 'true')
    fail(
      503,
      'AI_DISABLED',
      'Enable Second Brain AI in the server configuration to use this action.',
    );
  const body = await readJson(request);
  if (body.contextId && !ID.test(body.contextId))
    fail(400, 'INVALID', 'Invalid context item.');
  const answer = await askBrain({
    sources,
    ai,
    question: body.question,
    mode: body.mode,
    contextId: body.contextId,
  });
  return { ...answer, indexing: clean(await repo.read('indexing')) };
}

export async function syncPull({ repo }, request) {
  const q = queryOf(request);
  const cursor = safeNumber(q.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
  const changes = await repo.changes(cursor);
  return { ...changes, protocol: 1 };
}

export async function syncPush(ctx, request) {
  const result = await write(ctx, await readJson(request));
  return { ...result, protocol: 1 };
}

const lastSyncOf = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

export async function syncStatus({ repo }, request) {
  const body = await readJson(request);
  const pending = safeNumber(body.pending, -1, 1000000);
  const conflicts = safeNumber(body.conflicts, -1, 1000000);
  if (pending < 0 || conflicts < 0 || !SYNC_ERRORS.includes(body.error))
    fail(400, 'INVALID', 'Invalid sync status.');
  await repo.putInternal({
    id: 'sync-status',
    type: 'sync-status',
    pending,
    conflicts,
    error: body.error,
    lastSuccessfulSync: lastSyncOf(body.lastSuccessfulSync),
    lastSeenAt: new Date().toISOString(),
  });
  return { ok: true, protocol: 1 };
}

export async function syncReferences({ repo, sources }, request) {
  const q = queryOf(request);
  const page = await sources.search({
    cursor: q.get('cursor'),
    kind: 'reference',
    limit: 30,
  });
  return {
    ...page,
    items: page.items.map(clean),
    indexComplete: (await repo.read('indexing'))?.status === 'complete',
    protocol: 1,
  };
}
