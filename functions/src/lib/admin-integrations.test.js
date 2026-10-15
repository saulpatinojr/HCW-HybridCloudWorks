/**
 * Admin integrations — semantics pinned to the browser call sites they
 * replace (RecordingsPage, SpeakingEventsPage, adminSettings.js,
 * imageGallery.js, aiEngine.js). The load-bearing assertions: oauthToken
 * never leaves the server on any mcp_servers read, settings saves merge
 * rather than replace, and the config collection segment is allowlisted.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAdminIntegrationHandlers, normaliseRecordedAt } from './admin-integrations.js';

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({
    user: { oid: 'u1' },
    role: 'editor',
    error: null,
  })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: '{}' },
  })),
};

const makeRequest = ({ query = {}, params = {}, body } = {}) => ({
  query: { get: (k) => query[k] ?? null },
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    deleteDoc: vi.fn(async () => {}),
    ...over,
  };
}

const fixed = {
  now: () => new Date('2026-08-06T12:00:00.000Z'),
  uuid: () => 'fixed-uuid',
};

describe('auth', () => {
  it('all handlers pass guard denials through with zero store calls', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: denyGuard,
      store,
      ...fixed,
    });
    const calls = [
      h.listRecordings(makeRequest(), context),
      h.createRecording(makeRequest({ body: { title: 't', transcript: 'x' } }), context),
      h.patchRecording(makeRequest({ params: { id: 'r1' }, body: { status: 'routed' } }), context),
      h.listSpeakerEvents(makeRequest(), context),
      h.getSettings(makeRequest(), context),
      h.putSettings(makeRequest({ body: { a: 1 } }), context),
      h.listImages(makeRequest(), context),
      h.listConfig(makeRequest({ params: { collection: 'ai-providers' } }), context),
      h.putConfig(
        makeRequest({
          params: { collection: 'ai-providers', id: 'v' },
          body: {},
        }),
        context
      ),
      h.patchConfig(
        makeRequest({
          params: { collection: 'mcp-servers', id: 'v' },
          body: { a: 1 },
        }),
        context
      ),
      h.deleteConfig(makeRequest({ params: { collection: 'mcp-servers', id: 'v' } }), context),
      h.listUsage(makeRequest(), context),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.deleteDoc).not.toHaveBeenCalled();
  });
});

describe('recordings', () => {
  it('create requires title and transcript, stamps id/createdAt/status', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });

    expect((await h.createRecording(makeRequest({ body: { title: 'T' } }), context)).status).toBe(
      400
    );

    await h.createRecording(makeRequest({ body: { title: 'T', transcript: 'Tx' } }), context);
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc).toMatchObject({
      id: 'fixed-uuid',
      status: 'new',
      createdAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it('lists newest first and patch is partial with a 404 on missing', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [
        { id: 'old', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'new', createdAt: '2026-05-01T00:00:00Z' },
      ]),
      readDoc: vi.fn(async () => ({ id: 'r1', status: 'new' })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.listRecordings(makeRequest(), context);
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['new', 'old']);

    await h.patchRecording(
      makeRequest({
        params: { id: 'r1' },
        body: { status: 'routed', contentId: 'c9' },
      }),
      context
    );
    expect(store.patchDoc).toHaveBeenCalledWith('recordings', 'r1', {
      status: 'routed',
      contentId: 'c9',
    });

    const h404 = createAdminIntegrationHandlers({
      guard: allowGuard,
      store: makeStore(),
      ...fixed,
    });
    expect(
      (await h404.patchRecording(makeRequest({ params: { id: 'x' }, body: { a: 1 } }), context))
        .status
    ).toBe(404);
  });
});

describe('settings', () => {
  it('GET returns {} when the doc is missing', async () => {
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store: makeStore(),
      ...fixed,
    });
    const res = await h.getSettings(makeRequest(), context);
    expect(JSON.parse(res.body).settings).toEqual({});
  });

  it('PUT merges into an existing doc (patch, never replace)', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'integrations',
        sessionizeSpeakerId: 'abc',
        other: 'kept',
      })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putSettings(makeRequest({ body: { sessionizeSpeakerId: 'xyz' } }), context);
    // The settings document is patched, never replaced; the one upsert is the
    // Change history row (ADR 0033), tested below.
    expect(store.upsertDoc).not.toHaveBeenCalledWith('admin_settings', expect.anything());
    expect(store.patchDoc).toHaveBeenCalledWith('admin_settings', 'integrations', {
      sessionizeSpeakerId: 'xyz',
      updatedAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it('PUT creates the doc when absent', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putSettings(makeRequest({ body: { sessionizeSpeakerId: 'xyz' } }), context);
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      id: 'integrations',
      sessionizeSpeakerId: 'xyz',
    });
  });

  it('PUT of the speaker id writes a platform_setting_updated row, and only then (ADR 0033)', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'integrations',
        sessionizeSpeakerId: 'abc',
      })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putSettings(makeRequest({ body: { sessionizeSpeakerId: 'xyz' } }), context);
    const audit = store.upsertDoc.mock.calls.find(
      ([container]) => container === 'admin_audit_logs'
    );
    expect(audit[1]).toMatchObject({
      id: 'fixed-uuid',
      action: 'platform_setting_updated',
      userId: 'u1',
      timestamp: '2026-08-06T12:00:00.000Z',
      details: {
        setting: 'integrations',
        sessionizeSpeakerId: 'xyz',
        changed: true,
      },
    });

    store.upsertDoc.mockClear();
    await h.putSettings(makeRequest({ body: { other: 'field' } }), context);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PUT still answers 200 when the audit row fails, because the save already took', async () => {
    const warn = vi.fn();
    const store = makeStore({
      readDoc: vi.fn(async () => null),
      upsertDoc: vi.fn(async (container, doc) => {
        if (container === 'admin_audit_logs') throw new Error('audit down');
        return doc;
      }),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.putSettings(makeRequest({ body: { sessionizeSpeakerId: 'xyz' } }), {
      ...context,
      warn,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/audit row failed/));
  });
});

describe('images', () => {
  it('returns both galleries newest first', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async (container) => [
        { id: `${container}-old`, createdAt: '2026-01-01T00:00:00Z' },
        { id: `${container}-new`, createdAt: '2026-04-01T00:00:00Z' },
      ]),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.listImages(makeRequest(), context);
    const body = JSON.parse(res.body);
    expect(body.curated[0].id).toBe('curated_article_images-new');
    expect(body.generated[0].id).toBe('generated_content_images-new');
  });

  it('single curated lookup answers 200 with item:null when missing', async () => {
    const store = makeStore({
      readDoc: vi.fn(async (_c, id) => (id === 'hit' ? { id: 'hit', imageUrl: 'u' } : null)),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });

    const hit = await h.getCuratedImage(makeRequest({ params: { id: 'hit' } }), context);
    expect(JSON.parse(hit.body).item.imageUrl).toBe('u');
    expect(store.readDoc.mock.calls[0][0]).toBe('curated_article_images');

    const miss = await h.getCuratedImage(makeRequest({ params: { id: 'miss' } }), context);
    expect(miss.status).toBe(200);
    expect(JSON.parse(miss.body).item).toBeNull();
  });
});

describe('config collections (ai-providers / mcp-servers)', () => {
  it('404s any collection outside the allowlist before touching Cosmos', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.listConfig(makeRequest({ params: { collection: 'admins' } }), context);
    expect(res.status).toBe(404);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('lists sorted by order and NEVER returns oauthToken for mcp-servers', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [
        { id: 'b', order: 2, oauthToken: 'SECRET' },
        { id: 'a', order: 1, oauthToken: 'SECRET2' },
      ]),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.listConfig(makeRequest({ params: { collection: 'mcp-servers' } }), context);
    const body = JSON.parse(res.body);
    expect(body.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(res.body).not.toContain('SECRET');
    // Presence indicator instead of the value — RecordingsPage renders
    // connection state from it.
    expect(body.items.every((i) => i.hasOauthToken === true)).toBe(true);
  });

  it('PUT upserts at the client-chosen route id, preserving createdAt', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'vertex',
        createdAt: '2025-01-01T00:00:00Z',
      })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'vertex' },
        body: { enabled: true },
      }),
      context
    );
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.id).toBe('vertex');
    expect(doc.createdAt).toBe('2025-01-01T00:00:00Z'); // kept from the existing doc
    expect(doc.updatedAt).toBe('2026-08-06T12:00:00.000Z');
  });

  it('PUT carries a stored oauthToken through a read-modify-write round trip', async () => {
    // putConfig is a full replace and reads never return oauthToken, so an
    // edit form that reads then writes would silently delete the token
    // (T-314).
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'plaud',
        oauthToken: 'stored-tok',
        createdAt: 'x',
      })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: { enabled: true, hasOauthToken: true },
      }),
      context
    );

    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.oauthToken).toBe('stored-tok');
    // The read-side boolean must not persist into the document, where it would
    // shadow the real value on the next read.
    expect(doc).not.toHaveProperty('hasOauthToken');
  });

  it('PUT lets an explicit oauthToken overwrite the stored one', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'plaud', oauthToken: 'old-tok' })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: { oauthToken: 'new-tok' },
      }),
      context
    );
    expect(store.upsertDoc.mock.calls[0][1].oauthToken).toBe('new-tok');
  });

  it('PUT lets an explicit empty oauthToken revoke it', async () => {
    // Clearing must stay possible — carrying forward unconditionally would
    // make a token impossible to remove through this route.
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'plaud', oauthToken: 'old-tok' })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: { oauthToken: '' },
      }),
      context
    );
    expect(store.upsertDoc.mock.calls[0][1].oauthToken).toBe('');
  });

  it('PUT does not invent an oauthToken for a non-mcp collection', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'vertex',
        oauthToken: 'should-not-carry',
      })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'vertex' },
        body: { enabled: true },
      }),
      context
    );
    expect(store.upsertDoc.mock.calls[0][1]).not.toHaveProperty('oauthToken');
  });

  it('PATCH accepts an oauthToken write but strips it from the response', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'plaud' })),
      patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: { oauthToken: 'tok-123' },
      }),
      context
    );
    expect(store.patchDoc.mock.calls[0][2].oauthToken).toBe('tok-123'); // write goes through
    expect(res.body).not.toContain('tok-123'); // read never returns it
  });

  it('DELETE targets the mapped container', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.deleteConfig(makeRequest({ params: { collection: 'mcp-servers', id: 's1' } }), context);
    expect(store.deleteDoc).toHaveBeenCalledWith('mcp_servers', 's1');
  });
});

describe('usage records', () => {
  it('sorts timestamp desc, honors since as a parameterized filter', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [
        { id: 'a', timestamp: '2026-01-01T00:00:00Z' },
        { id: 'b', timestamp: '2026-03-01T00:00:00Z' },
      ]),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await h.listUsage(makeRequest({ query: { since: '2026-01-01' } }), context);
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['b', 'a']);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain('c.timestamp >= @since');
    expect(params).toContainEqual({ name: '@since', value: '2026-01-01' });
  });

  it('orders newest first in the query, so the TOP window holds the newest rows (ADR 0033)', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.listUsage(makeRequest(), context);
    expect(store.queryDocs.mock.calls[0][1]).toMatch(/ORDER BY c\.timestamp DESC$/);
    await h.listUsage(makeRequest({ query: { since: '2026-01-01' } }), context);
    expect(store.queryDocs.mock.calls[1][1]).toMatch(
      /WHERE c\.timestamp >= @since ORDER BY c\.timestamp DESC$/
    );
  });

  it('400s an unparseable since', async () => {
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store: makeStore(),
      ...fixed,
    });
    expect((await h.listUsage(makeRequest({ query: { since: 'junk' } }), context)).status).toBe(
      400
    );
  });
});

describe('AI feature switches', () => {
  const handlers = (store) =>
    createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

  it('GET resolves absent-means-on, so the portal shows real state not an empty object', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => null) });
    const response = await handlers(store).getAiFeatures(makeRequest(), context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(Object.values(body.features).every((v) => v === true)).toBe(true);
    expect(Object.keys(body.features)).toContain('inspector');
  });

  it('GET returns the catalogue, so the UI does not keep a second copy of the list', async () => {
    // A second copy is precisely how the AI Engine page came to advertise
    // Vertex as enabled while the router had removed it.
    const store = makeStore();
    const body = JSON.parse((await handlers(store).getAiFeatures(makeRequest(), context)).body);
    expect(body.catalogue.inspector.label).toBeTruthy();
    expect(Object.keys(body.catalogue).sort()).toEqual(Object.keys(body.features).sort());
  });

  it('GET reports a stored false as false', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ features: { critique: false } })),
    });
    const body = JSON.parse((await handlers(store).getAiFeatures(makeRequest(), context)).body);
    expect(body.features.critique).toBe(false);
    expect(body.features.inspector).toBe(true);
  });

  it('PUT merges rather than replaces, so one toggle does not clear the rest', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ features: { critique: false } })),
    });
    const response = await handlers(store).putAiFeatures(
      makeRequest({ body: { features: { telegram: false } } }),
      context
    );
    expect(response.status).toBe(200);
    expect(store.patchDoc).toHaveBeenCalledWith('admin_settings', 'ai-features', {
      features: { critique: false, telegram: false },
      updatedAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it('PUT stores strict booleans — a stray 0 must not read as OFF later', async () => {
    // The router disables on an explicit false only, so a 0 stored here would
    // silently mean ON. Coercing at the door means the document cannot hold
    // that ambiguity at all.
    const store = makeStore();
    await handlers(store).putAiFeatures(
      makeRequest({ body: { features: { inspector: 0, altText: false } } }),
      context
    );
    expect(store.upsertDoc.mock.calls[0][1].features).toEqual({
      inspector: true,
      altText: false,
    });
  });

  it('PUT 400s an unknown feature name instead of storing a switch that governs nothing', async () => {
    const store = makeStore();
    const response = await handlers(store).putAiFeatures(
      makeRequest({ body: { features: { inspectr: false } } }),
      context
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/inspectr/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PUT 400s a body that is not { features: {...} }', async () => {
    const store = makeStore();
    for (const body of [{}, { features: [] }, { features: null }]) {
      expect((await handlers(store).putAiFeatures(makeRequest({ body }), context)).status).toBe(
        400
      );
    }
  });

  describe('the per-feature placement left the API (ADR 0034 slice 4, #859)', () => {
    it('GET answers features and the catalogue only, whatever the document still stores', async () => {
      const store = makeStore({
        readDoc: vi.fn(async () => ({
          features: {},
          placement: { nvidia: { forgeDrafting: 'first' } },
        })),
      });
      const body = JSON.parse((await handlers(store).getAiFeatures(makeRequest(), context)).body);
      expect(Object.keys(body).sort()).toEqual(['catalogue', 'features', 'success']);
    });

    it('PUT refuses a placement body, and a features save leaves a stored placement untouched', async () => {
      const store = makeStore({
        readDoc: vi.fn(async () => ({
          features: { critique: false },
          placement: { nvidia: { critique: 'off' } },
        })),
      });
      const refused = await handlers(store).putAiFeatures(
        makeRequest({ body: { placement: { nvidia: { forgeDrafting: 'order' } } } }),
        context
      );
      expect(refused.status).toBe(400);
      expect(store.patchDoc).not.toHaveBeenCalled();
      // The migration reads the stored placement until the first v2 save of
      // the selection document; a switch flip must not clear it.
      const saved = await handlers(store).putAiFeatures(
        makeRequest({ body: { features: { forgeDrafting: false } } }),
        context
      );
      expect(saved.status).toBe(200);
      expect(store.patchDoc).toHaveBeenCalledWith('admin_settings', 'ai-features', {
        features: { critique: false, forgeDrafting: false },
        updatedAt: '2026-08-06T12:00:00.000Z',
      });
    });
  });

  it('both verbs require a role', async () => {
    const store = makeStore();
    const denied = createAdminIntegrationHandlers({
      guard: denyGuard,
      store,
      ...fixed,
    });
    expect((await denied.getAiFeatures(makeRequest(), context)).status).toBe(403);
    expect(
      (await denied.putAiFeatures(makeRequest({ body: { features: {} } }), context)).status
    ).toBe(403);
  });
});

describe('MCP key-to-host binding, routing privilege and config audit (AP-B1, 2026-10-06)', () => {
  const firecrawl = {
    id: 'firecrawl',
    url: 'https://mcp.firecrawl.dev/sse',
    apiKeyEnvVar: 'FIRECRAWL_API_KEY',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
  };
  const editorOnlyGuard = {
    requireRole: vi.fn(async (_request, minimum) =>
      minimum === 'super_admin'
        ? { user: null, role: null, error: { status: 403, body: '{"error":"Requires super_admin or higher"}' } }
        : { user: { oid: 'editor-1', email: 'editor@example.test' }, role: 'editor', error: null }
    ),
  };
  const auditRows = (store) =>
    store.upsertDoc.mock.calls.filter(([c]) => c === 'admin_audit_logs').map(([, d]) => d);

  it('PUT refuses a shared integration key at a host it is not bound to, before any write or elevation', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'exfil' },
        body: { url: 'https://attacker.example/', apiKeyEnvVar: 'REPLICATE_API_KEY', enabled: true },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/REPLICATE_API_KEY may only be sent to mcp\.replicate\.com/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(allowGuard.requireRole).not.toHaveBeenCalledWith(expect.anything(), 'super_admin');
  });

  it('PATCH moving the URL of a server that holds a shared key is checked against the stored key', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ ...firecrawl })) });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'firecrawl' },
        body: { url: 'https://attacker.example/sse' },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/FIRECRAWL_API_KEY may only be sent to/);
    expect(store.patchDoc).not.toHaveBeenCalled();

    // And the other half: a shared key placed on a server at the wrong host.
    const store2 = makeStore({
      readDoc: vi.fn(async () => ({ id: 'custom', url: 'https://custom.example/mcp', apiKeyEnvVar: null })),
    });
    const h2 = createAdminIntegrationHandlers({ guard: allowGuard, store: store2, ...fixed });
    const res2 = await h2.patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'custom' }, body: { apiKeyEnvVar: 'REPLICATE_API_KEY' } }),
      context
    );
    expect(res2.status).toBe(400);
    expect(store2.patchDoc).not.toHaveBeenCalled();
  });

  it('a write that moves where a credential is sent needs super_admin; an editor toggle, rename or token store does not', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ ...firecrawl })) });
    const h = createAdminIntegrationHandlers({ guard: editorOnlyGuard, store, ...fixed });

    const toggle = await h.patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'firecrawl' }, body: { enabled: false, name: 'FC' } }),
      context
    );
    expect(toggle.status).toBe(200);
    const token = await h.patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'firecrawl' }, body: { oauthToken: 't' } }),
      context
    );
    expect(token.status).toBe(200);
    // A round-trip PUT that restates the same URL and key is not a move.
    const sameRoute = await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'firecrawl' },
        body: { ...firecrawl, enabled: false },
      }),
      context
    );
    expect(sameRoute.status).toBe(200);

    const move = await h.patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'firecrawl' }, body: { url: 'https://api.firecrawl.dev/mcp' } }),
      context
    );
    expect(move.status).toBe(403);
    const rekey = await h.patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'firecrawl' }, body: { apiKeyEnvVar: 'MCP_FC' } }),
      context
    );
    expect(rekey.status).toBe(403);
    // A new server is a routing decision from the first byte.
    const emptyStore = makeStore();
    const h2 = createAdminIntegrationHandlers({ guard: editorOnlyGuard, store: emptyStore, ...fixed });
    const created = await h2.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'brand-new' },
        body: { url: 'https://new.example/mcp', enabled: true },
      }),
      context
    );
    expect(created.status).toBe(403);
    expect(emptyStore.upsertDoc).not.toHaveBeenCalled();
    // ai_providers writes are not credential routing.
    const provider = await h2.putConfig(
      makeRequest({ params: { collection: 'ai-providers', id: 'vertex' }, body: { enabled: true } }),
      context
    );
    expect(provider.status).toBe(200);
  });

  it('every config write leaves an ai_config_updated row naming the actor, the fields and the routing before and after, never a token', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ ...firecrawl, oauthToken: 'STORED-SECRET' })) });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    await h.patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'firecrawl' },
        body: { enabled: false, oauthToken: 'NEW-SECRET' },
      }),
      context
    );
    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'firecrawl' },
        body: { ...firecrawl, url: 'https://api.firecrawl.dev/mcp' },
      }),
      context
    );
    await h.deleteConfig(makeRequest({ params: { collection: 'mcp-servers', id: 'firecrawl' } }), context);
    const rows = auditRows(store);
    expect(rows.map((r) => r.details.operation)).toEqual(['patch', 'put', 'delete']);
    expect(rows[0]).toMatchObject({
      id: 'fixed-uuid',
      action: 'ai_config_updated',
      userId: 'u1',
      timestamp: '2026-08-06T12:00:00.000Z',
      details: {
        collection: 'mcp_servers',
        documentId: 'firecrawl',
        fields: ['enabled'],
        before: { url: 'https://mcp.firecrawl.dev/sse', apiKeyEnvVar: 'FIRECRAWL_API_KEY' },
        after: { url: 'https://mcp.firecrawl.dev/sse', apiKeyEnvVar: 'FIRECRAWL_API_KEY' },
      },
    });
    expect(rows[1].details.after.url).toBe('https://api.firecrawl.dev/mcp');
    expect(rows[2].details.after).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/SECRET/);
  });

  it('a config write still answers 200 when the audit row fails, because the save already took', async () => {
    const store = makeStore({
      upsertDoc: vi.fn(async (container, d) => {
        if (container === 'admin_audit_logs') throw new Error('audit down');
        return d;
      }),
    });
    const warn = vi.fn();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putConfig(
      makeRequest({ params: { collection: 'ai-providers', id: 'vertex' }, body: { enabled: true } }),
      { ...context, warn }
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/audit row failed/));
  });
});

describe('MCP tool allowlist writes (#995, 2026-10-07)', () => {
  const publer = {
    id: 'publer-mcp',
    url: 'https://mcp.publer.com',
    apiKeyEnvVar: 'PUBLER_API_KEY',
    allowedTools: ['get_publer_user', 'lookup_publer_accounts'],
    enabled: false,
    createdAt: '2026-10-07T00:00:00Z',
  };
  const firecrawl = {
    id: 'firecrawl',
    url: 'https://mcp.firecrawl.dev/sse',
    apiKeyEnvVar: 'FIRECRAWL_API_KEY',
    enabled: true,
  };
  const editorOnlyGuard = {
    requireRole: vi.fn(async (_request, minimum) =>
      minimum === 'super_admin'
        ? { user: null, role: null, error: { status: 403, body: '{"error":"Requires super_admin or higher"}' } }
        : { user: { oid: 'editor-1' }, role: 'editor', error: null }
    ),
  };
  const patch = (h, id, body) =>
    h.patchConfig(makeRequest({ params: { collection: 'mcp-servers', id }, body }), context);
  const put = (h, id, body) =>
    h.putConfig(makeRequest({ params: { collection: 'mcp-servers', id }, body }), context);

  it('refuses an editor PATCH that names allowedTools, and an editor switching a Publer-key server', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ ...publer })) });
    const h = createAdminIntegrationHandlers({ guard: editorOnlyGuard, store, ...fixed });
    expect(
      (await patch(h, 'publer-mcp', { allowedTools: ['get_publer_user', 'submit_publer_posts'] })).status
    ).toBe(403);
    // Even a list identical to the stored one: naming it is the privilege.
    expect((await patch(h, 'publer-mcp', { allowedTools: [...publer.allowedTools] })).status).toBe(403);
    expect((await patch(h, 'publer-mcp', { enabled: true })).status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();

    // Firecrawl's switch stays an editor's, as before.
    const store2 = makeStore({ readDoc: vi.fn(async () => ({ ...firecrawl })) });
    const h2 = createAdminIntegrationHandlers({ guard: editorOnlyGuard, store: store2, ...fixed });
    expect((await patch(h2, 'firecrawl', { enabled: false })).status).toBe(200);
    // But a list on Firecrawl is a super_admin decision too.
    expect((await patch(h2, 'firecrawl', { allowedTools: ['scrape'] })).status).toBe(403);
  });

  it('refuses a Publer-key server saved without a non-empty allowedTools, before any write', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const { allowedTools: _omitted, ...withoutList } = publer;
    for (const body of [withoutList, { ...publer, allowedTools: [] }, { ...publer, allowedTools: 'all' }]) {
      const res = await put(h, 'publer-mcp', body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/allowedTools/);
    }
    expect(store.upsertDoc).not.toHaveBeenCalled();

    // Moving an existing keyless server onto the Publer key needs the list too.
    const store2 = makeStore({
      readDoc: vi.fn(async () => ({ id: 'x', url: 'https://mcp.publer.com', apiKeyEnvVar: null })),
    });
    const h2 = createAdminIntegrationHandlers({ guard: allowGuard, store: store2, ...fixed });
    expect((await patch(h2, 'x', { apiKeyEnvVar: 'PUBLER_API_KEY' })).status).toBe(400);
    // And the list cannot be emptied on a server that has one.
    const store3 = makeStore({ readDoc: vi.fn(async () => ({ ...publer })) });
    const h3 = createAdminIntegrationHandlers({ guard: allowGuard, store: store3, ...fixed });
    expect((await patch(h3, 'publer-mcp', { allowedTools: [] })).status).toBe(400);
    expect((await patch(h3, 'publer-mcp', { allowedTools: null })).status).toBe(400);
    expect(store3.patchDoc).not.toHaveBeenCalled();
  });

  it('lets a super_admin set the list, keeps the stored list through a PUT that omits it, and audits both', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ ...publer })) });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const narrowed = await patch(h, 'publer-mcp', { allowedTools: ['get_publer_user'] });
    expect(narrowed.status).toBe(200);

    const { allowedTools: _omitted, ...withoutList } = publer;
    const replaced = await put(h, 'publer-mcp', { ...withoutList, name: 'Publer MCP' });
    expect(replaced.status).toBe(200);
    const stored = store.upsertDoc.mock.calls.find(([c]) => c === 'mcp_servers')[1];
    expect(stored.allowedTools).toEqual(publer.allowedTools);

    const rows = store.upsertDoc.mock.calls
      .filter(([c]) => c === 'admin_audit_logs')
      .map(([, d]) => d.details);
    expect(rows[0]).toMatchObject({
      fields: ['allowedTools'],
      before: { allowedTools: publer.allowedTools },
      after: { allowedTools: ['get_publer_user'] },
    });
    expect(rows[1].after.allowedTools).toEqual(publer.allowedTools);
  });
});

describe('partial MCP/AI config updates never disturb a stored secret', () => {
  // `oauthToken` on mcp_servers is the only secret VALUE these two collections
  // store — an ai_providers document holds `apiKeyEnvVar`, the NAME of a
  // server-side setting, never a key. Reads strip the token and synthesise
  // `hasOauthToken` in its place, so every edit form works from a document
  // that is missing the one field it must not destroy. These tests pin both
  // halves of that: a partial write must not clear the token, and must not
  // write the read artefact back in its place.
  const storedServer = (over = {}) => ({
    id: 'plaud',
    url: 'https://mcp.example/sse',
    enabled: true,
    oauthToken: 'stored-tok',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  /** patchDoc that merges like the real store, so responses are realistic. */
  const mergingStore = (doc) => {
    const state = { ...doc };
    return makeStore({
      readDoc: vi.fn(async () => ({ ...state })),
      patchDoc: vi.fn(async (_c, _id, updates) => Object.assign(state, updates)),
    });
  };

  const patch = (store, collection, body, id = 'plaud') =>
    createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    }).patchConfig(makeRequest({ params: { collection, id }, body }), context);

  it('PATCH omitting oauthToken does not send it, so the merge cannot clear it', async () => {
    const store = mergingStore(storedServer());
    await patch(store, 'mcp-servers', { enabled: false });

    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(updates).not.toHaveProperty('oauthToken');
    expect(Object.keys(updates).sort()).toEqual(['enabled', 'updatedAt']);
  });

  it('PATCH still hides the untouched token from its own response', async () => {
    // The merged document the store returns contains the token; the response
    // is built from it, so this is the point where an untouched secret would
    // leak back to the browser.
    const store = mergingStore(storedServer());
    const res = await patch(store, 'mcp-servers', {
      url: 'https://mcp.example/v2',
    });
    const { item } = JSON.parse(res.body);

    expect(res.body).not.toContain('stored-tok');
    expect(item).not.toHaveProperty('oauthToken');
    expect(item.hasOauthToken).toBe(true);
    expect(item.url).toBe('https://mcp.example/v2');
  });

  it('reads never return oauthRefreshToken either, and report its presence (T-518 Wave 5)', async () => {
    // The 12-hour refreshPlaudToken timer rotates with this value; the Connect
    // tab shows whether auto-refresh is armed from the boolean, never the value.
    const store = mergingStore(storedServer({ oauthRefreshToken: 'stored-ref' }));
    const res = await patch(store, 'mcp-servers', { enabled: false });
    const { item } = JSON.parse(res.body);

    expect(res.body).not.toContain('stored-ref');
    expect(item).not.toHaveProperty('oauthRefreshToken');
    expect(item.hasOauthRefreshToken).toBe(true);
    expect(
      JSON.parse(
        (
          await patch(mergingStore(storedServer()), 'mcp-servers', {
            enabled: false,
          })
        ).body
      ).item.hasOauthRefreshToken
    ).toBe(false);
  });

  it('PATCH drops hasOauthRefreshToken as a read artefact and stores an explicit refresh token', async () => {
    const store = mergingStore(storedServer());
    await patch(store, 'mcp-servers', {
      oauthRefreshToken: 'new-ref',
      hasOauthRefreshToken: false,
    });

    const updates = store.patchDoc.mock.calls[0][2];
    expect(updates.oauthRefreshToken).toBe('new-ref');
    expect(updates).not.toHaveProperty('hasOauthRefreshToken');
    expect((await patch(store, 'mcp-servers', { hasOauthRefreshToken: true })).status).toBe(400);
  });

  it('a PUT round trip carries a stored refresh token forward like the access token', async () => {
    const store = mergingStore(storedServer({ oauthRefreshToken: 'stored-ref' }));
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: {
          enabled: true,
          hasOauthToken: true,
          hasOauthRefreshToken: true,
        },
      }),
      context
    );
    const saved = store.upsertDoc.mock.calls.find(([c]) => c === 'mcp_servers')[1];
    expect(saved.oauthToken).toBe('stored-tok');
    expect(saved.oauthRefreshToken).toBe('stored-ref');
    expect(saved).not.toHaveProperty('hasOauthRefreshToken');
  });

  it('PATCH drops hasOauthToken instead of persisting it next to the token', async () => {
    // An edit form that PATCHes a field it read back sends the boolean with
    // it. Reads recompute the flag, so persisting it shadows nothing — it is
    // a stale copy of a secret's state that a later revoke would not clear.
    const store = mergingStore(storedServer());
    await patch(store, 'mcp-servers', { enabled: false, hasOauthToken: true });

    expect(store.patchDoc.mock.calls[0][2]).not.toHaveProperty('hasOauthToken');
  });

  it('PATCH rejects a body that is only read artefacts', async () => {
    // Otherwise it would be a write that touches nothing but updatedAt, and
    // report success for an edit that was never applied.
    const store = mergingStore(storedServer());
    for (const body of [
      { hasOauthToken: true },
      { id: 'plaud' },
      { id: 'p', hasOauthToken: false },
    ]) {
      expect((await patch(store, 'mcp-servers', body)).status).toBe(400);
    }
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('a revoke is still an explicit write, not an omission', async () => {
    // The token is cleared by sending an empty string. Nothing else clears it,
    // which is exactly why omission has to be safe.
    const store = mergingStore(storedServer());
    const res = await patch(store, 'mcp-servers', { oauthToken: '' });

    expect(store.patchDoc.mock.calls[0][2].oauthToken).toBe('');
    expect(JSON.parse(res.body).item.hasOauthToken).toBe(false);
  });

  it('a read-modify-write PUT round trip preserves the token through PATCH-style edits', async () => {
    // putConfig is a full replace, so the same form saved with PUT must land
    // on the same document. Pinned together because the two verbs share one
    // edit surface and only one of them was ever at risk of dropping it.
    const store = mergingStore(storedServer());
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const read = JSON.parse(
      (
        await h.patchConfig(
          makeRequest({
            params: { collection: 'mcp-servers', id: 'plaud' },
            body: { enabled: false },
          }),
          context
        )
      ).body
    ).item;

    await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'plaud' },
        body: { ...read, enabled: true },
      }),
      context
    );

    const saved = store.upsertDoc.mock.calls.find(([c]) => c === 'mcp_servers')[1];
    expect(saved.oauthToken).toBe('stored-tok');
    expect(saved).not.toHaveProperty('hasOauthToken');
    expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z'); // not reset by the replace
  });

  it('an ai-providers patch touches only the fields it names', async () => {
    // ai_providers holds no secret value, so the assertion here is the
    // narrower one: a partial update must not become a replace.
    const store = mergingStore({
      id: 'anthropic',
      enabled: true,
      order: 1,
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-old',
    });
    const res = await patch(store, 'ai-providers', { defaultModel: 'claude-new' }, 'anthropic');
    const { item } = JSON.parse(res.body);

    expect(store.patchDoc.mock.calls[0][2]).toEqual({
      defaultModel: 'claude-new',
      updatedAt: '2026-08-06T12:00:00.000Z',
    });
    expect(item.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(item.enabled).toBe(true);
    // ai_providers is never stripped, because it has nothing to strip — the
    // env var NAME is what the admin page renders to explain a disabled
    // provider.
    expect(item).not.toHaveProperty('hasOauthToken');
  });

  it('PATCH refuses a document that does not exist rather than creating one', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => null) });
    expect((await patch(store, 'mcp-servers', { enabled: false })).status).toBe(404);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('AI routing by task: the selection document (ADR 0033 §4 → ADR 0034 §2, #858)', () => {
  const onAiConfigChanged = vi.fn();
  const handlers = (store, extra = {}) =>
    createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      onAiConfigChanged,
      ...fixed,
      ...extra,
    });

  /** A store whose ai-routing and ai-features documents are given by id. */
  const docsStore = ({ routing = null, features = null, providers = [] } = {}) =>
    makeStore({
      queryDocs: vi.fn(async () => providers),
      readDoc: vi.fn(async (_c, id) => (id === 'ai-routing' ? routing : id === 'ai-features' ? features : null)),
    });

  it('GET answers the v2 document, migrated in memory from a v1 store, beside the catalogue', async () => {
    const store = docsStore({
      routing: {
        id: 'ai-routing',
        routes: {
          forgeDrafting: { provider: 'anthropic', model: 'claude-opus-4-6' },
          junk: { provider: 'x' },
        },
        updatedAt: '2026-10-01T00:00:00Z',
      },
    });
    const res = await handlers(store).getAiRouting(makeRequest(), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.migrated).toBe(true);
    expect(body.selection.version).toBe(2);
    expect(body.selection.global.priority.map((s) => s.provider)).toEqual([
      'gemini',
      'openai',
      'anthropic',
      'nvidia',
      'foundry',
    ]);
    // The route leads; Foundry's default placement ('first') follows it.
    expect(body.selection.tasks.forgeDrafting).toEqual({
      mode: 'custom',
      chain: [
        { provider: 'anthropic', model: 'claude-opus-4-6' },
        { provider: 'foundry', model: null },
      ],
      thenGlobal: true,
    });
    // The v1 `routes` view left with the Routing tab (slice 4, #859).
    expect(body).not.toHaveProperty('routes');
    expect(body).not.toHaveProperty('maxFallbacks');
    expect(body.updatedAt).toBe('2026-10-01T00:00:00Z');
    expect(body.catalogue.forgeDrafting.label).toBe('Forge drafting');
    expect(body.providers).toEqual(['gemini', 'openai', 'anthropic', 'nvidia', 'foundry']);
    expect(store.readDoc).toHaveBeenCalledWith('admin_settings', 'ai-routing', 'ai-routing');
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('GET answers a stored v2 document as it is, not migrated', async () => {
    const store = docsStore({
      routing: {
        id: 'ai-routing',
        version: 2,
        global: { priority: [{ provider: 'foundry', model: null }] },
        tasks: { inspector: { mode: 'recommended' } },
        updatedAt: '2026-10-05T00:00:00Z',
      },
    });
    const body = JSON.parse((await handlers(store).getAiRouting(makeRequest(), context)).body);
    expect(body.migrated).toBe(false);
    expect(body.selection.global.priority).toEqual([{ provider: 'foundry', model: null }]);
    expect(body.selection.tasks).toEqual({ inspector: { mode: 'recommended' } });
  });

  it('PUT refuses the v1 { routes } body now that the Routing tab is gone (slice 4, #859), writing nothing', async () => {
    onAiConfigChanged.mockClear();
    const store = docsStore({
      routing: { id: 'ai-routing', routes: { telegram: { provider: 'openai' } } },
    });
    const res = await handlers(store).putAiRouting(
      makeRequest({
        body: { routes: { forgeDrafting: { provider: 'anthropic', model: 'claude-opus-4-6' } } },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/version must be 2/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(onAiConfigChanged).not.toHaveBeenCalled();
  });

  it('PUT with a v2 document validates, normalises and writes it, naming the actor', async () => {
    onAiConfigChanged.mockClear();
    const store = docsStore({
      routing: { id: 'ai-routing', version: 2, global: { priority: [] }, tasks: {}, updatedAt: 'r1' },
    });
    const res = await handlers(store).putAiRouting(
      makeRequest({
        body: {
          version: 2,
          global: { priority: [{ provider: 'Foundry ', model: ' gpt-5-mini ' }, { provider: 'gemini' }] },
          tasks: {
            pricingExplain: { mode: 'global', exclude: ['nvidia'] },
            forgeDrafting: { mode: 'custom', chain: [{ provider: 'anthropic', model: null }], thenGlobal: false },
            telegram: { mode: 'recommended' },
          },
          updatedAt: 'r1',
        },
      }),
      context
    );
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.version).toBe(2);
    expect(doc.global.priority).toEqual([
      { provider: 'foundry', model: 'gpt-5-mini' },
      { provider: 'gemini', model: null },
    ]);
    expect(doc.tasks.forgeDrafting).toEqual({
      mode: 'custom',
      chain: [{ provider: 'anthropic', model: null }],
      thenGlobal: false,
    });
    expect(doc.tasks.telegram).toEqual({ mode: 'recommended' });
    expect(doc.updatedBy).toBe('u1');
    expect(body.selection.tasks.pricingExplain).toEqual({ mode: 'global', exclude: ['nvidia'] });
    expect(onAiConfigChanged).toHaveBeenCalledTimes(1);
  });

  it('PUT with a v2 document whose updatedAt is not the one read is a 409, and nothing is written', async () => {
    const store = docsStore({
      routing: { id: 'ai-routing', version: 2, global: { priority: [{ provider: 'gemini' }] }, updatedAt: 'r2' },
    });
    const res = await handlers(store).putAiRouting(
      makeRequest({
        body: { version: 2, global: { priority: [{ provider: 'gemini' }] }, tasks: {}, updatedAt: 'r1' },
      }),
      context
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).updatedAt).toBe('r2');
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PUT judges a chain over the catalogue the router reads: a keyed chain whose only model is retired would have no model', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => []),
      readDoc: vi.fn(async (_c, id) =>
        id === 'ai-model-catalog'
          ? {
              id,
              providers: {
                anthropic: {
                  refresh: { lastOk: '2026-10-05T00:00:00Z', lastAttempt: null, lastError: null },
                  models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', status: 'retired' } },
                },
              },
            }
          : null
      ),
    });
    const res = await handlers(store, {
      availableProviders: () => ['gemini', 'anthropic'],
    }).putAiRouting(
      makeRequest({
        body: {
          version: 2,
          global: { priority: [{ provider: 'gemini' }] },
          tasks: {
            forgeDrafting: {
              mode: 'custom',
              chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
              thenGlobal: false,
            },
          },
          updatedAt: null,
        },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/tasks\.forgeDrafting: this task would have no model/);
    expect(store.readDoc).toHaveBeenCalledWith('admin_settings', 'ai-model-catalog', 'ai-model-catalog');
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PUT refuses a v2 document that would leave a task with no model (§6), naming the task', async () => {
    const store = docsStore({ providers: [{ id: 'anthropic', enabled: false }] });
    const res = await handlers(store, {
      availableProviders: () => ['gemini', 'anthropic'],
    }).putAiRouting(
      makeRequest({
        body: {
          version: 2,
          global: { priority: [{ provider: 'gemini' }] },
          tasks: {
            // Anthropic is switched off, so the chain has no eligible entry.
            forgeDrafting: { mode: 'custom', chain: [{ provider: 'anthropic' }], thenGlobal: false },
            // Nvidia is locked off the public route; the list does not follow.
            pricingExplain: { mode: 'custom', chain: [{ provider: 'nvidia' }], thenGlobal: false },
          },
          updatedAt: null,
        },
      }),
      context
    );
    expect(res.status).toBe(400);
    const { errors } = JSON.parse(res.body);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/tasks\.forgeDrafting: this task would have no model/);
    expect(errors[1]).toMatch(/tasks\.pricingExplain: this task would have no model/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PUT refuses an unknown feature, an unknown provider, a duplicate fallback, a bad v2 shape and a bad shape, writing nothing', async () => {
    const store = makeStore();
    const h = handlers(store);
    const bad = [
      { routes: { nope: { provider: 'gemini' } } },
      { routes: { telegram: { provider: 'vertex' } } },
      {
        routes: {
          telegram: { provider: 'gemini', fallbacks: [{ provider: 'gemini' }] },
        },
      },
      {
        routes: {
          telegram: {
            provider: 'gemini',
            fallbacks: [{ provider: 'openai' }, { provider: 'openai' }],
          },
        },
      },
      { routes: { telegram: 'gemini' } },
      { routes: [] },
      {},
      { version: 1, global: { priority: [{ provider: 'gemini' }] } },
      { version: 2, global: { priority: [] } },
      { version: 2, global: { priority: [{ provider: 'gemini' }] }, tasks: { nope: { mode: 'global' } } },
      { version: 2, global: { priority: [{ provider: 'gemini' }] }, tasks: { telegram: { mode: 'always' } } },
      { version: 2, global: { priority: [{ provider: 'gemini' }] }, tasks: { telegram: { mode: 'global', chain: [] } } },
    ];
    for (const body of bad) {
      expect(
        (await h.putAiRouting(makeRequest({ body }), context)).status,
        JSON.stringify(body)
      ).toBe(400);
    }
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('both routes refuse without the editor role', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({
      guard: denyGuard,
      store,
      ...fixed,
    });
    expect((await h.getAiRouting(makeRequest(), context)).status).toBe(403);
    expect((await h.putAiRouting(makeRequest({ body: { routes: {} } }), context)).status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});

describe('the router cache is dropped after a write it reads (ADR 0033)', () => {
  it('feature switches and provider documents invalidate; MCP servers and recordings do not', async () => {
    const onAiConfigChanged = vi.fn();
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'x', enabled: true })),
    });
    const h = createAdminIntegrationHandlers({
      guard: allowGuard,
      store,
      onAiConfigChanged,
      ...fixed,
    });
    await h.putAiFeatures(makeRequest({ body: { features: { telegram: false } } }), context);
    await h.patchConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'gemini' },
        body: { enabled: false },
      }),
      context
    );
    await h.putConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'gemini' },
        body: { enabled: true },
      }),
      context
    );
    await h.deleteConfig(
      makeRequest({ params: { collection: 'ai-providers', id: 'vertex' } }),
      context
    );
    expect(onAiConfigChanged).toHaveBeenCalledTimes(4);
    await h.patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'context7' },
        body: { enabled: true },
      }),
      context
    );
    expect(onAiConfigChanged).toHaveBeenCalledTimes(4);
  });
});

