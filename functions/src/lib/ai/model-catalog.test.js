/**
 * The model catalogue (ADR 0034 slice 2, #857): what the adapters read from
 * each list endpoint, the enrichment contract (every model priced or badged
 * unpriced, every capability from the registry's vocabulary), the retire
 * rule (two consecutive successful lists without a model), the
 * failed-refresh rule (no model changes, byte for byte; only `lastAttempt`
 * and `lastError` move), the ETag-conditioned write (a Hide and a refresh
 * landing together both survive), and the read rule (`stale` from `lastOk`,
 * the router's defaults seeded until the first successful list).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CATALOG_DOC_ID,
  CatalogListError,
  ENRICHMENT_TABLE,
  RETIRE_AFTER_MISSED,
  STALE_AFTER_MS,
  WRITE_ATTEMPTS,
  createListContext,
  enrichModel,
  listModels,
  readModelCatalog,
  refreshModelCatalog,
  seedModelsFor,
  setModelHidden,
  visibleModelsFor,
} from './model-catalog.js';
import { COST_TABLE, DEFAULT_MODEL_TABLE, PROVIDERS, isPriced } from './router.js';
import { KNOWN_PROVIDERS } from './provider-order.js';
import { CAPABILITIES, MODALITIES } from './tasks.js';
import { RECOMMENDED_BY_MODALITY } from './provider-recommendations.js';

const T0 = new Date('2026-10-05T06:15:00.000Z');
const T1 = new Date('2026-10-12T06:15:00.000Z');
const T2 = new Date('2026-10-19T06:15:00.000Z');

const ENV = {
  OPENAI_API_KEY: 'sk-openai',
  GEMINI_API_KEY: 'g-key',
  ANTHROPIC_API_KEY: 'sk-ant',
  NVIDIA_API_KEY: 'nvapi-key',
  FOUNDRY_ENDPOINT: 'https://hcw.services.ai.azure.com/',
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * A store whose document is `doc` (with the `_etag` Cosmos would return),
 * recording every write in order. `replaceDocIfMatch` is what a stored
 * document gets; `upsertDoc` only ever creates the first one.
 */
function makeStore(doc = null) {
  const writes = [];
  const store = {
    writes,
    readDoc: vi.fn(async () => (doc ? structuredClone({ _etag: 'etag-1', ...doc }) : null)),
    upsertDoc: vi.fn(async (_c, d) => {
      writes.push(d);
      return d;
    }),
    replaceDocIfMatch: vi.fn(async (_c, d) => {
      writes.push(d);
      return d;
    }),
  };
  return store;
}

const written = (store) => store.writes.at(-1);
const conflict = () => Object.assign(new Error('precondition failed'), { code: 412 });

const refreshed = (lastOk) => ({ lastOk, lastAttempt: lastOk, lastError: null });
const liveModel = (id, at, over = {}) => ({
  id,
  status: 'live',
  missed: 0,
  firstSeen: at,
  lastSeen: at,
  hidden: false,
  ...over,
});

