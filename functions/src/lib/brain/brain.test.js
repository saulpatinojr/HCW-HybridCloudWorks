import { describe, it, expect, vi } from 'vitest';
import { memoryStore } from '../../../test/brain-store.js';
import { createBrainRepository } from './repository.js';
import { createBrainHandlers } from './handlers.js';
import { createSourceService, referenceOf } from './sources.js';
import { createBrainIndexer } from './indexing.js';
import { askBrain } from './assistant.js';
import { validateRecord, sourceKey } from './model.js';
import { createRoleGuard } from '../auth/require-role.js';

const env = {
  BRAIN_ENABLED: 'true',
  BRAIN_AI_ENABLED: 'true',
  BRAIN_OWNER_OID: 'owner',
  BRAIN_OWNER_TENANT_ID: 'tenant',
  BRAIN_SYNC_CLIENT_ID: 'desktop',
};
const note = (id = 'note-1') => ({
  id,
  type: 'note',
  title: 'Terraform research',
  body: 'Terraform state is important.',
  tags: ['terraform'],
  links: [],
  collections: [],
  urls: [],
  archived: false,
  inbox: true,
});
const request = (body = {}, params = {}, query = '') => ({
  params,
  query: new URLSearchParams(query),
  headers: { get: () => null },
  json: async () => body,
  url: `https://hcw.invalid/?${query}`,
});
const json = (r) => JSON.parse(r.body);
function setup({
  user = {
    oid: 'owner',
    tid: 'tenant',
    scp: 'access_as_admin',
    roles: ['Admin'],
    azp: 'spa',
  },
  active = true,
  role = 'editor',
  settings = env,
} = {}) {
  const { store, batch } = memoryStore();
  const repo = createBrainRepository(store, 'owner', batch);
  const guardFor = (delegatedScope) =>
    createRoleGuard({
      verifier: { verify: async () => user },
      delegatedScope,
      lookupAdmin: async () => ({ active, role }),
    });
  const withAuth = (req) => ({
    ...req,
    headers: {
      get: (name) => (name === 'authorization' ? 'Bearer fake' : null),
    },
  });
  const handlers = createBrainHandlers({
    guard: guardFor('access_as_admin'),
    syncGuard: guardFor('brain_sync'),
    repo,
    settings,
    env: settings,
    log: { error: vi.fn() },
  });
  return { store, repo, handlers, withAuth };
}

