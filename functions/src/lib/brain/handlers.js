import { randomUUID } from 'node:crypto';
import { buildNewDraftDocument, validateDraftFields } from '../cms/drafts.js';
import { validateTaxonomyFieldsWithStore } from '../cms/taxonomy-fields.js';
import { RECORDS, fail, clean, readJson, ID, digest, text } from './model.js';
import { requireBrainOwner } from './guard.js';
import { createSourceService } from './sources.js';
import { createBrainIndexer } from './indexing.js';
import { askBrain } from './assistant.js';
import {
  privateRoute,
  queryOf,
  summary,
  prepareWrite,
  listPage,
  historyPage,
  syncStatusRecord,
  safeNumber,
} from './workspace.js';

export function createBrainHandlers({
  guard,
  syncGuard,
  repo,
  ai,
  env = process.env,
  enqueue = async () => {},
  log = console,
}) {
  const sources = createSourceService(repo);
  const indexer = createBrainIndexer(repo);
  const route = (work, sync = false) =>
    privateRoute(work, {
      authorize: (request) =>
        requireBrainOwner(sync ? syncGuard : guard, request, env, sync),
      failure:
        'Could not complete the Second Brain action. Your saved work is unchanged.',
      log,
    });
  async function write(body) {
    const item = await prepareWrite(repo, body);
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
  async function getItem(id) {
    if (!ID.test(id || '')) fail(400, 'INVALID', 'Invalid item id.');
    const item = await sources.get(id);
    if (!item) fail(404, 'NOT_FOUND', 'Item no longer available.');
    return {
      item: clean(item),
      backlinks: (await repo.backlinks(id)).map(summary),
    };
  }
  return {
    status: route(async () => ({
      enabled: true,
      indexing: clean(await repo.read('indexing')),
      sync: clean(await repo.read('sync-status')),
      aiEnabled: env.BRAIN_AI_ENABLED === 'true',
      syncClientId: env.BRAIN_SYNC_CLIENT_ID || null,
      tenantId: env.BRAIN_OWNER_TENANT_ID,
      audience: env.ENTRA_API_AUDIENCE,
    })),
    list: route((request) => listPage(repo, request)),
    get: route((request) => getItem(request.params.id)),
    save: route(async (request) => write(await readJson(request))),
    history: route(async (request) => {
      await getItem(request.params.id);
      return historyPage(repo, request.params.id, request);
    }),
    search: route(async (request) => {
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
    }),
    graph: route(async (request) => {
      const q = queryOf(request);
      const page = await sources.search({
        cursor: q.get('cursor'),
        limit: 100,
      });
      const edges = [];
      for (const item of page.items) {
        for (const target of item.links || [])
          edges.push({ from: item.id, to: target, kind: 'explicit' });
        for (const target of item.collections || [])
          edges.push({ from: item.id, to: target, kind: 'membership' });
        for (const related of page.items
          .filter(
            (b) =>
              b.id !== item.id && item.tags.some((t) => b.tags.includes(t)),
          )
          .slice(0, 3))
          edges.push({ from: item.id, to: related.id, kind: 'suggested' });
      }
      return {
        nodes: page.items.map(summary),
        edges,
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    }),
    reindex: route(async () => {
      const job = await indexer.start();
      await enqueue({ ownerId: repo.ownerId });
      return { indexing: clean(job) };
    }),
    draft: route(async (request, auth) => {
      const body = await readJson(request);
      const note = await repo.read(request.params.id);
      if (!note || !['note', 'conflict'].includes(note.type) || note.archived)
        fail(404, 'NOT_FOUND', 'Choose an active note.');
      if (!ID.test(body.requestId || ''))
        fail(400, 'INVALID', 'A stable requestId is required.');
      const id = `brain_${digest(`${repo.ownerId}/${note.id}/${body.requestId}`).slice(0, 48)}`;
      const fields = validateDraftFields(body.fields);
      await validateTaxonomyFieldsWithStore(repo.store, fields);
      const draft = buildNewDraftDocument({
        id,
        fields,
        editor: auth.user.oid,
      });
      const provenanceId = `provenance_${id}`;
      const requestHash = digest(JSON.stringify(fields));
      let provenance = await repo.read(provenanceId);
      if (!provenance) {
        try {
          provenance = await repo.store.createDoc(RECORDS, {
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
            draftDocument: draft,
          });
        } catch (error) {
          if (Number(error.code) !== 409) throw error;
          provenance = await repo.read(provenanceId);
        }
      }
      if (provenance.requestHash !== requestHash)
        fail(
          409,
          'CONFLICT',
          'This draft request already used different text. Start a new request for a different draft.',
        );
      const old = await repo.store.readDoc('content', id);
      if (old && old.createdBy !== auth.user.oid)
        fail(409, 'CONFLICT', 'Draft identity conflict.');
      if (!old) {
        try {
          await repo.store.createDoc('content', provenance.draftDocument);
        } catch (error) {
          if (Number(error.code) !== 409) throw error;
        }
      }
      return { id, href: '/admin/drafts', existing: Boolean(old) };
    }),
    context: route(async (request) => {
      const id = text(queryOf(request).get('contentId'), 128);
      if (!ID.test(id)) fail(400, 'INVALID', 'Content id is required.');
      const refId = `ref_${digest(`content/${id}`).slice(0, 40)}`;
      const notes = await repo.backlinks(refId);
      const provenance = await repo.read(`provenance_${id}`);
      if (provenance) {
        const note = await repo.read(provenance.noteId);
        if (note && !note.archived && !notes.some((n) => n.id === note.id))
          notes.push(note);
      }
      const privateOrigin = provenance
        ? {
            noteId: provenance.noteId,
            noteVersion: provenance.noteVersion,
            sourceIds: provenance.sourceIds,
            collectionIds: provenance.collectionIds,
          }
        : null;
      return {
        sourceId: refId,
        items: notes.map(summary),
        provenance: privateOrigin,
      };
    }),
    ask: route(async (request) => {
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
    }),
    syncPull: route(async (request) => {
      const q = queryOf(request);
      const cursor = safeNumber(q.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
      const changes = await repo.changes(cursor);
      return { ...changes, protocol: 1 };
    }, true),
    syncPush: route(async (request) => {
      const result = await write(await readJson(request));
      return { ...result, protocol: 1 };
    }, true),
    syncStatus: route(async (request) => {
      await repo.putInternal(syncStatusRecord(await readJson(request)));
      return { ok: true, protocol: 1 };
    }, true),
    syncReferences: route(async (request) => {
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
    }, true),
    newId: () => randomUUID(),
  };
}