describe('enrichment', () => {
  it('every table row stays inside the registry vocabulary', () => {
    for (const row of ENRICHMENT_TABLE) {
      for (const cap of row.capabilities) expect(CAPABILITIES).toContain(cap);
      if (row.modality !== null) expect(MODALITIES).toContain(row.modality);
      expect(row.context === null || Number.isInteger(row.context)).toBe(true);
    }
  });

  it('prices from the cost table and badges the rest unpriced, never a default row', () => {
    expect(enrichModel('foundry', 'gpt-5-nano')).toMatchObject({
      capabilities: ['text', 'json', 'vision'],
      modality: 'text',
      context: 400_000,
      pricing: { inputPer1M: 0.05, outputPer1M: 0.4 },
      unpriced: false,
    });
    // The cost table has a `default` row for openai; it must not price an unknown id.
    expect(enrichModel('openai', 'gpt-5.5-ultra')).toMatchObject({ pricing: null, unpriced: true });
    // A model with no pattern is text only and unpriced (ADR 0034 §2).
    expect(enrichModel('openai', 'babbage-002')).toEqual({
      capabilities: ['text'],
      modality: 'text',
      context: null,
      pricing: null,
      unpriced: true,
    });
  });

  it('a model the cost table deliberately leaves at null is unpriced', () => {
    const nullRow = Object.entries(COST_TABLE).flatMap(([provider, rates]) =>
      Object.entries(rates)
        .filter(([, rate]) => rate === null)
        .map(([id]) => [provider, id])
    );
    for (const [provider, id] of nullRow) {
      expect(isPriced(provider, id)).toBe(false);
      expect(enrichModel(provider, id).unpriced).toBe(true);
    }
  });

  it('speech and image ids carry their own capability, never text (ADR 0034 slice 5, #860)', () => {
    for (const id of ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview', 'gpt-4o-mini-tts']) {
      expect(enrichModel('gemini', id), id).toMatchObject({ capabilities: ['tts'], modality: 'tts' });
    }
    expect(enrichModel('elevenlabs', 'eleven_v3')).toMatchObject({ capabilities: ['tts'], modality: 'tts' });
    for (const id of ['google/imagen-4-fast', 'imagen-4.0-generate-001', 'dall-e-3']) {
      expect(enrichModel('replicate', id), id).toMatchObject({ capabilities: ['image'], modality: 'image' });
    }
    expect(enrichModel('replicate', 'google/imagen-4-fast').pricing).toEqual({ perUnitUsd: 0.02, unit: 'image' });
    expect(enrichModel('elevenlabs', 'eleven_v3').pricing).toEqual({ inputPer1M: 0, outputPer1M: 100, unit: '1M characters' });
  });

  it('audio-in, transcription and embedding ids carry no capability yet', () => {
    for (const id of [
      'gpt-4o-realtime-preview',
      'gpt-4o-transcribe',
      'whisper-1',
      'text-embedding-3-small',
      'gemini-embedding-001',
    ]) {
      expect(enrichModel('openai', id).capabilities, id).toEqual([]);
    }
  });

  it('every model the router defaults to, and every recommendation, is priced', () => {
    for (const provider of PROVIDERS) {
      for (const id of seedModelsFor(provider)) {
        expect(enrichModel(provider, id).unpriced, `${provider}/${id}`).toBe(false);
      }
      for (const { model } of Object.values(RECOMMENDED_BY_MODALITY[provider] || {})) {
        expect(enrichModel(provider, model).unpriced, `${provider}/${model}`).toBe(false);
      }
    }
  });

  it('seedModelsFor is the unique models of the router table, in table order', () => {
    expect(seedModelsFor('foundry')).toEqual(['gpt-5-mini', 'gpt-5-nano']);
    expect(seedModelsFor('nvidia')).toEqual([
      ...new Set(Object.values(DEFAULT_MODEL_TABLE.nvidia).map(([, m]) => m)),
    ]);
    expect(seedModelsFor('vertex')).toEqual([]);
  });
});