describe('MCP server writes are checked (ADR 0033, security finding)', () => {
  const h = (
    store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'custom', url: 'https://ok.test' })),
    })
  ) => createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

  it('PUT refuses a plain-http URL and a key name outside the allowlist, before any write', async () => {
    const store = makeStore();
    const handlers = h(store);
    const http = await handlers.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'custom' },
        body: { url: 'http://evil.test/mcp', apiKeyEnvVar: 'MCP_X' },
      }),
      context
    );
    expect(http.status).toBe(400);
    expect(JSON.parse(http.body).error).toMatch(/https/);
    const key = await handlers.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'custom' },
        body: {
          url: 'https://evil.test/mcp',
          apiKeyEnvVar: 'COSMOS_CONNECTION_STRING',
        },
      }),
      context
    );
    expect(key.status).toBe(400);
    expect(JSON.parse(key.body).error).toMatch(/not allowed/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('PATCH checks only the fields it carries, so flipping enabled on an old document still works', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'old', url: 'http://old.test' })),
    });
    const handlers = h(store);
    expect(
      (
        await handlers.patchConfig(
          makeRequest({
            params: { collection: 'mcp-servers', id: 'old' },
            body: { enabled: true },
          }),
          context
        )
      ).status
    ).toBe(200);
    expect(
      (
        await handlers.patchConfig(
          makeRequest({
            params: { collection: 'mcp-servers', id: 'old' },
            body: { apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
          }),
          context
        )
      ).status
    ).toBe(400);
  });

  it('accepts https plus an MCP_* key, and the seeded integration keys', async () => {
    const store = makeStore();
    const res = await h(store).putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'custom' },
        body: {
          url: 'https://mcp.example.test/mcp',
          apiKeyEnvVar: 'MCP_EXAMPLE_KEY',
        },
      }),
      context
    );
    expect(res.status).toBe(200);
    // One document write; the second upsert is the audit row (AP-B1).
    expect(store.upsertDoc.mock.calls.filter(([c]) => c === 'mcp_servers')).toHaveLength(1);
  });
});

