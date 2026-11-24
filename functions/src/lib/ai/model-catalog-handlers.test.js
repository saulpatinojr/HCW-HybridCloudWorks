/**
 * The model catalogue routes (ADR 0034 slice 2, #857): editor-gated, the
 * read seeds before the first refresh, the hide accepts a URL-encoded id
 * with a slash in it, the refresh runs the injected refresher and answers
 * its summary, and every write drops the router's cache.
 */
import { describe, it, expect, vi } from 'vitest';
import { createModelCatalogHandlers, decodeModelParam } from './model-catalog-handlers.js';
import { CATALOG_DOC_ID } from './model-catalog.js';

const context = { log: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-10-05T12:00:00.000Z');

const allowGuard = {
  requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, role: 'editor', error: null })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};

const makeRequest = ({ params = {}, body } = {}) => ({
  query: { get: () => null },
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

const parse = (res) => JSON.parse(res.body);

function makeStore(doc = null) {
  return {
    readDoc: vi.fn(async () => (doc ? structuredClone({ _etag: 'etag-1', ...doc }) : null)),
    upsertDoc: vi.fn(async (_c, d) => d),
    replaceDocIfMatch: vi.fn(async (_c, d) => d),
  };
}

const storedDoc = {
  id: CATALOG_DOC_ID,
  providers: {
    nvidia: {
      refresh: { lastOk: NOW.toISOString(), lastAttempt: NOW.toISOString(), lastError: null },
      models: {
        'z-ai/glm-5.3': {
          id: 'z-ai/glm-5.3',
          status: 'live',
          missed: 0,
          firstSeen: NOW.toISOString(),
          lastSeen: NOW.toISOString(),
          hidden: false,
        },
      },
    },
  },
};

const build = ({ guard = allowGuard, store = makeStore(), refresh = vi.fn(), aiConfigChanged = vi.fn() } = {}) => ({
  h: createModelCatalogHandlers({ guard, store, refresh, aiConfigChanged, now: () => NOW }),
  store,
  refresh,
  aiConfigChanged,
});

describe('auth', () => {
  it('every handler passes a guard denial through with no store call', async () => {
    const { h, store, refresh } = build({ guard: denyGuard });
    const calls = [
      h.getModelCatalog(makeRequest(), context),
      h.patchModelCatalogModel(
        makeRequest({ params: { provider: 'nvidia', model: 'x' }, body: { hidden: true } }),
        context
      ),
      h.refreshModelCatalog(makeRequest(), context),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('GET cms/ai-model-catalog', () => {
  it('answers the catalogue with every provider, seeded where nothing is stored', async () => {
    const { h } = build();
    const res = await h.getModelCatalog(makeRequest(), context);
    expect(res.status).toBe(200);
    const { catalog } = parse(res);
    expect(catalog.id).toBe(CATALOG_DOC_ID);
    expect(catalog.providers.foundry).toMatchObject({ seeded: true, stale: true });
    expect(Object.keys(catalog.providers.foundry.models)).toEqual(['gpt-5-mini', 'gpt-5-nano']);
  });

  it('a store that cannot be read is a 500 with a plain sentence', async () => {
    const store = makeStore();
    store.readDoc.mockRejectedValueOnce(new Error('cosmos down'));
    const { h } = build({ store });
    const res = await h.getModelCatalog(makeRequest(), context);
    expect(res.status).toBe(500);
    expect(parse(res)).toEqual({ error: 'Failed to read the model catalogue' });
  });
});

describe('PATCH cms/ai-model-catalog/{provider}/{model}', () => {
  it('hides a model whose id arrives URL-encoded, writes on the ETag, drops the router cache, answers the entry', async () => {
    const { h, store, aiConfigChanged } = build({ store: makeStore(storedDoc) });
    const res = await h.patchModelCatalogModel(
      makeRequest({ params: { provider: 'nvidia', model: 'z-ai%2Fglm-5.3' }, body: { hidden: true } }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({ success: true, provider: 'nvidia', model: { id: 'z-ai/glm-5.3', hidden: true } });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    const [, writtenDoc, options] = store.replaceDocIfMatch.mock.calls[0];
    expect(writtenDoc._etag).toBe('etag-1');
    expect(writtenDoc.providers.nvidia.models['z-ai/glm-5.3'].hidden).toBe(true);
    expect(options).toEqual({ partitionKey: CATALOG_DOC_ID });
    expect(aiConfigChanged).toHaveBeenCalledTimes(1);
  });

  it('a write that keeps conflicting is a 500, and the cache is left alone', async () => {
    const store = makeStore(storedDoc);
    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('precondition'), { code: 412 }));
    const { h, aiConfigChanged } = build({ store });
    const res = await h.patchModelCatalogModel(
      makeRequest({ params: { provider: 'nvidia', model: 'z-ai%2Fglm-5.3' }, body: { hidden: true } }),
      context
    );
    expect(res.status).toBe(500);
    expect(aiConfigChanged).not.toHaveBeenCalled();
  });

  it('accepts the same id already decoded by the host', async () => {
    const { h } = build({ store: makeStore(storedDoc) });
    const res = await h.patchModelCatalogModel(
      makeRequest({ params: { provider: 'nvidia', model: 'z-ai/glm-5.3' }, body: { hidden: false } }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res).model.hidden).toBe(false);
  });

  it('refuses an unknown provider, a bad id, a non-boolean body, and names a model it has not got', async () => {
    const { h, store, aiConfigChanged } = build({ store: makeStore(storedDoc) });
    const patch = (params, body) => h.patchModelCatalogModel(makeRequest({ params, body }), context);

    expect((await patch({ provider: 'vertex', model: 'x' }, { hidden: true })).status).toBe(400);
    expect((await patch({ provider: 'nvidia', model: '%E0%A4%A' }, { hidden: true })).status).toBe(400);
    expect((await patch({ provider: 'nvidia', model: '' }, { hidden: true })).status).toBe(400);
    expect((await patch({ provider: 'nvidia', model: 'z-ai%2Fglm-5.3' }, { hidden: 'yes' })).status).toBe(400);
    expect((await patch({ provider: 'nvidia', model: 'z-ai%2Fglm-5.3' })).status).toBe(400);
    const missing = await patch({ provider: 'nvidia', model: 'nobody%2Fsuch' }, { hidden: true });
    expect(missing.status).toBe(404);
    expect(parse(missing).error).toContain('nobody/such');

    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(aiConfigChanged).not.toHaveBeenCalled();
  });

  it('decodeModelParam keeps a plain id, decodes an escaped one, refuses a broken escape', () => {
    expect(decodeModelParam('gpt-5-nano')).toEqual({ model: 'gpt-5-nano' });
    expect(decodeModelParam('z-ai%2Fglm-5.3')).toEqual({ model: 'z-ai/glm-5.3' });
    expect(decodeModelParam('%E0%A4%A')).toEqual({ error: 'model is not a valid URL-encoded id' });
    expect(decodeModelParam(undefined)).toEqual({ error: 'model required' });
  });
});

describe('POST cms/ai-model-catalog/refresh', () => {
  it('runs the refresher, drops the router cache, and answers its summary', async () => {
    const summary = { updatedAt: NOW.toISOString(), providers: { foundry: { listed: 2, added: 0, retired: 0, error: null } } };
    const { h, refresh, aiConfigChanged } = build({ refresh: vi.fn(async () => summary) });
    const res = await h.refreshModelCatalog(makeRequest(), context);
    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({ success: true, summary });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(aiConfigChanged).toHaveBeenCalledTimes(1);
  });

  it('a refresher that throws is a 500, and the cache is left alone', async () => {
    const { h, aiConfigChanged } = build({ refresh: vi.fn(async () => { throw new Error('cosmos down'); }) });
    const res = await h.refreshModelCatalog(makeRequest(), context);
    expect(res.status).toBe(500);
    expect(parse(res)).toEqual({ error: 'Failed to refresh the model catalogue' });
    expect(aiConfigChanged).not.toHaveBeenCalled();
    expect(context.error).toHaveBeenCalledWith('refreshModelCatalog failed:', expect.stringMatching(/^name=Error\b/));
  });
});
