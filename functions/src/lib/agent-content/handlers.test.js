/**
 * The Agent Content API's routes (handlers.js, ADR 0037) over an in-memory
 * store with the real client's conditional writes: each route reaches the key
 * guard with its own capability and nothing else; a draft Koda writes is a
 * Drafts-stage document with Koda's identity and the agent origin; the body's
 * origin cannot override it; the published reads answer only public documents;
 * and the status route describes the key without revealing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { AGENT_DEFAULT_IDEA_ORIGIN, ENDPOINTS, createAgentContentHandlers } from './handlers.js';
import { AGENT_USER, CAPABILITY_IDS, buildKeyRecord, generateKey } from './keys.js';
import { LIST_QUERY } from '../cms/drafts-handlers.js';
import { DRAFTS_STAGE_STATUS } from '../cms/drafts.js';
import { isPublicDocument } from '../public-reads.js';
import { resolveContentTaxonomy } from '../cms/taxonomy.js';

const SECRET = generateKey();
const RECORD = buildKeyRecord({ secret: SECRET, actor: 'owner@hcw.dev', now: () => new Date('2026-10-01T00:00:00.000Z') });
const KODA = { ...AGENT_USER, keyHint: RECORD.keyHint };
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const FIELDS = Object.freeze({
  title: 'The landing zone is now a conversation',
  subtitle: 'What changes when the platform talks back.',
  date: '2026-11-04',
  track: 'how-to',
  part: '1 of 3',
  tags: ['azure', 'landing-zone'],
  reading: 7,
  body: '## One\n\nBody text.',
});

const request = ({ id, body, query = {}, slugOrId } = {}) => ({
  params: { ...(id === undefined ? {} : { id }), ...(slugOrId === undefined ? {} : { slugOrId }) },
  query: new Map(Object.entries(query)),
  headers: { get: (name) => (name.toLowerCase() === 'user-agent' ? 'muse-connector' : null) },
  json: async () => body,
});
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });
const failure = (code, message) => Object.assign(new Error(message), { code });

/** A guard that grants every capability it is asked for, recording which. */
function allowingGuard(record = RECORD) {
  const asked = [];
  const pass = { record, user: KODA, error: null };
  return {
    asked,
    authenticate: vi.fn(async () => pass),
    requireCapability: vi.fn(async (req, capability) => {
      asked.push(capability);
      return pass;
    }),
    asRoleGuard: (capability) => ({
      requireRole: vi.fn(async () => {
        asked.push(capability);
        return { user: KODA, role: 'editor', error: null };
      }),
    }),
  };
}

function refusingGuard() {
  const refusal = { status: 401, headers: {}, body: JSON.stringify({ ok: false, code: 'UNAUTHENTICATED' }) };
  return {
    authenticate: vi.fn(async () => ({ record: null, user: null, error: refusal })),
    requireCapability: vi.fn(async () => ({ record: null, user: null, error: refusal })),
    asRoleGuard: () => ({ requireRole: vi.fn(async () => ({ user: null, role: null, error: refusal })) }),
  };
}

function memoryStore(seed = []) {
  let etag = 1;
  const nextEtag = () => `"e${etag++}"`;
  const docs = new Map(seed.map((doc) => [doc.id, { _etag: nextEtag(), ...doc }]));
  const audits = [];
  const query = async (container, text, parameters = []) => {
    if (container !== 'content') throw new Error(`unexpected container ${container}`);
    const param = (name) => parameters.find((p) => p.name === name)?.value;
    const all = [...docs.values()].map((doc) => structuredClone(doc));
    if (text === LIST_QUERY) {
      return all.filter(
        (doc) => doc.contentStatus === param('@drafting') || doc.draftOrigin !== undefined || doc.repoPath !== undefined,
      );
    }
    if (text.includes('c.normalizedTitle = @title')) {
      return all.filter((doc) => doc.normalizedTitle === param('@title'));
    }
    // The public reads' queries: every row, unfiltered, so the test below
    // proves the handler's own re-filter (public-reads.js isPublicDocument)
    // and not this store.
    if (text.includes('SELECT')) return all;
    throw new Error(`unexpected query ${text}`);
  };
  return {
    docs,
    audits,
    queryDocs: vi.fn(query),
    readDoc: vi.fn(async (container, id) => (docs.has(id) ? structuredClone(docs.get(id)) : null)),
    createDoc: vi.fn(async (container, doc) => {
      if (docs.has(doc.id)) throw failure(409, 'Conflict');
      const stored = { ...structuredClone(doc), _etag: nextEtag() };
      docs.set(doc.id, stored);
      return structuredClone(stored);
    }),
    patchDoc: vi.fn(async (container, id, updates, options = {}) => {
      const doc = docs.get(id);
      if (!doc) throw failure(404, 'missing');
      if (options.ifMatch && options.ifMatch !== doc._etag) throw failure(412, 'changed');
      const next = { ...doc, _etag: nextEtag() };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      docs.set(id, next);
      return structuredClone(next);
    }),
    deleteDocIfMatch: vi.fn(async (container, id, ifMatch) => {
      const doc = docs.get(id);
      if (!doc) throw failure(404, 'missing');
      if (ifMatch !== doc._etag) throw failure(412, 'changed');
      docs.delete(id);
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      if (!['admin_audit_logs', 'audits'].includes(container)) {
        throw new Error(`upsertDoc on ${container}: the agent routes must not replace documents`);
      }
      audits.push({ container, ...doc });
      return doc;
    }),
  };
}

