/**
 * The Code Conductor brain's production wiring (#1457): the routes as the
 * Functions host registers them, with only the Cosmos client and the token
 * guard replaced. Every Cosmos call a save and a pull make must land on
 * hcw_code_brain / code_brain_records, and nothing may reach the creator
 * database through cosmos-client's getContainer. The lib tests build the
 * repository themselves, so without this file a wiring change that fell back
 * to the creator brain's containers would pass every other test.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const registrations = vi.hoisted(() => new Map());
const cosmos = vi.hoisted(() => ({ database: [], main: [], batches: [], docs: new Map() }));

vi.mock('@azure/functions', () => ({
  app: { http: (name, options) => registrations.set(name, options) },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));

/** An in-memory container that records the database and container it was asked for. */
function fakeContainer(database, name) {
  const key = (id, pk) => `${database}/${name}/${pk}/${id}`;
  return {
    item: (id, pk) => ({
      read: async () => {
        const resource = cosmos.docs.get(key(id, pk));
        if (!resource) throw Object.assign(new Error('not found'), { code: 404 });
        return { resource };
      },
    }),
    items: {
      query: ({ query, parameters }, options) => ({
        fetchAll: async () => {
          const after = parameters.find((p) => p.name === '@after')?.value ?? 0;
          const resources = [...cosmos.docs.entries()]
            .filter(([k]) => k.startsWith(`${database}/${name}/${options.partitionKey}/`))
            .map(([, v]) => v)
            .filter((d) => query.includes('"event"') && d.type === 'event' && d.seq > after)
            .sort((a, b) => a.seq - b.seq);
          return { resources };
        },
      }),
      upsert: async (doc) => {
        cosmos.docs.set(key(doc.id, doc.ownerId), { ...doc, _etag: 'e' });
        return { resource: doc };
      },
      batch: async (operations, pk) => {
        cosmos.batches.push([database, name, pk]);
        for (const op of operations)
          cosmos.docs.set(key(op.resourceBody.id, pk), { ...op.resourceBody, _etag: 'e' });
        return { code: 200, result: operations.map(() => ({ statusCode: 201 })) };
      },
    },
  };
}

vi.mock('../lib/cosmos-client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDatabaseContainer: (database, name) => {
    cosmos.database.push([database, name]);
    return fakeContainer(database, name);
  },
  getContainer: (name) => {
    cosmos.main.push(name);
    return fakeContainer('hcw', name);
  },
  readDoc: async (name) => {
    cosmos.main.push(name);
    return null;
  },
  upsertDoc: async (name) => {
    cosmos.main.push(name);
  },
}));

const owner = { oid: 'owner-oid', tid: 'tenant-id', azp: 'code-desktop', scp: 'code_brain_sync', roles: ['Admin'] };
vi.mock('../lib/code-brain/guard.js', () => ({
  getCodeBrainSyncGuard: () => ({
    requireUser: async () => ({ user: owner, role: null, error: null }),
    requireRole: async () => ({ user: owner, role: 'editor', error: null }),
  }),
}));

const request = (method, body, query = '') => ({
  method,
  params: {},
  query: new URLSearchParams(query),
  headers: { get: () => null },
  json: async () => body,
  url: `https://hcw.invalid/api/cms/code-brain/sync?${query}`,
});
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const call = (method, body, query) => registrations.get('cmsCodeBrainSync').handler(request(method, body, query), context);

beforeAll(async () => {
  vi.stubEnv('COSMOS_DATABASE', 'hcw');
  vi.stubEnv('CODE_BRAIN_ENABLED', 'true');
  vi.stubEnv('CODE_BRAIN_OWNER_OID', 'owner-oid');
  vi.stubEnv('CODE_BRAIN_OWNER_TENANT_ID', 'tenant-id');
  vi.stubEnv('CODE_BRAIN_SYNC_CLIENT_ID', 'code-desktop');
  vi.stubEnv('CODE_BRAIN_COSMOS_DATABASE', 'hcw_code_brain');
  vi.stubEnv('BRAIN_SYNC_CLIENT_ID', 'creator-desktop');
  await import('./code-brain-http.js');
});

beforeEach(() => {
  cosmos.database.length = 0;
  cosmos.main.length = 0;
  cosmos.batches.length = 0;
});

describe('code-brain-http.js wiring', () => {
  it('registers the six routes under cms/code-brain/ and nothing else', () => {
    expect([...registrations.values()].map((o) => o.route).sort()).toEqual([
      'cms/code-brain/history/{id}',
      'cms/code-brain/items',
      'cms/code-brain/items/{id}',
      'cms/code-brain/status',
      'cms/code-brain/sync',
      'cms/code-brain/sync-status',
    ]);
  });

  it('saves and pulls through hcw_code_brain / code_brain_records only', async () => {
    const item = {
      id: 'wiring-note',
      type: 'note',
      title: 'Wiring',
      body: 'Synthetic.',
      tags: [],
      links: [],
      collections: [],
      urls: [],
    };
    const saved = await call('POST', { item, version: 0, mutationId: 'wiring-mutation-1' });
    expect(saved.status, saved.body).toBe(200);
    expect(JSON.parse(saved.body).item).toMatchObject({ id: 'wiring-note', version: 1 });

    const pulled = await call('GET', undefined, 'cursor=0');
    expect(pulled.status, pulled.body).toBe(200);
    expect(JSON.parse(pulled.body).items.map((i) => i.id)).toEqual(['wiring-note']);

    expect(cosmos.database.length).toBeGreaterThan(0);
    for (const target of cosmos.database) expect(target).toEqual(['hcw_code_brain', 'code_brain_records']);
    expect(cosmos.batches).toEqual([['hcw_code_brain', 'code_brain_records', 'owner-oid']]);
    // Nothing reached the creator database: no getContainer, readDoc or upsertDoc.
    expect(cosmos.main).toEqual([]);
  });
});