describe('private Second Brain boundary', () => {
  it.each([
    [
      'other administrator',
      {
        user: {
          oid: 'other',
          tid: 'tenant',
          roles: ['Admin'],
          scp: 'access_as_admin',
        },
        role: 'super_admin',
      },
      404,
    ],
    [
      'wrong tenant',
      {
        user: {
          oid: 'owner',
          tid: 'another',
          roles: ['Admin'],
          scp: 'access_as_admin',
        },
      },
      404,
    ],
    ['inactive owner', { active: false }, 403],
    ['viewer owner', { role: 'viewer' }, 403],
    ['disabled feature', { settings: { ...env, BRAIN_ENABLED: 'false' } }, 404],
  ])('rejects %s without returning notes', async (_name, options, status) => {
    const { handlers, withAuth, store } = setup(options);
    const spy = vi.spyOn(store, 'queryDocs');
    for (const handler of [
      'status',
      'list',
      'get',
      'history',
      'search',
      'graph',
      'reindex',
      'draft',
      'context',
      'ask',
    ]) {
      const response = await handlers[handler](withAuth(request()));
      expect(response.status, handler).toBe(status);
      expect(response.headers['Cache-Control']).toBe('private, no-store');
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('requires sign-in and rejects restricted sync tokens at ordinary APIs', async () => {
    const normal = setup();
    expect((await normal.handlers.list(request())).status).toBe(401);
    const sync = setup({
      user: {
        oid: 'owner',
        tid: 'tenant',
        roles: ['Admin'],
        scp: 'brain_sync',
        azp: 'desktop',
      },
    });
    expect((await sync.handlers.list(sync.withAuth(request()))).status).toBe(
      401,
    );
    expect(
      (await sync.handlers.syncPull(sync.withAuth(request()))).status,
    ).toBe(200);
    const otherClient = setup({
      user: {
        oid: 'owner',
        tid: 'tenant',
        roles: ['Admin'],
        scp: 'brain_sync',
        azp: 'spa',
      },
    });
    expect(
      (await otherClient.handlers.syncPull(otherClient.withAuth(request())))
        .status,
    ).toBe(403);
  });
});

describe('authored records and sync protocol', () => {
  it('serializes concurrent first saves without losing a sync event', async () => {
    const { repo } = setup();
    await Promise.all([
      repo.commit(note('note-a'), { version: 0, mutationId: 'mutation-aaa' }),
      repo.commit(note('note-b'), { version: 0, mutationId: 'mutation-bbb' }),
    ]);
    const changes = await repo.changes(0);
    expect(changes.cursor).toBe(2);
    expect(changes.items.map((i) => i.id).sort()).toEqual(['note-a', 'note-b']);
  });
  it('commits note, revision, receipt and event together and retries once', async () => {
    const { repo } = setup();
    const first = await repo.commit(note(), {
      mutationId: 'mutation-001',
      version: 0,
    });
    expect(first.version).toBe(1);
    expect(
      await repo.commit(note(), { mutationId: 'mutation-001', version: 0 }),
    ).toEqual(first);
    expect(await repo.history(first.id)).toHaveLength(1);
    await expect(
      repo.commit(
        { ...note(), body: 'Different text with reused key' },
        { mutationId: 'mutation-001', version: 0 },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repo.changes(0)).items).toHaveLength(1);
    const edited = await repo.commit(
      { ...note(), body: 'Updated research' },
      { version: 1, mutationId: 'mutation-002' },
    );
    expect(edited.version).toBe(2);
    await expect(
      repo.commit(note(), { version: 1, mutationId: 'mutation-003' }),
    ).rejects.toMatchObject({
      status: 412,
      details: { current: { version: 2 } },
    });
    expect((await repo.changes(1)).cursor).toBe(2);
    expect(await repo.history(first.id)).toHaveLength(2);
  });
  it('archives and restores as versioned changes and retains the original revisions', async () => {
    const { repo } = setup();
    await repo.commit(note(), { version: 0, mutationId: 'mutation-001' });
    await repo.commit(
      { ...note(), archived: true },
      { version: 1, mutationId: 'mutation-002' },
    );
    expect(await repo.list()).toHaveLength(0);
    expect((await repo.changes(1)).items[0].archived).toBe(true);
    await expect(
      repo.commit(note(), { version: 1, mutationId: 'mutation-003' }),
    ).rejects.toMatchObject({ status: 412 });
    await repo.commit(note(), { version: 2, mutationId: 'mutation-004' });
    expect(await repo.list()).toHaveLength(1);
  });
  it('returns a saved note even if its derived index fails', async () => {
    const { handlers, withAuth, store, repo } = setup();
    vi.spyOn(store, 'upsertDoc').mockRejectedValue(
      new Error('index unavailable'),
    );
    const result = await handlers.save(
      withAuth(
        request({ item: note(), version: 0, mutationId: 'mutation-001' }),
      ),
    );
    expect(result.status).toBe(200);
    expect(json(result).indexPending).toBe(true);
    expect((await repo.read('note-1')).version).toBe(1);
  });
  it('does not return private internal records through the item endpoint', async () => {
    const { handlers, withAuth, repo } = setup();
    await repo.commit(note(), { version: 0, mutationId: 'mutation-001' });
    expect(
      (await handlers.get(withAuth(request({}, { id: 'state' })))).status,
    ).toBe(404);
  });
  it('validates URLs, sizes, collection membership and item types', async () => {
    expect(() =>
      validateRecord({ ...note(), urls: ['javascript:alert(1)'] }),
    ).toThrow();
    expect(() =>
      validateRecord({ ...note(), body: 'a'.repeat(128 * 1024 + 1) }),
    ).toThrow();
    expect(() => validateRecord({ ...note(), type: 'content' })).toThrow();
    expect(
      validateRecord({
        ...note(),
        properties: { aliases: ['State'], theme: 'infrastructure' },
      }).properties.aliases,
    ).toEqual(['State']);
    expect(() =>
      validateRecord({
        ...note(),
        properties: JSON.parse('{"__proto__":{"admin":true}}'),
      }),
    ).toThrow();
    const { handlers, withAuth } = setup();
    const response = await handlers.save(
      withAuth(
        request({
          item: { ...note(), collections: ['missing'] },
          version: 0,
          mutationId: 'mutation-001',
        }),
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe('source projections and retrieval', () => {
  it('projects caption-only social posts and structured newsletter/dialogue text without subscriber fields', () => {
    expect(
      referenceOf('social_posts', {
        id: 'post',
        caption: 'Terraform tips for this week',
      }),
    ).toMatchObject({
      title: 'Terraform tips for this week',
      body: 'Terraform tips for this week',
    });
    const issue = referenceOf('newsletters', {
      id: 'issue',
      subject: 'Infrastructure week',
      intro: 'Welcome',
      sections: [
        {
          title: 'Azure',
          items: [{ title: 'Terraform', summary: 'State recovery' }],
        },
      ],
      recipients: ['private@example.test'],
    });
    expect(issue.body).toContain('State recovery');
    expect(JSON.stringify(issue)).not.toContain('private@example.test');
    expect(
      referenceOf('podcast_transcripts', {
        id: 'episode',
        title: 'State',
        transcript: [{ speaker: 'Host', text: 'Keep backups.' }],
      }).body,
    ).toContain('Host: Keep backups.');
    expect(
      referenceOf('subscribers', { id: 'person', title: 'Never index this' }),
    ).toBeNull();
  });
  it('rechecks live sources and never returns stale deleted or archived text', async () => {
    const { repo, store } = setup();
    const sources = createSourceService(repo);
    await store.createDoc('content', {
      id: 'article',
      title: 'Terraform article',
      Content: 'Terraform planning',
      type: 'blog',
    });
    const id = sourceKey('content', 'article');
    const indexer = createBrainIndexer(repo);
    await indexer.start();
    for (let i = 0; i < 12; i++) if (!(await indexer.step())) break;
    expect(
      (await sources.search({ q: 'terraform' })).items.some((r) => r.id === id),
    ).toBe(true);
    await store.upsertDoc('content', {
      id: 'article',
      title: 'Terraform article',
      Content: 'secret obsolete text',
      deleted: true,
    });
    expect((await sources.search({ q: 'terraform' })).items).toEqual([]);
    expect(await sources.get(id)).toBeNull();
  });
  it('provides backlinks and keeps provenance outside public content records', async () => {
    const { repo, store, handlers, withAuth } = setup();
    await repo.commit(note(), { version: 0, mutationId: 'mutation-001' });
    const req = withAuth(
      request(
        {
          fields: {
            title: 'Terraform article',
            body: 'Reviewed outline',
            tags: ['terraform'],
          },
          requestId: 'draft-request-1',
        },
        { id: 'note-1' },
      ),
    );
    const first = await handlers.draft(req);
    expect(first.status).toBe(200);
    const second = await handlers.draft(req);
    expect(json(first).id).toBe(json(second).id);
    await repo.commit(
      { ...note(), body: 'Later private research' },
      { version: 1, mutationId: 'mutation-002' },
    );
    await handlers.draft(req);
    expect((await repo.read(`provenance_${json(first).id}`)).noteVersion).toBe(
      1,
    );
    const doc = await store.readDoc('content', json(first).id);
    expect(doc.contentStatus).toBe('drafting');
    expect(doc.Live).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('note-1');
    const ctx = await handlers.context(
      withAuth(request({}, {}, `contentId=${doc.id}`)),
    );
    expect(json(ctx).items[0].id).toBe('note-1');
  });
  it('does not let an assistant fabricate citation ids', async () => {
    const sources = { search: async () => ({ items: [note()], cursor: null }) };
    const ai = {
      generateJsonResponse: vi.fn(async () => ({
        insufficientEvidence: false,
        claims: [{ text: 'Claim', sourceIds: ['S999'] }],
        suggestions: [],
      })),
    };
    await expect(
      askBrain({ sources, ai, question: 'Terraform' }),
    ).rejects.toMatchObject({ status: 502 });
    const call = ai.generateJsonResponse.mock.calls[0][0];
    expect(call.feature).toBe('brainAssistant');
    expect(call.systemPrompt).toContain('untrusted evidence');
  });
  it('returns insufficient evidence without spending on an empty retrieval', async () => {
    const ai = { generateJsonResponse: vi.fn() };
    const answer = await askBrain({
      sources: { search: async () => ({ items: [], cursor: null }) },
      ai,
      question: 'Missing topic',
    });
    expect(answer.insufficientEvidence).toBe(true);
    expect(ai.generateJsonResponse).not.toHaveBeenCalled();
  });
  it('uses the selected item and its real connections as context for a question', async () => {
    const sources = {
      contextItems: vi.fn(async () => [note()]),
      search: async () => ({ items: [], cursor: null }),
    };
    const ai = {
      generateJsonResponse: vi.fn(async () => ({
        insufficientEvidence: false,
        claims: [{ text: 'State is covered.', sourceIds: ['S1'] }],
        suggestions: [],
      })),
    };
    const result = await askBrain({
      sources,
      ai,
      contextId: 'note-1',
      question: 'Outline this series',
    });
    expect(sources.contextItems).toHaveBeenCalledWith('note-1');
    expect(result.sources[0].id).toBe('note-1');
  });
});
