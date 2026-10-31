/**
 * The Code Conductor brain (#1457, ADR 0036): a second private workspace that
 * must stay apart from the creator Second Brain. Synthetic identities only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryStore } from '../../../test/brain-store.js';
import { createBrainRepository } from '../brain/repository.js';
import { createBrainHandlers } from '../brain/handlers.js';
import { createRoleGuard } from '../auth/require-role.js';
import { CODE_RECORDS, CODE_SYNC_SCOPE, codeBrainConfig, CODE_BRAIN_PARTITION_KEY_PATHS } from './config.js';
import { createCodeBrainHandlers } from './handlers.js';
import { createCodeBrainStore } from './store.js';
import { PARTITION_KEY_PATHS } from '../cosmos-client.js';

const SPEC = JSON.parse(
  readFileSync(
    join(fileURLToPath(new URL('../../../..', import.meta.url)), 'infra', 'cosmos-code-brain-containers.json'),
    'utf8',
  ),
);

const env = {
  COSMOS_DATABASE: 'hcw',
  ENTRA_API_AUDIENCE: 'api-audience',
  BRAIN_ENABLED: 'true',
  BRAIN_OWNER_OID: 'owner',
  BRAIN_OWNER_TENANT_ID: 'tenant',
  BRAIN_SYNC_CLIENT_ID: 'creator-desktop',
  CODE_BRAIN_ENABLED: 'true',
  CODE_BRAIN_OWNER_OID: 'owner',
  CODE_BRAIN_OWNER_TENANT_ID: 'tenant',
  CODE_BRAIN_SYNC_CLIENT_ID: 'code-desktop',
  CODE_BRAIN_COSMOS_DATABASE: 'hcw_code_brain',
};
const codeUser = {
  oid: 'owner',
  tid: 'tenant',
  roles: ['Admin'],
  scp: CODE_SYNC_SCOPE,
  azp: 'code-desktop',
};
const note = (id = 'note-1', extra = {}) => ({
  id,
  type: 'note',
  title: 'Pipeline design',
  body: 'Run the plan check before every apply.',
  tags: ['ci'],
  links: [],
  collections: [],
  urls: [],
  archived: false,
  inbox: true,
  ...extra,
});
const request = (body = {}, params = {}, query = '', token = true) => ({
  params,
  query: new URLSearchParams(query),
  headers: {
    get: (name) => (token && name === 'authorization' ? 'Bearer fake' : null),
  },
  json: async () => body,
  url: `https://hcw.invalid/?${query}`,
});
const json = (r) => JSON.parse(r.body);
const guardFor = (delegatedScope, user, admin = { active: true, role: 'editor' }, registry = {}) =>
  createRoleGuard({
    verifier: { verify: async () => user },
    delegatedScope,
    lookupAdmin: registry.lookupAdmin || (async () => admin),
    auditDenial: registry.auditDenial,
  });

/** One creator workspace and one Code Conductor workspace, each in its own store (database). */
function setup({ user = codeUser, admin = { active: true, role: 'editor' }, settings = env } = {}) {
  // The admin registry and the denial log are Cosmos reads and writes too.
  const registry = { lookupAdmin: vi.fn(async () => admin), auditDenial: vi.fn() };
  const creator = memoryStore();
  const code = memoryStore({ records: CODE_RECORDS });
  const codeRepo = createBrainRepository(code.store, 'owner', code.batch, {
    records: CODE_RECORDS,
    search: null,
  });
  const creatorRepo = createBrainRepository(creator.store, 'owner', creator.batch);
  const codeHandlers = createCodeBrainHandlers({
    syncGuard: guardFor(CODE_SYNC_SCOPE, user, admin, registry),
    repo: codeRepo,
    env: settings,
    log: { error: vi.fn() },
  });
  const creatorHandlers = createBrainHandlers({
    guard: guardFor('access_as_admin', user, admin),
    syncGuard: guardFor('brain_sync', user, admin),
    repo: creatorRepo,
    env: settings,
    log: { error: vi.fn() },
  });
  return { creator, code, codeRepo, creatorRepo, codeHandlers, creatorHandlers, registry };
}
const push = (handlers, item, version, mutationId) =>
  handlers.syncPush(request({ item, version, mutationId }));