describe('MCP OAuth Connect fields on the config routes (2026-10-08)', () => {
  const superGuard = {
    requireRole: vi.fn(async () => ({ user: { oid: 'owner' }, role: 'super_admin', error: null })),
  };
  const connected = (over = {}) => ({
    id: 'hostinger-mcp',
    name: 'Hostinger MCP',
    url: 'https://mcp.hostinger.com',
    transport: 'http',
    authType: 'oauth',
    apiKeyEnvVar: null,
    status: 'connected',
    oauthToken: 'at-secret',
    oauthRefreshToken: 'rt-secret',
    oauthClientSecret: 'client-secret',
    oauthPending: { stateHash: 'hash', codeVerifier: 'verifier-secret', createdBy: 'owner' },
    oauthClient: { issuer: 'https://auth.hostinger.com', clientId: 'hst-client-1' },
    oauth: {
      status: 'connected',
      tokenEndpoint: 'https://auth.hostinger.com/api/external/v1/oauth-server/token',
      scope: 'mcp:use',
      expiresAt: '2026-10-08T13:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
  const merging = (doc) => {
    const state = { ...doc };
    return makeStore({
      queryDocs: vi.fn(async () => [{ ...state }]),
      readDoc: vi.fn(async () => ({ ...state })),
      patchDoc: vi.fn(async (_c, _id, updates) => Object.assign(state, updates)),
    });
  };
  const handlers = (store, guard = allowGuard) =>
    createAdminIntegrationHandlers({ guard, store, ...fixed });
  const patchServer = (store, body, guard) =>
    handlers(store, guard).patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'hostinger-mcp' }, body }),
      context
    );

  it('never returns a token, the client secret or the pending sign-in on any read', async () => {
    const store = merging(connected());
    const list = await handlers(store).listConfig(makeRequest({ params: { collection: 'mcp-servers' } }), context);
    const patched = await patchServer(store, { enabled: true });
    for (const res of [list, patched]) {
      for (const secret of ['at-secret', 'rt-secret', 'client-secret', 'verifier-secret', '"oauthPending"']) {
        expect(res.body).not.toContain(secret);
      }
    }
    const [item] = JSON.parse(list.body).items;
    expect(item).toMatchObject({
      hasOauthToken: true,
      hasOauthRefreshToken: true,
      oauth: { status: 'connected', scope: 'mcp:use' },
      oauthClient: { clientId: 'hst-client-1' },
    });
  });

  it('drops the flow’s own fields from a PATCH, so no editor can point the refresh at another host', async () => {
    const store = merging(connected());
    await patchServer(store, {
      enabled: true,
      oauth: { status: 'connected', tokenEndpoint: 'https://attacker.example/token' },
      oauthClient: { clientId: 'x' },
      oauthClientSecret: 'x',
      oauthPending: { stateHash: 'x' },
    });
    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(Object.keys(updates).sort()).toEqual(['enabled', 'updatedAt']);
    // A body of nothing else is a body with nothing to update.
    const only = await patchServer(merging(connected()), { oauth: { tokenEndpoint: 'https://attacker.example/' } });
    expect(only.status).toBe(400);
  });

  it('a PUT round trip keeps the stored connection and registration', async () => {
    const store = merging(connected());
    // What a form holds: the read, which never carries the write-only fields.
    const {
      oauthToken: _token,
      oauthRefreshToken: _refresh,
      oauthClientSecret: _secret,
      oauthPending: _pending,
      ...readable
    } = connected();
    const res = await handlers(store).putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'hostinger-mcp' },
        body: { ...readable, oauth: { tokenEndpoint: 'https://attacker.example/' }, hasOauthToken: true },
      }),
      context
    );
    expect(res.status).toBe(200);
    const [, doc] = store.upsertDoc.mock.calls.find(([c]) => c === 'mcp_servers');
    expect(doc.oauth.tokenEndpoint).toBe('https://auth.hostinger.com/api/external/v1/oauth-server/token');
    expect(doc.oauthClientSecret).toBe('client-secret');
    expect(doc.oauthToken).toBe('at-secret');
  });

  it('a configuration change clears the stale status and error', async () => {
    const stale = connected({
      id: 'replicate-mcp',
      url: 'https://mcp.replicate.com/sse',
      transport: 'sse',
      authType: undefined,
      apiKeyEnvVar: 'REPLICATE_API_KEY',
      status: 'error',
      lastError: 'SSE GET returned HTTP 401',
      oauth: undefined,
    });
    const store = merging(stale);
    await handlers(store, superGuard).patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'replicate-mcp' },
        body: { apiKeyEnvVar: null, authType: 'oauth' },
      }),
      context
    );
    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(updates).toMatchObject({ apiKeyEnvVar: null, authType: 'oauth', status: 'untested', lastError: null });
    // Flipping `enabled` is not a configuration change.
    const toggled = merging(stale);
    await patchServer(toggled, { enabled: true });
    expect(toggled.patchDoc.mock.calls[0][2]).not.toHaveProperty('status');
  });

  it('moving an OAuth-connected server’s URL disconnects it: the token is not sent to the new host', async () => {
    const store = merging(connected());
    await patchServer(store, { url: 'https://mcp2.hostinger.com' }, superGuard);
    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(updates).toMatchObject({
      url: 'https://mcp2.hostinger.com',
      oauthToken: null,
      oauthRefreshToken: null,
      oauth: null,
      oauthPending: null,
      status: 'untested',
    });
  });

  it('accepts the seed’s migration of the stored Hostinger and Replicate documents', async () => {
    // The exact bodies frontend/src/lib/aiEngine/seed.js mcpServerPatch
    // produces for the documents stored before this change.
    const hostinger = merging({
      id: 'hostinger-mcp',
      url: 'http://localhost:8100',
      transport: 'http',
      apiKeyEnvVar: 'VPS_API_TOKEN',
      status: 'error',
      lastError: 'fetch failed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await handlers(hostinger, superGuard).patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'hostinger-mcp' },
        body: {
          url: 'https://mcp.hostinger.com',
          apiKeyEnvVar: null,
          authType: 'oauth',
          description: 'd',
          notes: 'n',
        },
      }),
      context
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).item).toMatchObject({
      url: 'https://mcp.hostinger.com',
      apiKeyEnvVar: null,
      authType: 'oauth',
      status: 'untested',
      lastError: null,
    });

    const replicate = merging({
      id: 'replicate-mcp',
      url: 'https://mcp.replicate.com/sse',
      transport: 'sse',
      apiKeyEnvVar: 'REPLICATE_API_KEY',
      status: 'error',
      lastError: 'SSE GET returned HTTP 401',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const rep = await handlers(replicate, superGuard).patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'replicate-mcp' },
        body: { apiKeyEnvVar: null, authType: 'oauth', notes: 'n' },
      }),
      context
    );
    expect(rep.status).toBe(200);
    expect(JSON.parse(rep.body).item).toMatchObject({ status: 'untested', lastError: null, authType: 'oauth' });

    // The URL half alone would be refused: the localhost URL rule is gone.
    const half = await handlers(merging({ id: 'h', url: 'https://mcp.hostinger.com' }), superGuard).patchConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'h' }, body: { url: 'http://localhost:8100' } }),
      context
    );
    expect(half.status).toBe(400);
    expect(JSON.parse(half.body).error).toMatch(/must use https/);
  });
});