function setup({ seed = [], guard = allowingGuard() } = {}) {
  const store = memoryStore(seed);
  let n = 0;
  const handlers = createAgentContentHandlers({
    guard,
    store,
    publicStore: store,
    onContentDeleted: vi.fn(async () => ({})),
    now: () => new Date('2026-10-31T12:00:00.000Z'),
    uuid: () => `id-${++n}`,
    log: context,
  });
  return { handlers, store, guard };
}

const PUBLISHED = Object.freeze({
  id: 'live-1',
  Title: 'A published article',
  title: 'A published article',
  slug: 'a-published-article',
  type: 'blog',
  contentStatus: 'published',
  Live: true,
  Status: 'Live',
  postContent: 'Live body.',
  publishedAt: '2026-10-01T00:00:00.000Z',
});

describe('every route reaches the key guard with its own capability', () => {
  const CASES = [
    ['listDrafts', {}, 'drafts.read'],
    ['getDraft', { id: 'x' }, 'drafts.read'],
    ['createDraft', { body: { fields: FIELDS } }, 'drafts.write'],
    ['createDraftFromMarkdown', { body: { markdown: '---\ntitle: T\n---\nbody' } }, 'drafts.write'],
    ['saveDraft', { id: 'x', body: { fields: FIELDS, etag: '"e1"' } }, 'drafts.write'],
    ['sendToReview', { id: 'x', body: { etag: '"e1"' } }, 'drafts.review'],
    ['backToDrafts', { id: 'x', body: { etag: '"e1"' } }, 'drafts.review'],
    ['deleteDraft', { id: 'x', body: { etag: '"e1"' } }, 'drafts.delete'],
    ['listPublished', {}, 'published.read'],
    ['getPublished', { slugOrId: 'x' }, 'published.read'],
  ];

  it.each(CASES)('%s asks for %j → %s', async (name, req, capability) => {
    const { handlers, guard } = setup();
    await handlers[name](request(req), context);
    expect(guard.asked).toEqual([capability]);
  });

  it.each(CASES)('%s answers the guard’s refusal and reads nothing', async (name, req) => {
    const { handlers, store } = setup({ guard: refusingGuard() });
    const res = await handlers[name](request(req), context);
    expect(res.status).toBe(401);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('the endpoint list names every route and the capability it needs', () => {
    const named = new Set(ENDPOINTS.map(([method, path]) => `${method} ${path}`));
    expect(named.size).toBe(ENDPOINTS.length);
    const capabilities = new Set(ENDPOINTS.map(([, , capability]) => capability).filter(Boolean));
    expect([...capabilities].sort()).toEqual([...CAPABILITY_IDS].sort());
  });
});

describe('a draft Koda writes', () => {
  it('is a Drafts-stage document with Koda’s identity, the agent origin and the AI idea origin', async () => {
    const { handlers, store } = setup();
    const res = parse(await handlers.createDraft(request({ body: { fields: FIELDS } }), context));
    expect(res.status).toBe(201);
    const doc = store.docs.get(res.body.draft.id);
    expect(doc.contentStatus).toBe(DRAFTS_STAGE_STATUS);
    expect(doc.Live).toBe(false);
    expect(doc.draftOrigin).toBe('agent');
    expect(doc.createdBy).toBe('koda (agent)');
    expect(doc.updatedBy).toBe('koda (agent)');
    expect(doc.ideaOrigin).toBe(AGENT_DEFAULT_IDEA_ORIGIN);
    expect(isPublicDocument(doc)).toBe(false);
    expect(res.body.draft.origin).toBe('agent');
    const audit = store.audits.find((row) => row.action === 'content_draft_created');
    expect(audit.userId).toBe('agent:koda');
    expect(audit.userAgent).toBe('muse-connector');
  });

  it('keeps an idea origin Koda names', async () => {
    const { handlers, store } = setup();
    const res = parse(
      await handlers.createDraft(request({ body: { fields: { ...FIELDS, ideaOrigin: 'content-gap' } } }), context),
    );
    expect(store.docs.get(res.body.draft.id).ideaOrigin).toBe('content-gap');
  });

  it('cannot set a slug, a status or anything outside the editor fields', async () => {
    const { handlers } = setup();
    const res = parse(
      await handlers.createDraft(
        request({ body: { fields: { ...FIELDS, slug: 'mine', contentStatus: 'published', Live: true } } }),
        context,
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Not a draft field');
  });

  it('from markdown is written with the agent origin whatever the body says, and once per title', async () => {
    const { handlers, store } = setup();
    const markdown = [
      '---',
      `title: ${FIELDS.title}`,
      `subtitle: ${FIELDS.subtitle}`,
      'date: 2026-11-04',
      'track: how-to',
      'part: 1 of 3',
      'tags: azure, landing-zone',
      'reading: 7',
      '---',
      '',
      '## One',
      '',
      'Body text.',
    ].join('\n');
    const first = parse(
      await handlers.createDraftFromMarkdown(request({ body: { markdown, origin: 'vault' } }), context),
    );
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe('created');
    const doc = store.docs.get(first.body.contentId);
    expect(doc.draftOrigin).toBe('agent');
    expect(doc.createdBy).toBe('koda (agent)');
    expect(doc.ideaOrigin).toBe(AGENT_DEFAULT_IDEA_ORIGIN);
    // No origin at all is fine too: it is not the caller's to choose.
    const again = parse(await handlers.createDraftFromMarkdown(request({ body: { markdown } }), context));
    expect(again.status).toBe(200);
    expect(again.body.code).toBe('ALREADY_IMPORTED');
    expect(again.body.contentId).toBe(first.body.contentId);
    expect(store.docs.size).toBe(1);
  });

  it('round-trips: list, read, save under the etag, send to review, back, delete', async () => {
    const { handlers, store } = setup();
    const made = parse(await handlers.createDraft(request({ body: { fields: FIELDS } }), context)).body.draft;

    const list = parse(await handlers.listDrafts(request(), context));
    expect(list.body.drafts.map((d) => d.id)).toEqual([made.id]);

    const read = parse(await handlers.getDraft(request({ id: made.id }), context));
    expect(read.body.draft.fields.body).toBe(FIELDS.body);

    const stale = parse(
      await handlers.saveDraft(
        request({ id: made.id, body: { fields: { ...FIELDS, title: 'Renamed' }, etag: '"never"' } }),
        context,
      ),
    );
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('CONFLICT');

    const saved = parse(
      await handlers.saveDraft(
        request({ id: made.id, body: { fields: { ...FIELDS, title: 'Renamed' }, etag: read.body.draft.etag } }),
        context,
      ),
    );
    expect(saved.status).toBe(200);
    expect(store.docs.get(made.id).updatedBy).toBe('koda (agent)');

    const sent = parse(
      await handlers.sendToReview(request({ id: made.id, body: { etag: saved.body.draft.etag } }), context),
    );
    expect(sent.status).toBe(200);
    expect(store.docs.get(made.id).contentStatus).toBe('in_review');

    const back = parse(
      await handlers.backToDrafts(request({ id: made.id, body: { etag: sent.body.draft.etag } }), context),
    );
    expect(back.status).toBe(200);
    expect(store.docs.get(made.id).contentStatus).toBe(DRAFTS_STAGE_STATUS);

    const gone = await handlers.deleteDraft(request({ id: made.id, body: { etag: back.body.draft.etag } }), context);
    expect(gone.status).toBe(200);
    expect(store.docs.has(made.id)).toBe(false);
  });

  it('cannot save, move or delete anything live', async () => {
    const { handlers, store } = setup({ seed: [{ ...PUBLISHED, draftOrigin: 'drafts' }] });
    const etag = store.docs.get('live-1')._etag;
    const saved = parse(await handlers.saveDraft(request({ id: 'live-1', body: { fields: FIELDS, etag } }), context));
    const deleted = parse(await handlers.deleteDraft(request({ id: 'live-1', body: { etag } }), context));
    const sent = parse(await handlers.sendToReview(request({ id: 'live-1', body: { etag } }), context));
    for (const res of [saved, deleted, sent]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(store.docs.get('live-1').Live).toBe(true);
    expect(store.docs.get('live-1').postContent).toBe('Live body.');
  });
});

describe('the published reads', () => {
  it('answer only public documents, through the public reads’ own handlers', async () => {
    const { handlers } = setup({
      seed: [PUBLISHED, { id: 'd1', Title: 'Draft', contentStatus: DRAFTS_STAGE_STATUS, Live: false, draftOrigin: 'agent' }],
    });
    const list = parse(await handlers.listPublished(request({ query: { type: 'blog' } }), context));
    expect(list.status).toBe(200);
    const ids = JSON.stringify(list.body);
    expect(ids).toContain('live-1');
    expect(ids).not.toContain('"d1"');
  });
});

describe('the default idea origin', () => {
  it('falls back to the stage’s own default when the owner has disabled ai-recommendation', async () => {
    const { handlers, store } = setup();
    // The stored taxonomy document with the AI origin switched off: the
    // defaults (every id is required to be present) with one flag flipped;
    // the validator reads it through the same store (taxonomy-fields.js).
    const defaults = await resolveContentTaxonomy({ readDoc: async () => null });
    const taxonomy = {
      ...defaults,
      ideaOrigins: defaults.ideaOrigins.map((o) =>
        o.id === 'ai-recommendation' ? { ...o, enabled: false } : o,
      ),
    };
    const readDoc = store.readDoc.getMockImplementation();
    store.readDoc.mockImplementation(async (container, id, pk) =>
      container === 'content' ? readDoc(container, id, pk) : structuredClone(taxonomy),
    );
    const res = parse(await handlers.createDraft(request({ body: { fields: FIELDS } }), context));
    expect(res.status).toBe(201);
    const doc = store.docs.get(res.body.draft.id);
    expect(doc.ideaOrigin).not.toBe('ai-recommendation');
    expect(doc.draftOrigin).toBe('agent');
  });
});

describe('a store fault inside the guard', () => {
  it('is the content-free 500, not a throw into the host', async () => {
    const guard = {
      authenticate: vi.fn(async () => {
        throw Object.assign(new Error('cosmos is down: account key xyz'), { code: 503 });
      }),
      requireCapability: vi.fn(async () => {
        throw Object.assign(new Error('cosmos is down: account key xyz'), { code: 503 });
      }),
      asRoleGuard: () => ({ requireRole: vi.fn(async () => ({ user: KODA, role: 'editor', error: null })) }),
    };
    const { handlers } = setup({ guard });
    for (const name of ['status', 'listPublished']) {
      const res = await handlers[name](request(), context);
      expect(res.status).toBe(500);
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.body).not.toContain('account key');
    }
  });
});

describe('the status route', () => {
  it('describes the key without revealing it', async () => {
    const off = { ...RECORD, capabilities: { ...RECORD.capabilities, 'drafts.delete': false } };
    const { handlers } = setup({ guard: allowingGuard(off) });
    const res = parse(await handlers.status(request(), context));
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe('koda');
    expect(res.body.keyHint).toBe(RECORD.keyHint);
    expect(res.body.capabilities).toEqual(CAPABILITY_IDS.filter((id) => id !== 'drafts.delete'));
    expect(res.body.limits.requestsPerMinute).toBe(120);
    expect(res.body.basePath).toBe('/api/agent-content/v1');
    expect(res.body.endpoints).toHaveLength(ENDPOINTS.length);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(RECORD.keyHash);
  });

  it('answers the guard’s refusal', async () => {
    const { handlers } = setup({ guard: refusingGuard() });
    expect((await handlers.status(request(), context)).status).toBe(401);
  });
});