const READ_ACTIONS = ['status', 'list', 'get', 'history', 'syncPull'];
const WRITE_ACTIONS = ['syncPush', 'syncStatus'];

describe('Code Conductor brain configuration', () => {
  it('is off by default and with any setting missing or shared with the creator workspace', () => {
    expect(codeBrainConfig({}).enabled).toBe(false);
    expect(codeBrainConfig(env).enabled).toBe(true);
    for (const [name, value] of [
      ['CODE_BRAIN_ENABLED', 'false'],
      ['CODE_BRAIN_ENABLED', 'TRUE'],
      ['CODE_BRAIN_OWNER_OID', ''],
      ['CODE_BRAIN_OWNER_TENANT_ID', ''],
      ['CODE_BRAIN_SYNC_CLIENT_ID', ''],
      ['CODE_BRAIN_SYNC_CLIENT_ID', 'CREATOR-DESKTOP'],
      ['CODE_BRAIN_COSMOS_DATABASE', ''],
      ['CODE_BRAIN_COSMOS_DATABASE', 'hcw'],
      // The creator database in another spelling is still the creator database.
      ['CODE_BRAIN_COSMOS_DATABASE', 'HCW'],
      ['CODE_BRAIN_COSMOS_DATABASE', ' hcw'],
      ['CODE_BRAIN_COSMOS_DATABASE', 'Hcw '],
    ])
      expect(codeBrainConfig({ ...env, [name]: value }).enabled, `${name}=${value}`).toBe(false);
    // The creator database is "hcw" when COSMOS_DATABASE is unset, too.
    const { COSMOS_DATABASE: _unset, ...noDefault } = env;
    expect(codeBrainConfig({ ...noDefault, CODE_BRAIN_COSMOS_DATABASE: 'hcw' }).enabled).toBe(false);
  });

  it('reads no BRAIN_* switch: the creator brain off leaves this one on, and the reverse', () => {
    expect(codeBrainConfig({ ...env, BRAIN_ENABLED: 'false', BRAIN_OWNER_OID: '' }).enabled).toBe(true);
  });

  it('names the database and container the Terraform spec provisions, partitioned by owner', () => {
    expect(SPEC.database).toBe(env.CODE_BRAIN_COSMOS_DATABASE);
    expect(SPEC.containers.map((c) => [c.name, c.partition_key_path])).toEqual(
      Object.entries(CODE_BRAIN_PARTITION_KEY_PATHS),
    );
    // The creator database's partition map knows nothing of this container.
    expect(PARTITION_KEY_PATHS[CODE_RECORDS]).toBeUndefined();
  });
});