describe('config writes after the OAuth Connect security review (2026-10-08)', () => {
  const editorOnly = {
    requireRole: vi.fn(async (_request, minimum) =>
      minimum === 'super_admin'
        ? { user: null, role: null, error: { status: 403, body: '{"error":"Requires super_admin or higher"}' } }
        : { user: { oid: 'editor-1' }, role: 'editor', error: null }
    ),
  };
  const superAdmin = {
    requireRole: vi.fn(async () => ({ user: { oid: 'owner' }, role: 'super_admin', error: null })),
  };
  const hostinger = (over = {}) => ({
    id: 'hostinger-mcp',
    name: 'Hostinger MCP',
    url: 'https://mcp.hostinger.com',
    transport: 'http',
    authType: 'oauth',
    apiKeyEnvVar: null,
    enabled: false,
    oauthToken: 'at',
    oauthRefreshToken: 'rt',
    oauthClientSecret: 'cs',
    oauth: { status: 'connected', tokenEndpoint: 'https://auth.hostinger.com/token' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
  const storeWith = (doc) => {
    const state = { ...doc };
    return makeStore({
      readDoc: vi.fn(async () => ({ ...state })),
      patchDoc: vi.fn(async (_c, _id, updates) => Object.assign(state, updates)),
    });
  };
  const patchAs = (guard, store, body, { collection = 'mcp-servers', id = 'hostinger-mcp' } = {}) =>
    createAdminIntegrationHandlers({ guard, store, ...fixed }).patchConfig(
      makeRequest({ params: { collection, id }, body }),
      context
    );

  it('refuses a nested path, so no editor can reach inside oauth, oauthPending or allowedTools', async () => {
    const bodies = [
      { 'oauth.tokenEndpoint': 'https://attacker.example/token', 'oauth.expiresAt': '2000-01-01T00:00:00Z' },
      { 'oauthPending.tokenEndpoint': 'https://attacker.example/token' },
      { 'allowedTools.0': 'delete_publer_posts' },
    ];
    for (const body of bodies) {
      const store = storeWith(hostinger());
      const res = await patchAs(editorOnly, store, body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/names a nested path/);
      expect(store.patchDoc).not.toHaveBeenCalled();
    }
    // The same rule holds for the provider collection and for a PUT.
    const providers = await patchAs(editorOnly, storeWith({ id: 'gemini' }), { 'models.0': 'x' }, {
      collection: 'ai-providers',
      id: 'gemini',
    });
    expect(providers.status).toBe(400);
    const store = storeWith(hostinger());
    const put = await createAdminIntegrationHandlers({ guard: superAdmin, store, ...fixed }).putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'hostinger-mcp' },
        body: { ...hostinger(), 'oauth.tokenEndpoint': 'https://attacker.example/' },
      }),
      context
    );
    expect(put.status).toBe(400);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('switching an OAuth Connect server on or off needs super_admin; Plaud and keyless servers do not', async () => {
    const refused = await patchAs(editorOnly, storeWith(hostinger()), { enabled: true });
    expect(refused.status).toBe(403);
    const allowed = await patchAs(superAdmin, storeWith(hostinger()), { enabled: true });
    expect(allowed.status).toBe(200);
    const plaud = await patchAs(
      editorOnly,
      storeWith({ id: 'plaud', url: 'https://mcp.plaud.ai/mcp', authType: 'oauth' }),
      { enabled: true },
      { id: 'plaud' }
    );
    expect(plaud.status).toBe(200);
    const context7 = await patchAs(
      editorOnly,
      storeWith({ id: 'context7', url: 'https://mcp.context7.com/mcp' }),
      { enabled: true },
      { id: 'context7' }
    );
    expect(context7.status).toBe(200);
  });

  it('changing authType needs super_admin, so an editor cannot disconnect a sign-in', async () => {
    const store = storeWith(hostinger());
    const res = await patchAs(editorOnly, store, { authType: 'none' });
    expect(res.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('a URL move clears a sign-in in progress even before the first connection', async () => {
    const store = storeWith(
      hostinger({ oauth: undefined, oauthToken: undefined, oauthPending: { stateHash: 'h' } })
    );
    await patchAs(superAdmin, store, { url: 'https://mcp2.hostinger.com' });
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({ oauthPending: null, oauth: null });
  });

  const putAs = (guard, store, body) =>
    createAdminIntegrationHandlers({ guard, store, ...fixed }).putConfig(
      makeRequest({ params: { collection: 'mcp-servers', id: 'hostinger-mcp' }, body }),
      context
    );
  /** What a form PUTs back: the read, which never carries the write-only fields. */
  const readable = ({ oauthToken: _t, oauthRefreshToken: _r, oauthClientSecret: _s, oauthPending: _p, ...rest }) =>
    rest;
  const stored = (store) => store.upsertDoc.mock.calls.find(([c]) => c === 'mcp_servers')?.[1];

  it('judges a PUT on what it stores: an omitted authType is kept, an omitted enabled or url is a change (review of #1019)', async () => {
    // authType left out: carried, so the server still signs in with Connect and keeps its tokens.
    const { authType: _a, enabled: _e0, ...noAuthType } = readable(hostinger());
    const kept = storeWith(hostinger());
    expect((await putAs(editorOnly, kept, noAuthType)).status).toBe(200);
    expect(stored(kept)).toMatchObject({ authType: 'oauth', oauthToken: 'at', oauthRefreshToken: 'rt' });

    // enabled left out of an enabled Connect server switches it off: super_admin.
    const on = hostinger({ enabled: true });
    const { enabled: _e1, ...noEnabled } = readable(on);
    expect((await putAs(editorOnly, storeWith(on), noEnabled)).status).toBe(403);
    expect((await putAs(superAdmin, storeWith(on), noEnabled)).status).toBe(200);

    // url left out moves the server: super_admin, and the connection goes with it.
    const { url: _u, enabled: _e2, ...noUrl } = readable(hostinger());
    const refused = storeWith(hostinger());
    expect((await putAs(editorOnly, refused, noUrl)).status).toBe(403);
    expect(refused.upsertDoc).not.toHaveBeenCalled();
    const moved = storeWith(hostinger());
    expect((await putAs(superAdmin, moved, noUrl)).status).toBe(200);
    expect(stored(moved)).toMatchObject({ oauthToken: null, oauthRefreshToken: null, oauth: null });
  });

  it('refuses the Connect tokens on a config write, and keeps Plaud’s pasted token (review of #1019)', async () => {
    for (const body of [{ oauthToken: 'another-account' }, { oauthRefreshToken: 'another-account' }, { oauthToken: '' }]) {
      const store = storeWith(hostinger());
      const res = await patchAs(superAdmin, store, body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/set by Connect/);
      expect(store.patchDoc).not.toHaveBeenCalled();
    }
    const put = storeWith(hostinger());
    expect((await putAs(superAdmin, put, { ...readable(hostinger()), oauthToken: 'another-account' })).status).toBe(400);
    expect(put.upsertDoc).not.toHaveBeenCalled();
    const plaud = await patchAs(
      editorOnly,
      storeWith({ id: 'plaud', url: 'https://mcp.plaud.ai/mcp', authType: 'oauth' }),
      { oauthToken: 'pasted' },
      { id: 'plaud' }
    );
    expect(plaud.status).toBe(200);
  });

  it('deleting an OAuth Connect server needs super_admin, as Disconnect does (review of #1019)', async () => {
    const del = (guard, store, id = 'hostinger-mcp') =>
      createAdminIntegrationHandlers({ guard, store, ...fixed }).deleteConfig(
        makeRequest({ params: { collection: 'mcp-servers', id } }),
        context
      );
    const store = storeWith(hostinger());
    expect((await del(editorOnly, store)).status).toBe(403);
    expect(store.deleteDoc).not.toHaveBeenCalled();
    expect((await del(superAdmin, storeWith(hostinger()))).status).toBe(200);
    const keyless = storeWith({ id: 'context7', url: 'https://mcp.context7.com/mcp' });
    expect((await del(editorOnly, keyless, 'context7')).status).toBe(200);
    // A read that fails fails the delete, rather than skipping the check.
    const broken = storeWith(hostinger());
    broken.readDoc.mockRejectedValueOnce(new Error('cosmos down'));
    expect((await del(editorOnly, broken)).status).toBe(500);
    expect(broken.deleteDoc).not.toHaveBeenCalled();
  });
});

describe('AP-B6: mass assignment allowlists on admin integration writes', () => {
  it('recordings create and patch reject unknown fields with 400', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'r1', status: 'new' })),
    });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

    const createRes = await h.createRecording(
      makeRequest({
        body: { title: 'R', transcript: 'T', evilExtra: 'payload' },
      }),
      context
    );
    expect(createRes.status).toBe(400);
    expect(JSON.parse(createRes.body).error).toMatch(/Unknown field\(s\): evilExtra/);
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const patchRes = await h.patchRecording(
      makeRequest({
        params: { id: 'r1' },
        body: { unauthorizedProp: 1 },
      }),
      context
    );
    expect(patchRes.status).toBe(400);
    expect(JSON.parse(patchRes.body).error).toMatch(/Unknown field\(s\): unauthorizedProp/);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('recordings create cannot override status from the body', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

    // Any status but the one the server stamps is refused:
    const res = await h.createRecording(
      makeRequest({
        body: { title: 'R', transcript: 'T', status: 'published' },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("status on create must be 'new'");
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  // The two Recording Hub forms, posted exactly as they send them. #1181's
  // allowlist answered both with 400 (`Unknown field(s): recordedAt, source,
  // plaudId, status` and `... source, status`); these fail if a field they
  // send leaves RECORDING_CREATE_FIELDS again.
  it('accepts the Plaud routing payload recordingCards.jsx sends, typed', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.createRecording(
      makeRequest({
        body: {
          title: 'Weekly sync',
          transcript: 'Hello',
          duration: 1820,
          recordedAt: '2026-10-14T15:30:00Z',
          source: 'plaud_mcp',
          plaudId: 'pl_abc123',
          status: 'new',
        },
      }),
      context
    );
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      title: 'Weekly sync',
      transcript: 'Hello',
      duration: 1820,
      recordedAt: '2026-10-14T15:30:00.000Z',
      source: 'plaud_mcp',
      plaudId: 'pl_abc123',
      status: 'new',
      id: 'fixed-uuid',
    });
  });

  it('accepts the pasted-transcript payload uploadForms.jsx sends', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.createRecording(
      makeRequest({
        body: { title: 'Pasted talk', transcript: 'Text', source: 'manual_upload', status: 'new' },
      }),
      context
    );
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      source: 'manual_upload',
      status: 'new',
    });
  });

  it('types the new create fields: source, plaudId and recordedAt', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });
    const post = (extra) =>
      h.createRecording(makeRequest({ body: { title: 'R', transcript: 'T', ...extra } }), context);

    expect(JSON.parse((await post({ source: 'plaud-embedded' })).body).error).toMatch(/^source must be one of/);
    expect(JSON.parse((await post({ plaudId: '' })).body).error).toMatch(/^plaudId must be/);
    expect(JSON.parse((await post({ plaudId: 'x'.repeat(201) })).body).error).toMatch(/^plaudId must be/);
    expect(JSON.parse((await post({ plaudId: 42 })).body).error).toMatch(/^plaudId must be/);
    expect(JSON.parse((await post({ recordedAt: 'not a date' })).body).error).toMatch(/^recordedAt must be/);
    expect(JSON.parse((await post({ recordedAt: { at: 1 } })).body).error).toMatch(/^recordedAt must be/);
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const res = await post({ recordedAt: Date.UTC(2026, 9, 14, 15, 30) });
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1].recordedAt).toBe('2026-10-14T15:30:00.000Z');
  });

  // CodeRabbit on #1187: `new Date()` rolls 2026-02-30 over to 2 March and
  // reads a zoneless time in the host's zone.
  it('normaliseRecordedAt refuses calendar overflow and reads a zoneless time as UTC', () => {
    expect(normaliseRecordedAt('2026-02-30')).toBeNull();
    expect(normaliseRecordedAt('2026-02-30T10:00:00')).toBeNull();
    expect(normaliseRecordedAt('2025-02-29')).toBeNull();
    expect(normaliseRecordedAt('2026-13-01')).toBeNull();
    expect(normaliseRecordedAt('2026-10-14T24:00:00')).toBeNull();
    expect(normaliseRecordedAt('14/10/2026')).toBeNull();
    expect(normaliseRecordedAt(Number.NaN)).toBeNull();
    expect(normaliseRecordedAt(Number.POSITIVE_INFINITY)).toBeNull();

    expect(normaliseRecordedAt('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
    expect(normaliseRecordedAt('2026-10-14T15:30:00')).toBe('2026-10-14T15:30:00.000Z');
    expect(normaliseRecordedAt('2026-10-14 15:30')).toBe('2026-10-14T15:30:00.000Z');
    expect(normaliseRecordedAt('2026-10-14T15:30:00.123Z')).toBe('2026-10-14T15:30:00.123Z');
    expect(normaliseRecordedAt('2026-10-14T10:30:00-05:00')).toBe('2026-10-14T15:30:00.000Z');
    expect(normaliseRecordedAt(' 2026-10-14T15:30:00Z ')).toBe('2026-10-14T15:30:00.000Z');
  });

  it('putSettings rejects unknown fields with 400', async () => {
    const store = makeStore();
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

    const res = await h.putSettings(
      makeRequest({
        body: { sessionizeSpeakerId: 'valid-id', maliciousConfig: 'danger' },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unknown field\(s\): maliciousConfig/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('ai-providers put and patch reject unknown fields with 400', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'vertex', enabled: true })),
    });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

    const putRes = await h.putConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'vertex' },
        body: { enabled: true, secretBackdoor: true },
      }),
      context
    );
    expect(putRes.status).toBe(400);
    expect(JSON.parse(putRes.body).error).toMatch(/Unknown field\(s\) for ai_providers: secretBackdoor/);

    const patchRes = await h.patchConfig(
      makeRequest({
        params: { collection: 'ai-providers', id: 'vertex' },
        body: { injection: 42 },
      }),
      context
    );
    expect(patchRes.status).toBe(400);
    expect(JSON.parse(patchRes.body).error).toMatch(/Unknown field\(s\) for ai_providers: injection/);
  });

  it('mcp-servers put and patch reject unknown fields with 400', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'srv', url: 'https://mcp.example.com' })),
    });
    const h = createAdminIntegrationHandlers({ guard: allowGuard, store, ...fixed });

    const putRes = await h.putConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'srv' },
        body: { url: 'https://mcp.example.com', unapprovedFlag: true },
      }),
      context
    );
    expect(putRes.status).toBe(400);
    expect(JSON.parse(putRes.body).error).toMatch(/Unknown field\(s\) for mcp_servers: unapprovedFlag/);

    const patchRes = await h.patchConfig(
      makeRequest({
        params: { collection: 'mcp-servers', id: 'srv' },
        body: { exploitKey: 'val' },
      }),
      context
    );
    expect(patchRes.status).toBe(400);
    expect(JSON.parse(patchRes.body).error).toMatch(/Unknown field\(s\) for mcp_servers: exploitKey/);
  });
});