describe('listModels', () => {
  const ctxWith = (fetchImpl, env = ENV) =>
    createListContext({ env, fetchImpl, foundryToken: async () => 'tok' });

  it('OpenAI and NVIDIA: GET /models with the bearer key, data[].id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: [{ id: 'gpt-5-mini' }, { id: 'gpt-5-mini' }, { id: 'whisper-1' }] })
    );
    const ctx = ctxWith(fetchImpl);
    expect(await listModels(ctx, 'openai')).toEqual(['gpt-5-mini', 'whisper-1']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer sk-openai' } })
    );
    await listModels(ctx, 'nvidia');
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://integrate.api.nvidia.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer nvapi-key' } })
    );
  });

  it('Anthropic: x-api-key and the version header, following has_more / last_id', async () => {
    const pages = [
      { data: [{ id: 'claude-sonnet-4-6' }], has_more: true, last_id: 'claude-sonnet-4-6' },
      { data: [{ id: 'claude-haiku-4-5' }], has_more: false, last_id: 'claude-haiku-4-5' },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(200, pages.shift()));
    expect(await listModels(ctxWith(fetchImpl), 'anthropic')).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-sonnet-4-6'
    );
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('Gemini: x-goog-api-key, generateContent models only, models/ stripped, pages followed', async () => {
    const pages = [
      {
        models: [
          { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'p2',
      },
      {
        models: [
          {
            name: 'models/gemini-3.5-flash-lite',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(200, pages.shift()));
    expect(await listModels(ctxWith(fetchImpl), 'gemini')).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=p2'
    );
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'x-goog-api-key': 'g-key' });
  });

  it('Foundry: the endpoint without its trailing slash, the app identity bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [{ id: 'gpt-5-nano' }] }));
    const foundryToken = vi.fn(async () => 'entra-token');
    const ctx = createListContext({ env: ENV, fetchImpl, foundryToken });
    expect(await listModels(ctx, 'foundry')).toEqual(['gpt-5-nano']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hcw.services.ai.azure.com/openai/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer entra-token' } })
    );
    expect(foundryToken).toHaveBeenCalledTimes(1);
  });

  it('a provider with no key is skipped (null), never fetched', async () => {
    const fetchImpl = vi.fn();
    const ctx = ctxWith(fetchImpl, {});
    for (const provider of PROVIDERS) expect(await listModels(ctx, provider)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(listModels(ctx, 'vertex')).rejects.toThrow('Unknown AI provider: vertex');
  });

  it('a refused or malformed answer throws with the status, never the key or the body (#945)', async () => {
    const ctx = (body, status = 401) => ctxWith(vi.fn(async () => jsonResponse(status, body)));
    const refused = listModels(ctx({ error: { message: 'Incorrect API key provided' } }), 'openai');
    await expect(refused).rejects.toThrow(/^HTTP 401$/);
    await expect(refused).rejects.toBeInstanceOf(CatalogListError);
    await expect(listModels(ctx('<html>bad gateway</html>', 502), 'nvidia')).rejects.toThrow(/^HTTP 502$/);
    await expect(listModels(ctx('not json', 200), 'openai')).rejects.toThrow(
      'List answer was not JSON'
    );
    try {
      await listModels(ctx({ error: { message: 'nope' } }), 'openai');
    } catch (error) {
      expect(error.message).not.toContain('sk-openai');
    }
  });

  it('a 200 without the provider’s collection is a malformed list, not an empty one', async () => {
    // `{}` read as "no models" would retire every stored model two lists
    // later; each adapter refuses the shape it does not recognise.
    const empty = () => ctxWith(vi.fn(async () => jsonResponse(200, {})));
    for (const provider of ['openai', 'nvidia', 'foundry', 'anthropic']) {
      await expect(listModels(empty(), provider), provider).rejects.toThrow(
        'Malformed list: no "data" array'
      );
    }
    await expect(listModels(empty(), 'gemini')).rejects.toThrow('Malformed list: no "models" array');
    const wrongType = ctxWith(vi.fn(async () => jsonResponse(200, { data: { id: 'x' } })));
    await expect(listModels(wrongType, 'openai')).rejects.toThrow('Malformed list');
    // An empty collection is still an empty list.
    expect(await listModels(ctxWith(vi.fn(async () => jsonResponse(200, { data: [] }))), 'openai')).toEqual([]);
  });
});

describe('refreshModelCatalog', () => {
  const lists = (byProvider) => async (provider) => {
    const answer = byProvider[provider];
    if (answer instanceof Error) throw answer;
    return answer === undefined ? null : answer;
  };

  it('creates a first document with an upsert: every listed model live, firstSeen and lastSeen now, enriched', async () => {
    const store = makeStore();
    const summary = await refreshModelCatalog({
      store,
      now: () => T0,
      providers: ['foundry', 'nvidia'],
      listModels: lists({ foundry: ['gpt-5-mini', 'gpt-5-nano'], nvidia: ['z-ai/glm-5.3'] }),
    });
    expect(store.readDoc).toHaveBeenCalledWith('admin_settings', CATALOG_DOC_ID, CATALOG_DOC_ID);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    const doc = written(store);
    expect(doc).toMatchObject({ id: CATALOG_DOC_ID, schemaVersion: 1, updatedAt: T0.toISOString() });
    expect(doc.providers.foundry.refresh).toEqual(refreshed(T0.toISOString()));
    expect(doc.providers.foundry.models['gpt-5-nano']).toEqual({
      id: 'gpt-5-nano',
      status: 'live',
      firstSeen: T0.toISOString(),
      lastSeen: T0.toISOString(),
      missed: 0,
      hidden: false,
      capabilities: ['text', 'json', 'vision'],
      modality: 'text',
      context: 400_000,
      pricing: { inputPer1M: 0.05, outputPer1M: 0.4 },
      unpriced: false,
    });
    // NVIDIA ids carry a slash and are keys like any other.
    expect(doc.providers.nvidia.models['z-ai/glm-5.3'].status).toBe('live');
    expect(summary).toEqual({
      updatedAt: T0.toISOString(),
      providers: {
        foundry: { listed: 2, added: 2, retired: 0, error: null },
        nvidia: { listed: 1, added: 1, retired: 0, error: null },
      },
    });
  });

  it('a stored document is replaced on its ETag, never upserted', async () => {
    const store = makeStore({ id: CATALOG_DOC_ID, providers: {} });
    await refreshModelCatalog({
      store,
      now: () => T0,
      providers: ['foundry'],
      listModels: lists({ foundry: ['gpt-5-mini'] }),
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      'admin_settings',
      expect.objectContaining({ id: CATALOG_DOC_ID, _etag: 'etag-1' }),
      { partitionKey: CATALOG_DOC_ID }
    );
  });

  it('retires a model only after two consecutive successful lists without it', async () => {
    const store = makeStore();
    const run = async (now, ids) => {
      store.readDoc.mockResolvedValueOnce(structuredClone({ _etag: 'e', ...written(store) }));
      return refreshModelCatalog({ store, now: () => now, providers: ['foundry'], listModels: lists({ foundry: ids }) });
    };
    await refreshModelCatalog({
      store,
      now: () => T0,
      providers: ['foundry'],
      listModels: lists({ foundry: ['gpt-5-mini', 'gpt-5-nano'] }),
    });

    const first = await run(T1, ['gpt-5-mini']);
    expect(first.providers.foundry).toEqual({ listed: 1, added: 0, retired: 0, error: null });
    expect(written(store).providers.foundry.models['gpt-5-nano']).toMatchObject({
      status: 'live',
      missed: 1,
      lastSeen: T0.toISOString(),
    });

    const second = await run(T2, ['gpt-5-mini']);
    expect(second.providers.foundry.retired).toBe(1);
    expect(written(store).providers.foundry.models['gpt-5-nano']).toMatchObject({
      status: 'retired',
      missed: RETIRE_AFTER_MISSED,
      lastSeen: T0.toISOString(),
    });
    expect(written(store).providers.foundry.models['gpt-5-mini']).toMatchObject({
      status: 'live',
      missed: 0,
      lastSeen: T2.toISOString(),
    });
  });

  it('a model seen again is live with missed back at zero, and a retired one returns the same way', async () => {
    const at = T0.toISOString();
    const store = makeStore({
      id: CATALOG_DOC_ID,
      providers: {
        foundry: {
          refresh: refreshed(at),
          models: {
            'gpt-5-nano': liveModel('gpt-5-nano', at, { status: 'retired', missed: 2, hidden: true }),
            'gpt-5-mini': liveModel('gpt-5-mini', at, { missed: 1 }),
          },
        },
      },
    });
    await refreshModelCatalog({
      store,
      now: () => T2,
      providers: ['foundry'],
      listModels: lists({ foundry: ['gpt-5-nano', 'gpt-5-mini'] }),
    });
    const models = written(store).providers.foundry.models;
    expect(models['gpt-5-nano']).toMatchObject({ status: 'live', missed: 0, lastSeen: T2.toISOString(), firstSeen: at });
    expect(models['gpt-5-mini']).toMatchObject({ status: 'live', missed: 0 });
    // The administrator's hide survives the refresh.
    expect(models['gpt-5-nano'].hidden).toBe(true);
  });

  it('a failed list changes no model and records only lastAttempt and lastError (ADR 0034 finding 3)', async () => {
    const at = T0.toISOString();
    // An obsolete pricing row and a field this code does not know: both
    // must come back exactly as stored, because nothing was listed.
    const storedModels = {
      'gpt-5-nano': {
        ...liveModel('gpt-5-nano', at, { missed: 1 }),
        pricing: { inputPer1M: 9, outputPer1M: 9 },
        unpriced: false,
        capabilities: ['text'],
        note: 'kept as is',
      },
    };
    const store = makeStore({
      id: CATALOG_DOC_ID,
      updatedAt: at,
      providers: { foundry: { refresh: refreshed(at), models: storedModels } },
    });
    const summary = await refreshModelCatalog({
      store,
      now: () => T1,
      providers: ['foundry', 'gemini'],
      listModels: lists({
        foundry: new CatalogListError('HTTP 401', { status: 401 }),
        gemini: ['gemini-3.6-flash'],
      }),
    });
    const foundry = written(store).providers.foundry;
    expect(foundry.refresh).toEqual({
      lastOk: at,
      lastAttempt: T1.toISOString(),
      lastError: 'HTTP 401',
    });
    expect(foundry.models).toEqual(storedModels);
    // The provider that listed still refreshed, enriched.
    const gemini = written(store).providers.gemini;
    expect(gemini.refresh.lastOk).toBe(T1.toISOString());
    expect(gemini.models['gemini-3.6-flash']).toMatchObject({ status: 'live', pricing: { inputPer1M: 1.5, outputPer1M: 7.5 } });
    expect(summary.providers).toEqual({
      foundry: { listed: 0, added: 0, retired: 0, error: 'HTTP 401' },
      gemini: { listed: 1, added: 1, retired: 0, error: null },
    });
  });

  it('a list failure the catalogue did not write is stored and answered by its code only (#945)', async () => {
    const store = makeStore(null);
    const summary = await refreshModelCatalog({
      store,
      now: () => T1,
      providers: ['foundry'],
      listModels: lists({ foundry: Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' }) }),
    });
    expect(summary.providers.foundry.error).toBe('The model list could not be read (ENOTFOUND).');
    expect(JSON.stringify(written(store))).not.toContain('getaddrinfo');
  });

  it('a 200 `{}` from any adapter is a failed refresh: lastError set, every model as stored', async () => {
    const at = T0.toISOString();
    const stored = {
      id: CATALOG_DOC_ID,
      providers: Object.fromEntries(
        PROVIDERS.map((p) => [p, { refresh: refreshed(at), models: { [`${p}-model`]: liveModel(`${p}-model`, at) } }])
      ),
    };
    const store = makeStore(stored);
    const ctx = createListContext({
      env: ENV,
      fetchImpl: vi.fn(async () => jsonResponse(200, {})),
      foundryToken: async () => 'tok',
    });
    const summary = await refreshModelCatalog({
      store,
      now: () => T1,
      providers: [...PROVIDERS],
      listModels: (provider) => listModels(ctx, provider),
    });
    for (const provider of PROVIDERS) {
      const entry = written(store).providers[provider];
      expect(entry.refresh.lastError, provider).toMatch(/^Malformed list/);
      expect(entry.refresh.lastOk, provider).toBe(at);
      expect(entry.models, provider).toEqual(stored.providers[provider].models);
      expect(summary.providers[provider].error, provider).toMatch(/^Malformed list/);
    }
  });

  it('a provider with no key is skipped: no entry, no attempt recorded', async () => {
    const store = makeStore();
    const summary = await refreshModelCatalog({
      store,
      now: () => T0,
      providers: ['openai', 'vertex'],
      listModels: lists({}),
    });
    expect(summary.providers).toEqual({ openai: { skipped: true } });
    expect(written(store).providers).toEqual({});
  });

  it('re-applies the enrichment to a listed provider’s stored models, so a new cost row reaches the document', async () => {
    const at = T0.toISOString();
    const store = makeStore({
      id: CATALOG_DOC_ID,
      providers: {
        openai: {
          refresh: refreshed(at),
          models: { 'gpt-5-mini': liveModel('gpt-5-mini', at, { pricing: null, unpriced: true }) },
        },
      },
    });
    await refreshModelCatalog({ store, now: () => T1, providers: ['openai'], listModels: lists({ openai: ['gpt-5-mini'] }) });
    expect(written(store).providers.openai.models['gpt-5-mini']).toMatchObject({
      pricing: { inputPer1M: 0.25, outputPer1M: 2.0 },
      unpriced: false,
    });
  });

  it('on an ETag conflict, re-reads and re-applies the listings, so a Hide that landed meanwhile survives', async () => {
    const at = T0.toISOString();
    const before = {
      id: CATALOG_DOC_ID,
      providers: { foundry: { refresh: refreshed(at), models: { 'gpt-5-nano': liveModel('gpt-5-nano', at) } } },
    };
    // What the Hide wrote while the lists were being fetched.
    const after = structuredClone(before);
    after.providers.foundry.models['gpt-5-nano'].hidden = true;
    const store = makeStore(before);
    store.readDoc
      .mockResolvedValueOnce({ _etag: 'etag-1', ...structuredClone(before) })
      .mockResolvedValueOnce({ _etag: 'etag-2', ...structuredClone(after) });
    store.replaceDocIfMatch.mockRejectedValueOnce(conflict());

    const summary = await refreshModelCatalog({
      store,
      now: () => T1,
      providers: ['foundry'],
      listModels: lists({ foundry: ['gpt-5-nano', 'gpt-5-mini'] }),
    });

    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.replaceDocIfMatch.mock.calls[1][1]._etag).toBe('etag-2');
    const models = written(store).providers.foundry.models;
    expect(models['gpt-5-nano']).toMatchObject({ hidden: true, status: 'live', lastSeen: T1.toISOString() });
    expect(models['gpt-5-mini']).toMatchObject({ status: 'live', firstSeen: T1.toISOString() });
    expect(summary.providers.foundry).toEqual({ listed: 2, added: 1, retired: 0, error: null });
  });

  it('gives up after WRITE_ATTEMPTS conflicts and throws the last one; any other write error throws at once', async () => {
    const store = makeStore({ id: CATALOG_DOC_ID, providers: {} });
    store.replaceDocIfMatch.mockRejectedValue(conflict());
    await expect(
      refreshModelCatalog({ store, now: () => T0, providers: ['foundry'], listModels: lists({ foundry: ['gpt-5-mini'] }) })
    ).rejects.toMatchObject({ code: 412 });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
    expect(store.readDoc).toHaveBeenCalledTimes(WRITE_ATTEMPTS);

    const down = makeStore({ id: CATALOG_DOC_ID, providers: {} });
    down.replaceDocIfMatch.mockRejectedValue(new Error('cosmos down'));
    await expect(
      refreshModelCatalog({ store: down, now: () => T0, providers: ['foundry'], listModels: lists({ foundry: ['gpt-5-mini'] }) })
    ).rejects.toThrow('cosmos down');
    expect(down.replaceDocIfMatch).toHaveBeenCalledTimes(1);
  });
});

describe('readModelCatalog', () => {
  it('seeds a provider with no entry from the router table, unknown and stale, without writing', async () => {
    const store = makeStore();
    const catalog = await readModelCatalog({ store, now: () => T0 });
    expect(Object.keys(catalog.providers)).toEqual([...KNOWN_PROVIDERS]);
    expect(catalog.providers.nvidia).toMatchObject({ stale: true, seeded: true });
    expect(catalog.providers.nvidia.refresh).toEqual({ lastOk: null, lastAttempt: null, lastError: null });
    expect(Object.keys(catalog.providers.nvidia.models)).toEqual(seedModelsFor('nvidia'));
    expect(catalog.providers.nvidia.models['z-ai/glm-5.3']).toMatchObject({
      status: 'unknown',
      firstSeen: null,
      lastSeen: null,
      hidden: false,
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('still seeds a provider whose first list failed: the defaults under the recorded error', async () => {
    const store = makeStore({
      id: CATALOG_DOC_ID,
      providers: {
        foundry: {
          refresh: { lastOk: null, lastAttempt: T0.toISOString(), lastError: 'HTTP 401: token audience' },
          models: {},
        },
      },
    });
    const { foundry } = (await readModelCatalog({ store, now: () => T1 })).providers;
    expect(foundry).toMatchObject({ seeded: true, stale: true });
    expect(foundry.refresh).toEqual({ lastOk: null, lastAttempt: T0.toISOString(), lastError: 'HTTP 401: token audience' });
    expect(Object.keys(foundry.models)).toEqual(seedModelsFor('foundry'));
    expect(foundry.models['gpt-5-mini'].status).toBe('unknown');
  });

  it('still seeds a provider where a default was hidden before the first refresh, keeping the hide', async () => {
    const store = makeStore({
      id: CATALOG_DOC_ID,
      providers: {
        foundry: {
          refresh: { lastOk: null, lastAttempt: null, lastError: null },
          models: { 'gpt-5-nano': { id: 'gpt-5-nano', status: 'unknown', missed: 0, firstSeen: null, lastSeen: null, hidden: true } },
        },
      },
    });
    const { foundry } = (await readModelCatalog({ store, now: () => T1 })).providers;
    expect(foundry.seeded).toBe(true);
    expect(Object.keys(foundry.models).sort()).toEqual(seedModelsFor('foundry').sort());
    expect(foundry.models['gpt-5-nano'].hidden).toBe(true);
    expect(foundry.models['gpt-5-mini'].hidden).toBe(false);
  });

  it('after a successful list the stored entry is the answer, not seeded', async () => {
    const at = T0.toISOString();
    const store = makeStore({
      id: CATALOG_DOC_ID,
      providers: { foundry: { refresh: refreshed(at), models: { 'gpt-5-nano': liveModel('gpt-5-nano', at) } } },
    });
    const { foundry } = (await readModelCatalog({ store, now: () => T1 })).providers;
    expect(foundry.seeded).toBe(false);
    expect(Object.keys(foundry.models)).toEqual(['gpt-5-nano']);
  });

  it('derives stale from lastOk at read time: fresh inside 8 days, stale after, stale when missing', async () => {
    const at = (lastOk) => ({
      id: CATALOG_DOC_ID,
      providers: {
        foundry: { refresh: { lastOk, lastAttempt: lastOk, lastError: null }, models: {} },
        gemini: { refresh: { lastOk: null, lastAttempt: T0.toISOString(), lastError: 'HTTP 500' }, models: {} },
      },
    });
    const fresh = await readModelCatalog({ store: makeStore(at(T0.toISOString())), now: () => T1 });
    expect(fresh.providers.foundry).toMatchObject({ stale: false, seeded: false });
    expect(fresh.providers.gemini).toMatchObject({ stale: true, seeded: true });
    const old = new Date(T1.getTime() - STALE_AFTER_MS - 1);
    const stale = await readModelCatalog({ store: makeStore(at(old.toISOString())), now: () => T1 });
    expect(stale.providers.foundry.stale).toBe(true);
  });
});

describe('setModelHidden', () => {
  const at = T0.toISOString();
  const nvidiaDoc = () => ({
    id: CATALOG_DOC_ID,
    providers: {
      nvidia: { refresh: refreshed(at), models: { 'z-ai/glm-5.3': liveModel('z-ai/glm-5.3', at) } },
      foundry: { refresh: refreshed(at), models: { 'gpt-5-nano': { ...liveModel('gpt-5-nano', at), note: 'kept' } } },
    },
  });

  it('sets hidden on a listed model and replaces the document on its ETag, touching nothing else', async () => {
    const store = makeStore(nvidiaDoc());
    const model = await setModelHidden({ store, now: () => T1 }, { provider: 'nvidia', model: 'z-ai/glm-5.3', hidden: true });
    expect(model).toMatchObject({ id: 'z-ai/glm-5.3', hidden: true, status: 'live', capabilities: ['text', 'json'] });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      'admin_settings',
      expect.objectContaining({ _etag: 'etag-1' }),
      { partitionKey: CATALOG_DOC_ID }
    );
    const doc = written(store);
    expect(doc.providers.nvidia.models['z-ai/glm-5.3']).toEqual({ ...liveModel('z-ai/glm-5.3', at), hidden: true });
    expect(doc.providers.foundry).toEqual(nvidiaDoc().providers.foundry);
    expect(doc.updatedAt).toBe(T1.toISOString());
  });

  it('materialises a router-default model before the first refresh, and refuses any other id', async () => {
    const store = makeStore();
    const model = await setModelHidden({ store, now: () => T0 }, { provider: 'foundry', model: 'gpt-5-nano', hidden: true });
    expect(model).toMatchObject({ status: 'unknown', hidden: true });
    expect(written(store).providers.foundry.refresh.lastOk).toBeNull();
    expect(await setModelHidden({ store, now: () => T0 }, { provider: 'foundry', model: 'gpt-9', hidden: true })).toBeNull();
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('on an ETag conflict, re-reads and re-applies the hide, so a refresh that landed meanwhile keeps its models', async () => {
    const before = nvidiaDoc();
    const after = nvidiaDoc();
    after.providers.nvidia.models['z-ai/glm-5.3-flash'] = liveModel('z-ai/glm-5.3-flash', T1.toISOString());
    const store = makeStore(before);
    store.readDoc
      .mockResolvedValueOnce({ _etag: 'etag-1', ...before })
      .mockResolvedValueOnce({ _etag: 'etag-2', ...after });
    store.replaceDocIfMatch.mockRejectedValueOnce(conflict());

    const model = await setModelHidden({ store, now: () => T2 }, { provider: 'nvidia', model: 'z-ai/glm-5.3', hidden: true });
    expect(model.hidden).toBe(true);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    const models = written(store).providers.nvidia.models;
    expect(models['z-ai/glm-5.3'].hidden).toBe(true);
    expect(models['z-ai/glm-5.3-flash']).toBeDefined();
  });
});

describe('visibleModelsFor', () => {
  it('offers live and unknown text models that are not hidden, live first then by id', () => {
    const text = ['text', 'json'];
    const catalog = {
      providers: {
        openai: {
          models: {
            'gpt-5-nano': { id: 'gpt-5-nano', status: 'live', hidden: false, capabilities: text },
            'gpt-4o': { id: 'gpt-4o', status: 'retired', hidden: false, capabilities: text },
            'gpt-5-mini': { id: 'gpt-5-mini', status: 'live', hidden: true, capabilities: text },
            'o3-mini': { id: 'o3-mini', status: 'unknown', hidden: false, capabilities: text },
            'gpt-4o-mini': { id: 'gpt-4o-mini', status: 'live', hidden: false, capabilities: text },
            // Listed by the provider, enriched with no text capability: in
            // the disclosure, never in a select.
            'whisper-1': { id: 'whisper-1', status: 'live', hidden: false, capabilities: [] },
            'gpt-4o-mini-tts': { id: 'gpt-4o-mini-tts', status: 'live', hidden: false },
          },
        },
      },
    };
    expect(visibleModelsFor(catalog, 'openai')).toEqual(['gpt-4o-mini', 'gpt-5-nano', 'o3-mini']);
    expect(visibleModelsFor(catalog, 'gemini')).toEqual([]);
    expect(visibleModelsFor(null, 'openai')).toEqual([]);
  });
});