describe('Code Conductor brain boundary', () => {
  it.each([
    ['no token', { token: false }, 401],
    ['an ordinary admin token', { user: { ...codeUser, scp: 'access_as_admin' } }, 401],
    ['a creator Second Brain sync token', { user: { ...codeUser, scp: 'brain_sync', azp: 'creator-desktop' } }, 401],
    ['the creator desktop client', { user: { ...codeUser, azp: 'creator-desktop' } }, 403],
    ['the browser client', { user: { ...codeUser, azp: 'spa' } }, 403],
    ['another administrator', { user: { ...codeUser, oid: 'other' }, admin: { active: true, role: 'super_admin' } }, 404],
    ['the owner in another tenant', { user: { ...codeUser, tid: 'another' } }, 404],
    ['an inactive owner', { admin: { active: false, role: 'editor' } }, 403],
    ['a viewer owner', { admin: { active: true, role: 'viewer' } }, 403],
    ['the workspace switched off', { settings: { ...env, CODE_BRAIN_ENABLED: 'false' } }, 404],
    ['no separate database', { settings: { ...env, CODE_BRAIN_COSMOS_DATABASE: 'hcw' } }, 404],
    ['a client shared with the creator brain', { settings: { ...env, CODE_BRAIN_SYNC_CLIENT_ID: 'creator-desktop' } }, 404],
  ])('refuses %s without reading or writing anything', async (_name, options, status) => {
    const { codeHandlers, code } = setup(options);
    const reads = vi.spyOn(code.store, 'readDoc');
    const queries = vi.spyOn(code.store, 'queryDocs');
    const writes = vi.spyOn(code.store, 'upsertDoc');
    for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS]) {
      const req = request(
        { item: note(), version: 0, mutationId: 'mutation-001', pending: 0, conflicts: 0, error: 'none' },
        { id: 'note-1' },
        '',
        options.token !== false,
      );
      const response = await codeHandlers[action](req);
      expect(response.status, action).toBe(status);
      expect(response.headers['Cache-Control'], action).toBe('private, no-store');
      expect(response.headers['X-Robots-Tag'], action).toBe('noindex, nofollow');
    }
    expect(reads).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(code.store.docs.size).toBe(0);
  });

  it.each([
    ['switched off', { ...env, CODE_BRAIN_ENABLED: 'false' }],
    ['never configured', {}],
    ['no owner', { ...env, CODE_BRAIN_OWNER_OID: '' }],
    ['the creator database', { ...env, CODE_BRAIN_COSMOS_DATABASE: 'HCW' }],
    ['the creator desktop client', { ...env, CODE_BRAIN_SYNC_CLIENT_ID: 'creator-desktop' }],
  ])('refuses a workspace that is %s before the admin registry or any store is read', async (_name, settings) => {
    const { codeHandlers, code, registry } = setup({ settings });
    const spies = ['readDoc', 'queryDocs', 'queryDocsPage', 'upsertDoc', 'createDoc'].map((m) => vi.spyOn(code.store, m));
    for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS]) {
      const response = await codeHandlers[action](request({ item: note(), version: 0, mutationId: 'mutation-001' }, { id: 'note-1' }));
      expect(response.status, action).toBe(404);
    }
    expect(registry.lookupAdmin).not.toHaveBeenCalled();
    expect(registry.auditDenial).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Without a valid token the answer is still 401, so it does not reveal
    // whether the workspace exists.
    expect((await codeHandlers.status(request({}, {}, '', false))).status).toBe(401);
    expect(registry.lookupAdmin).not.toHaveBeenCalled();
  });

  it('records a refused token in the denial log, as the admin guard does', async () => {
    const { codeHandlers, registry } = setup({ user: { ...codeUser, scp: 'access_as_admin' } });
    expect((await codeHandlers.status(request())).status).toBe(401);
    expect(registry.auditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied', reason: 'missing-scope', required: CODE_SYNC_SCOPE }),
    );
  });

  it('exposes no creator reference, search, context, draft, AI or reindex action', () => {
    const { codeHandlers } = setup();
    expect(Object.keys(codeHandlers).sort()).toEqual(
      ['get', 'history', 'list', 'status', 'syncPull', 'syncPush', 'syncStatus'],
    );
  });

  it('reports its own workspace and desktop client, and no AI switch', async () => {
    const { codeHandlers } = setup();
    const status = json(await codeHandlers.status(request()));
    expect(status).toMatchObject({
      enabled: true,
      workspace: 'code-conductor',
      syncClientId: 'code-desktop',
      tenantId: 'tenant',
      protocol: 1,
    });
    expect(status).not.toHaveProperty('aiEnabled');
    expect(status).not.toHaveProperty('indexing');
  });
});

describe('cross-workspace isolation', () => {
  it('keeps a Code Conductor save out of the creator workspace, and the reverse', async () => {
    const { codeHandlers, creatorHandlers, code, creator } = setup();
    expect((await push(codeHandlers, note('code-note'), 0, 'code-mutation-1')).status).toBe(200);
    // Every record the code save wrote is in its own container; none reached the creator store.
    expect([...code.store.docs.keys()].every((k) => k.startsWith(`${CODE_RECORDS}/owner/`))).toBe(true);
    expect(creator.store.docs.size).toBe(0);

    // The same person's creator sync token cannot read the code workspace...
    const creatorSync = setup({ user: { ...codeUser, scp: 'brain_sync', azp: 'creator-desktop' } });
    expect((await creatorSync.codeHandlers.syncPull(request())).status).toBe(401);
    // ...and the code token cannot reach any creator route.
    for (const action of ['list', 'search', 'context', 'draft', 'syncPull', 'syncReferences']) {
      const response = await creatorHandlers[action](request({}, { id: 'code-note' }));
      expect(response.status, action).toBe(401);
    }
  });

  it('pulls only its own records even when the creator workspace holds the same ids', async () => {
    const { codeHandlers, creatorRepo, codeRepo } = setup();
    await creatorRepo.commit(note('shared-id', { title: 'Creator idea' }), { version: 0, mutationId: 'creator-mutation-1' });
    await codeRepo.commit(note('shared-id', { title: 'Engineering note' }), { version: 0, mutationId: 'code-mutation-01' });
    const pulled = json(await codeHandlers.syncPull(request()));
    expect(pulled.items.map((i) => i.title)).toEqual(['Engineering note']);
    const item = json(await codeHandlers.get(request({}, { id: 'shared-id' })));
    expect(item.item.title).toBe('Engineering note');
  });

  it('never returns another owner partition within its own database', async () => {
    const { code, codeHandlers } = setup();
    const otherRepo = createBrainRepository(code.store, 'someone-else', code.batch, { records: CODE_RECORDS, search: null });
    await otherRepo.commit(note('foreign'), { version: 0, mutationId: 'foreign-mutation' });
    expect(json(await codeHandlers.list(request())).items).toEqual([]);
    expect(json(await codeHandlers.syncPull(request())).items).toEqual([]);
    expect((await codeHandlers.get(request({}, { id: 'foreign' }))).status).toBe(404);
  });

  it('does not serve workspace metadata through the item routes', async () => {
    const { codeHandlers } = setup();
    await push(codeHandlers, note(), 0, 'mutation-001');
    for (const id of ['state', 'sync-status', 'revision_note-1_1', 'mutation_mutation-001']) {
      expect((await codeHandlers.get(request({}, { id }))).status, id).toBe(404);
    }
  });
});

describe('idempotence, conflicts and pagination', () => {
  it('replays the same mutation once and refuses a reused mutation id for different text', async () => {
    const { codeHandlers, codeRepo } = setup();
    const first = await push(codeHandlers, note(), 0, 'mutation-001');
    expect(first.status).toBe(200);
    expect(json(first)).toMatchObject({ item: { version: 1 }, protocol: 1 });
    const replay = await push(codeHandlers, note(), 0, 'mutation-001');
    expect(json(replay).item).toEqual(json(first).item);
    expect(await codeRepo.history('note-1')).toHaveLength(1);
    const reused = await push(codeHandlers, note('note-1', { body: 'Different' }), 0, 'mutation-001');
    expect(reused.status).toBe(409);
    expect((await codeRepo.changes(0)).items).toHaveLength(1);
  });

  it('answers a stale base version with 412 and the current record, writing nothing', async () => {
    const { codeHandlers, codeRepo } = setup();
    await push(codeHandlers, note(), 0, 'mutation-001');
    await push(codeHandlers, note('note-1', { body: 'Second' }), 1, 'mutation-002');
    const stale = await push(codeHandlers, note('note-1', { body: 'Offline edit' }), 1, 'mutation-003');
    expect(stale.status).toBe(412);
    expect(json(stale)).toMatchObject({ code: 'CONFLICT', current: { version: 2, body: 'Second' } });
    expect(json(stale).current).not.toHaveProperty('ownerId');
    expect((await codeRepo.read('note-1')).body).toBe('Second');
    expect(await codeRepo.history('note-1')).toHaveLength(2);
  });

  it('serializes concurrent first saves without losing a sync event', async () => {
    const { codeHandlers } = setup();
    const results = await Promise.all([
      push(codeHandlers, note('note-a'), 0, 'mutation-aaa'),
      push(codeHandlers, note('note-b'), 0, 'mutation-bbb'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const pulled = json(await codeHandlers.syncPull(request()));
    expect(pulled.cursor).toBe(2);
    expect(pulled.items.map((i) => i.id).sort()).toEqual(['note-a', 'note-b']);
  });

  it('refuses a save with no mutation id, a bad base version, or a missing collection', async () => {
    const { codeHandlers } = setup();
    expect((await push(codeHandlers, note(), 0, undefined)).status).toBe(400);
    expect((await push(codeHandlers, note(), -1, 'mutation-001')).status).toBe(400);
    expect((await push(codeHandlers, note('note-1', { collections: ['missing'] }), 0, 'mutation-001')).status).toBe(400);
    expect((await push(codeHandlers, { ...note(), type: 'content' }, 0, 'mutation-001')).status).toBe(400);
    expect((await push(codeHandlers, note('state'), 0, 'mutation-001')).status).toBe(400);
  });

  it('pages the record list, the sync cursor and the history safely', async () => {
    const { codeHandlers, codeRepo } = setup();
    for (let i = 0; i < 55; i++)
      await codeRepo.commit(note(`note-${String(i).padStart(2, '0')}`), { version: 0, mutationId: `mutation-${String(i).padStart(3, '0')}` });
    const page1 = json(await codeHandlers.list(request()));
    expect(page1.items).toHaveLength(50);
    expect(page1.items[0]).not.toHaveProperty('body');
    const page2 = json(await codeHandlers.list(request({}, {}, `after=${page1.after}`)));
    expect(page2.items).toHaveLength(5);
    expect(page2.after).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(55);
    // A malformed list cursor starts from the newest rather than failing.
    expect(json(await codeHandlers.list(request({}, {}, 'after=not-a-number'))).items).toHaveLength(50);

    const pull1 = json(await codeHandlers.syncPull(request()));
    expect(pull1).toMatchObject({ cursor: 50, hasMore: true });
    const pull2 = json(await codeHandlers.syncPull(request({}, {}, `cursor=${pull1.cursor}`)));
    expect(pull2).toMatchObject({ cursor: 55, hasMore: false });
    expect(pull2.items).toHaveLength(5);
    // An invalid cursor reads from the start instead of skipping changes.
    for (const cursor of ['-1', 'abc', '1e400', String(Number.MAX_SAFE_INTEGER + 2)])
      expect(json(await codeHandlers.syncPull(request({}, {}, `cursor=${cursor}`))).cursor, cursor).toBe(50);

    for (let v = 1; v <= 52; v++)
      await codeRepo.commit(note('note-00', { body: `Edit ${v}` }), { version: v, mutationId: `edit-mutation-${v}` });
    const history1 = json(await codeHandlers.history(request({}, { id: 'note-00' })));
    expect(history1.items).toHaveLength(50);
    const history2 = json(await codeHandlers.history(request({}, { id: 'note-00' }, `before=${history1.before}`)));
    expect(history2.items).toHaveLength(3);
    expect(history2.before).toBeNull();
    expect((await codeHandlers.history(request({}, { id: 'missing' }))).status).toBe(404);
  });

  it('records a checked desktop heartbeat and refuses a malformed one', async () => {
    const { codeHandlers, codeRepo } = setup();
    const ok = await codeHandlers.syncStatus(request({ pending: 2, conflicts: 0, error: 'none', lastSuccessfulSync: '2026-10-30T12:00:00Z' }));
    expect(json(ok)).toEqual({ ok: true, protocol: 1 });
    expect(await codeRepo.read('sync-status')).toMatchObject({ pending: 2, conflicts: 0, error: 'none' });
    expect((await codeHandlers.syncStatus(request({ pending: -1, conflicts: 0, error: 'none' }))).status).toBe(400);
    expect((await codeHandlers.syncStatus(request({ pending: 0, conflicts: 0, error: 'boom' }))).status).toBe(400);
  });

  it('hides an unexpected storage failure behind a generic private 500', async () => {
    const { codeHandlers, code } = setup();
    vi.spyOn(code.store, 'readDoc').mockRejectedValue(new Error('secret connection detail'));
    const response = await codeHandlers.status(request());
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('secret connection detail');
    expect(response.headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('Code Conductor brain store', () => {
  const fakeContainer = () => {
    const calls = [];
    const container = {
      item: (id, pk) => ({
        read: async () => {
          calls.push(['read', id, pk]);
          if (id === 'missing') throw Object.assign(new Error('nf'), { code: 404 });
          return { resource: { id } };
        },
      }),
      items: {
        query: (spec, options) => ({
          fetchAll: async () => (calls.push(['query', options]), { resources: [] }),
          fetchNext: async () => (calls.push(['page', options]), { resources: [], hasMoreResults: false }),
        }),
        upsert: async (doc) => (calls.push(['upsert', doc.id]), { resource: doc }),
        create: async (doc) => (calls.push(['create', doc.id]), { resource: doc }),
        batch: async (ops, pk) => (calls.push(['batch', pk]), { code: 200, result: [] }),
      },
    };
    return { calls, container };
  };

  it('reaches only code_brain_records in the configured database', async () => {
    const { container } = fakeContainer();
    const getContainer = vi.fn(() => container);
    const store = createCodeBrainStore({ database: 'hcw_code_brain', getContainer });
    await store.readDoc(CODE_RECORDS, 'x', 'owner');
    expect(getContainer).toHaveBeenCalledWith('hcw_code_brain', CODE_RECORDS);
    for (const name of ['brain_records', 'admins', 'content'])
      await expect(store.readDoc(name, 'x', 'owner')).rejects.toThrow(/stores only code_brain_records/);
    const unconfigured = createCodeBrainStore({ database: '', getContainer });
    await expect(unconfigured.readDoc(CODE_RECORDS, 'x', 'owner')).rejects.toThrow(/no database configured/);
  });

  it('requires an owner partition on every read, query and write', async () => {
    const { container, calls } = fakeContainer();
    const store = createCodeBrainStore({ database: 'hcw_code_brain', getContainer: () => container });
    await expect(store.readDoc(CODE_RECORDS, 'x')).rejects.toThrow(/owner partition/);
    await expect(store.queryDocs(CODE_RECORDS, 'SELECT * FROM c', [])).rejects.toThrow(/owner partition/);
    await expect(store.upsertDoc(CODE_RECORDS, { id: 'x' })).rejects.toThrow(/owner partition/);
    await expect(store.createDoc(CODE_RECORDS, { id: 'x' })).rejects.toThrow(/owner partition/);
    expect(await store.readDoc(CODE_RECORDS, 'missing', 'owner')).toBeNull();
    await store.queryDocs(CODE_RECORDS, 'SELECT * FROM c', [], { partitionKey: 'owner', maxItemCount: 5 });
    await store.batch('owner', []);
    expect(calls).toContainEqual(['query', { partitionKey: 'owner', maxItemCount: 5 }]);
    expect(calls).toContainEqual(['batch', 'owner']);
  });
});
