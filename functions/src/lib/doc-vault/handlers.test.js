/**
 * The routes behind /admin/doc-vault (handlers.js), against an in-memory store
 * with the real client's conditional writes (test/doc-vault-store.js).
 *
 * Pinned, in the order the owner asked for it: the publisher role on every
 * route; create (paste), upload, get, update, restore a version, delete (to
 * Trash, then for good); a second document with the same title and category
 * is a new version, never a duplicate; ten versions are kept; two tabs cannot
 * overwrite each other; and no text, title, tag or link reaches a log line, an
 * audit row or an error.
 */
import { describe, it, expect, vi } from 'vitest';
import { vaultStore, failure } from '../../../test/doc-vault-store.js';
import {
  MAX_LISTED_DOCUMENTS,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  createDocVaultHandlers,
} from './handlers.js';
import { KEPT_VERSIONS, MAX_BODY_BYTES, TRASH_DAYS, vaultDocumentId } from './model.js';

const USER = { oid: 'admin-oid-1', sub: 'sub-1', email: 'owner@hcw.dev', name: 'The Owner' };
const NOW = new Date('2026-10-26T12:00:00.000Z');
/** The id salt every setup() starts with: fixed, so ids are the same in every run. */
const SALT = 's'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const makeContext = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const allowGuard = (role = 'publisher') => ({
  requireRole: vi.fn(async () => ({ user: USER, role, error: null })),
});
const denyGuard = (status) => ({
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status, headers: {}, body: JSON.stringify({ ok: false, error: 'refused' }) },
  })),
});

const request = ({ id, version, body, query = {} } = {}) => ({
  params: {
    ...(id === undefined ? {} : { id }),
    ...(version === undefined ? {} : { version }),
  },
  query: { get: (name) => query[name] ?? null },
  headers: { get: () => 'vitest' },
  json: async () => body,
});

/** A request whose body arrives as a stream, as the Functions host delivers one. */
const streamed = (text, headers = {}) => ({
  params: {},
  query: { get: () => null },
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }),
  json: async () => {
    throw new Error('a streamed body must not be read with json()');
  },
});

const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });

let clock;
let ids;
function setup({ guard = allowGuard(), seed = [] } = {}) {
  clock = NOW.getTime();
  ids = 0;
  const store = vaultStore(seed);
  const context = makeContext();
  const handlers = createDocVaultHandlers({
    guard,
    store,
    now: () => new Date(clock),
    uuid: () => `generated-${++ids}`,
    newSalt: () => SALT,
  });
  const call = async (name, req) => parse(await handlers[name](req, context));
  return { handlers, store, guard, context, call };
}
const tick = (ms = 60_000) => {
  clock += ms;
};

const FIELDS = Object.freeze({
  title: 'Cover letter',
  category: 'Letter',
  tags: ['outreach'],
  body: 'Dear team,\n\nFirst draft.',
  relatedLink: 'https://example.com/role',
});

const paste = (call, fields = FIELDS) => call('create', request({ body: { fields } }));
const upload = (call, filename, text, extra = {}) =>
  call('upload', request({ body: { filename, text, ...extra } }));

describe('the guard', () => {
  const NAMES = ['list', 'create', 'upload', 'get', 'update', 'remove', 'untrash', 'getVersion', 'restoreVersion'];

  it.each(NAMES)('%s needs the publisher role, and a refusal is the answer', async (name) => {
    for (const status of [401, 403]) {
      const { handlers, store, guard } = setup({ guard: denyGuard(status) });
      const res = await handlers[name](request({ id: 'x', version: '1', body: { etag: 'e', fields: FIELDS } }), makeContext());
      expect(res.status).toBe(status);
      expect(guard.requireRole).toHaveBeenCalledTimes(1);
      expect(guard.requireRole.mock.calls[0][1]).toBe('publisher');
      expect(store.touched.size, `${name} touched the store behind a ${status}`).toBe(0);
    }
  });

  it('has exactly the nine routes', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual([...NAMES].sort());
  });
});

describe('create (paste)', () => {
  it('writes version 1 as the pasted source, by the admin id alone, and answers 201 with the text', async () => {
    const { call, store } = setup();
    const res = await paste(call);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      outcome: 'created',
      document: { title: 'Cover letter', category: 'Letter', version: 1, source: 'pasted', body: FIELDS.body },
    });
    const stored = store.get(res.body.document.id);
    expect(stored).toMatchObject({
      docType: 'document',
      version: 1,
      createdBy: 'admin-oid-1',
      updatedBy: 'admin-oid-1',
      deletedAt: null,
      dedupeKey: 'letter|cover letter',
      createdAt: NOW.toISOString(),
    });
    expect(store.dump()).not.toContain('owner@hcw.dev');
    expect(store.dump()).not.toContain('The Owner');
    expect(res.body.document.id).toBe(vaultDocumentId('letter|cover letter', SALT));
  });

  it('touches only the vault and the audit container', async () => {
    const { call, store } = setup();
    await paste(call);
    await call('list', request());
    expect([...store.touched].sort()).toEqual(['admin_audit_logs', 'doc_vault']);
  });

  it('refuses a request without fields, with a field a document does not have, and with a bad value', async () => {
    const { call, store } = setup();
    expect((await call('create', request({ body: {} }))).status).toBe(400);
    expect((await call('create', request({ body: { fields: { ...FIELDS, Live: true } } }))).body.code).toBe('INVALID');
    expect((await call('create', request({ body: { fields: { ...FIELDS, category: 'Poem' } } }))).status).toBe(400);
    expect((await call('create', request({ body: { fields: { ...FIELDS, body: '' } } }))).status).toBe(400);
    expect(store.docs.size).toBe(0);
  });

  it('cannot be made to set a privileged field by a hostile JSON body', async () => {
    const { call, store } = setup();
    const hostile = JSON.parse(
      JSON.stringify({ fields: FIELDS }).replace(
        '"fields":{',
        '"__proto__":{"isAdmin":true},"fields":{'
      )
    );
    // The top-level __proto__ key is ignored (only `fields` is read); inside
    // `fields` any other key is refused.
    expect((await call('create', request({ body: hostile }))).status).toBe(201);
    expect({}.isAdmin).toBeUndefined();
    for (const key of ['id', 'version', 'createdBy', 'deletedAt', 'docType', 'contentStatus', 'Live', 'slug', 'partitionKey', 'ttl']) {
      const res = await call('create', request({ body: { fields: { ...FIELDS, title: `Other ${key}`, [key]: 'forged' } } }));
      expect(res.status, key).toBe(400);
    }
    expect(store.documents()).toHaveLength(1);
    expect(store.dump()).not.toContain('forged');
  });

  it('answers 413 for an oversize body, counted as it is read, without parsing it', async () => {
    const { handlers, store, context } = setup();
    const big = JSON.stringify({ fields: { ...FIELDS, body: 'x'.repeat(MAX_REQUEST_BYTES) } });
    const res = parse(await handlers.create(streamed(big), context));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TOO_LARGE');
    expect(store.touched.size).toBe(0);
  });

  it('refuses a declared Content-Length over the cap before reading anything', async () => {
    const { handlers } = setup();
    const req = streamed('{}', { 'content-length': String(MAX_REQUEST_BYTES + 1) });
    const reader = vi.spyOn(req.body, 'getReader');
    const res = parse(await handlers.create(req, makeContext()));
    expect(res.status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads a streamed body that is within the cap, and takes unparseable JSON as no fields', async () => {
    const { handlers } = setup();
    const ok = parse(await handlers.create(streamed(JSON.stringify({ fields: FIELDS })), makeContext()));
    expect(ok.status).toBe(201);
    const bad = parse(await handlers.create(streamed('{not json'), makeContext()));
    expect(bad.status).toBe(400);
    const array = parse(await handlers.create(streamed('[1,2]'), makeContext()));
    expect(array.status).toBe(400);
  });
});

describe('a second document with the same title and category is a new version, not a duplicate', () => {
  it('versions it, archiving the old text first, and keeps one document', async () => {
    const { call, store } = setup();
    const first = (await paste(call)).body.document;
    tick();
    const second = await paste(call, { ...FIELDS, body: 'Second draft.' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ outcome: 'versioned', document: { id: first.id, version: 2, body: 'Second draft.' } });
    const documents = [...store.docs.values()].filter((d) => d.docType === 'document');
    const versions = [...store.docs.values()].filter((d) => d.docType === 'version');
    expect(documents).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: `${first.id}~v1`,
      documentId: first.id,
      version: 1,
      body: FIELDS.body,
      savedAt: NOW.toISOString(),
    });
    expect(documents[0].createdAt).toBe(NOW.toISOString());
    expect(documents[0].updatedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  it('treats a title that differs only in case, spacing, accents or punctuation as the same', async () => {
    const { call, store } = setup();
    await paste(call, { ...FIELDS, title: 'Résumé — Outreach' });
    for (const [n, title] of ['RESUME outreach', '  resume   OUTREACH!! '].entries()) {
      const res = await paste(call, { ...FIELDS, title, body: `edit ${n}` });
      expect(res.body.outcome).toBe('versioned');
    }
    expect([...store.docs.values()].filter((d) => d.docType === 'document')).toHaveLength(1);
  });

  it('makes a separate document in another category', async () => {
    const { call, store } = setup();
    await paste(call);
    const other = await paste(call, { ...FIELDS, category: 'Template' });
    expect(other.status).toBe(201);
    expect([...store.docs.values()].filter((d) => d.docType === 'document')).toHaveLength(2);
  });

  it('writes nothing when the content is identical', async () => {
    const { call, store } = setup();
    await paste(call);
    store.replaceDocIfMatch.mockClear();
    store.upsertDoc.mockClear();
    const again = await paste(call);
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('unchanged');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect([...store.docs.values()].filter((d) => d.docType === 'version')).toHaveLength(0);
  });

  it('keeps the newest ten versions, the current one included, and removes the rest', async () => {
    const { call, store } = setup();
    let id;
    for (let n = 1; n <= 13; n += 1) {
      const res = await paste(call, { ...FIELDS, body: `draft ${n}` });
      id = res.body.document.id;
      tick();
    }
    const stored = [...store.docs.values()].filter((d) => d.docType === 'version').map((d) => d.version).sort((a, b) => a - b);
    expect(stored).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(stored.length + 1).toBe(KEPT_VERSIONS);
    const view = await call('get', request({ id }));
    expect(view.body.document.version).toBe(13);
    expect(view.body.versions.map((v) => v.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('survives a failed prune: the version outside the window is neither listed nor readable', async () => {
    const { call, store } = setup();
    let id;
    for (let n = 1; n <= 3; n += 1) {
      id = (await paste(call, { ...FIELDS, body: `draft ${n}` })).body.document.id;
    }
    store.fail('deleteDoc', failure(500), { times: 100 });
    for (let n = 4; n <= 12; n += 1) await paste(call, { ...FIELDS, body: `draft ${n}` });
    expect(store.get(`${id}~v1`)).not.toBeNull();
    const view = await call('get', request({ id }));
    expect(view.body.versions.map((v) => v.version)).not.toContain(1);
    expect((await call('getVersion', request({ id, version: '1' }))).status).toBe(404);
  });

  it('settles two simultaneous pastes of one document on one document', async () => {
    const { call, store } = setup();
    const [a, b] = await Promise.all([paste(call), paste(call)]);
    expect([a.body.outcome, b.body.outcome].sort()).toEqual(['created', 'unchanged']);
    expect([...store.docs.values()].filter((d) => d.docType === 'document')).toHaveLength(1);
  });

  it('uses a fresh id when the derived one belongs to a document since renamed', async () => {
    const { call, store } = setup();
    const first = (await paste(call)).body.document;
    const put = await call('update', request({ id: first.id, body: { etag: first.etag, fields: { ...FIELDS, title: 'Renamed letter' } } }));
    expect(put.status).toBe(200);
    const again = await paste(call);
    expect(again.status).toBe(201);
    expect(again.body.document.id).not.toBe(first.id);
    expect(again.body.document.id).toBe('generated-3');
    expect([...store.docs.values()].filter((d) => d.docType === 'document')).toHaveLength(2);
  });

  it('retries once when it loses a race to another write, and says conflict if it loses twice', async () => {
    const once = setup();
    await paste(once.call);
    once.store.fail('replaceDocIfMatch', failure(412));
    expect((await paste(once.call, { ...FIELDS, body: 'x' })).body.outcome).toBe('versioned');

    const twice = setup();
    await paste(twice.call);
    twice.store.fail('replaceDocIfMatch', failure(412), { times: 2 });
    const res = await paste(twice.call, { ...FIELDS, body: 'x' });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('CONFLICT');
  });
});

describe('list', () => {
  async function seeded() {
    const s = setup();
    const rows = [
      { title: 'Cover letter', category: 'Letter', tags: ['outreach', 'mvp'] },
      { title: 'MVP application', category: 'Application', tags: ['mvp'] },
      { title: 'Notes on Azure', category: 'Notes', tags: ['azure'] },
      { title: 'Template: thank you', category: 'Template', tags: [] },
    ];
    for (const row of rows) {
      await paste(s.call, { ...FIELDS, ...row, body: `SECRET text of ${row.title}` });
      tick();
    }
    return s;
  }

  it('returns metadata only, newest first, with counts and tags', async () => {
    const { call } = await seeded();
    const res = await call('list', request());
    expect(res.status).toBe(200);
    expect(res.body.documents.map((d) => d.title)).toEqual([
      'Template: thank you',
      'Notes on Azure',
      'MVP application',
      'Cover letter',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    for (const row of res.body.documents) expect(row).not.toHaveProperty('body');
    expect(res.body).toMatchObject({
      view: 'active',
      total: 4,
      matching: 4,
      truncated: false,
      counts: { Template: 1, Application: 1, Letter: 1, Notes: 1, Reference: 0, Other: 0 },
    });
    expect(res.body.tags[0]).toEqual({ tag: 'mvp', count: 2 });
  });

  it('searches title, tag and category, without regard to case', async () => {
    const { call } = await seeded();
    const titles = async (query) => (await call('list', request({ query }))).body.documents.map((d) => d.title);
    expect(await titles({ q: 'AZURE' })).toEqual(['Notes on Azure']);
    expect(await titles({ q: 'applic' })).toEqual(['MVP application']);
    expect(await titles({ q: 'letter' })).toEqual(['Cover letter']);
    expect(await titles({ q: 'nothing like it' })).toEqual([]);
    expect(await titles({ category: 'notes' })).toEqual(['Notes on Azure']);
    expect(await titles({ tag: 'MVP' })).toEqual(['MVP application', 'Cover letter']);
    expect(await titles({ tag: 'mv' })).toEqual([]);
    expect(await titles({ category: 'Letter', tag: 'outreach', q: 'cover' })).toEqual(['Cover letter']);
  });

  it('counts the whole view, not just the matches', async () => {
    const { call } = await seeded();
    const res = await call('list', request({ query: { category: 'Notes' } }));
    expect(res.body.matching).toBe(1);
    expect(res.body.total).toBe(4);
    expect(res.body.counts.Letter).toBe(1);
  });

  it('refuses a filter that cannot be right', async () => {
    const { call } = setup();
    for (const query of [{ view: 'all' }, { category: 'Poem' }, { q: 'x'.repeat(201) }, { tag: 'x'.repeat(41) }]) {
      expect((await call('list', request({ query }))).status, JSON.stringify(query)).toBe(400);
    }
  });

  it('is bounded: a vault past the limit says so', async () => {
    const seed = Array.from({ length: MAX_LISTED_DOCUMENTS + 3 }, (_, n) => ({
      id: `seed-${n}`,
      docType: 'document',
      title: `Doc ${n}`,
      category: 'Other',
      tags: [],
      source: 'pasted',
      version: 1,
      bodyBytes: 1,
      body: 'x',
      dedupeKey: `other|doc ${n}`,
      createdAt: NOW.toISOString(),
      updatedAt: new Date(NOW.getTime() + n).toISOString(),
      deletedAt: null,
    }));
    const { call } = setup({ seed });
    const res = await call('list', request());
    expect(res.body.documents).toHaveLength(MAX_LISTED_DOCUMENTS);
    expect(res.body.truncated).toBe(true);
    expect(res.body.limit).toBe(MAX_LISTED_DOCUMENTS);
  });

  it('never lists an earlier version as a document', async () => {
    const { call } = setup();
    await paste(call);
    await paste(call, { ...FIELDS, body: 'v2' });
    expect((await call('list', request())).body.documents).toHaveLength(1);
  });
});

describe('get', () => {
  it('returns the document with its text and the earlier versions without theirs', async () => {
    const { call } = setup();
    const { document } = (await paste(call)).body;
    tick();
    await paste(call, { ...FIELDS, body: 'SECOND TEXT' });
    const res = await call('get', request({ id: document.id }));
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ version: 2, body: 'SECOND TEXT', createdBy: 'admin-oid-1' });
    expect(res.body.versions).toEqual([
      expect.objectContaining({ version: 1, title: 'Cover letter', source: 'pasted', savedAt: NOW.toISOString() }),
    ]);
    expect(JSON.stringify(res.body.versions)).not.toContain(FIELDS.body);
  });

  it('refuses a bad id and answers 404 for a missing one and for an earlier version asked for as a document', async () => {
    const { call } = setup();
    const { document } = (await paste(call)).body;
    await paste(call, { ...FIELDS, body: 'v2' });
    expect((await call('get', request({ id: 'has space' }))).body.code).toBe('BAD_ID');
    expect((await call('get', request({ id: '../etc' }))).status).toBe(400);
    expect((await call('get', request({ id: 'missing' }))).status).toBe(404);
    expect((await call('get', request({ id: `${document.id}~v1` }))).status).toBe(400);
  });

  it('serves a document in Trash, so it can be read before it is put back', async () => {
    const { call } = setup();
    const { document } = (await paste(call)).body;
    await call('remove', request({ id: document.id, body: { etag: document.etag } }));
    const res = await call('get', request({ id: document.id }));
    expect(res.status).toBe(200);
    expect(res.body.document.deletedAt).toBe(NOW.toISOString());
    expect(res.body.document.purgeAt).toBe(new Date(NOW.getTime() + TRASH_DAYS * DAY).toISOString());
  });
});

describe('versions', () => {
  async function threeVersions() {
    const s = setup();
    const first = (await paste(s.call, { ...FIELDS, body: 'ONE', tags: ['a'] })).body.document;
    tick();
    await paste(s.call, { ...FIELDS, body: 'TWO', tags: ['b'] });
    tick();
    const third = (await paste(s.call, { ...FIELDS, body: 'THREE', tags: ['c'] })).body.document;
    return { ...s, id: first.id, current: third };
  }

  it('reads an earlier version with its text, and the current one from the document', async () => {
    const { call, id } = await threeVersions();
    const one = await call('getVersion', request({ id, version: '1' }));
    expect(one.body.version).toMatchObject({ version: 1, body: 'ONE', tags: ['a'], current: false });
    const three = await call('getVersion', request({ id, version: '3' }));
    expect(three.body.version).toMatchObject({ version: 3, body: 'THREE', current: true });
  });

  it('refuses a version that is not a whole number, is not kept, or is not this document\'s', async () => {
    const { call, id } = await threeVersions();
    for (const version of ['0', '-1', '1.5', 'abc', '']) {
      expect((await call('getVersion', request({ id, version }))).body.code, version).toBe('BAD_VERSION');
    }
    expect((await call('getVersion', request({ id, version: '4' }))).body.code).toBe('VERSION_NOT_FOUND');
    expect((await call('getVersion', request({ id: 'missing', version: '1' }))).status).toBe(404);
  });

  it('does not serve another document\'s version under this id', async () => {
    const { call, id, store } = await threeVersions();
    const other = (await paste(call, { ...FIELDS, title: 'Another one', body: 'OTHER' })).body.document;
    await paste(call, { ...FIELDS, title: 'Another one', body: 'OTHER 2' });
    // Forge a version whose documentId points elsewhere.
    store.docs.set(`${id}~v2`, { ...store.get(`${id}~v2`), documentId: other.id });
    expect((await call('getVersion', request({ id, version: '2' }))).status).toBe(404);
  });
});

describe('update (PUT)', () => {
  async function onePaste() {
    const s = setup();
    const { document } = (await paste(s.call)).body;
    return { ...s, document };
  }
  const edit = (document, over = {}, etag = document.etag) =>
    request({ id: document.id, body: { etag, fields: { ...FIELDS, ...over } } });

  it('needs the etag of the version on screen', async () => {
    const { call, document } = await onePaste();
    const res = await call('update', request({ id: document.id, body: { fields: FIELDS } }));
    expect(res.body.code).toBe('ETAG_REQUIRED');
    expect((await call('update', request({ id: document.id, body: { etag: '', fields: FIELDS } }))).status).toBe(400);
    expect((await call('update', request({ id: document.id, body: { etag: 'x'.repeat(201), fields: FIELDS } }))).status).toBe(400);
  });

  it('writes a new version and archives the old text', async () => {
    const { call, store, document } = await onePaste();
    tick();
    const res = await call('update', edit(document, { body: 'Edited', tags: ['edited'] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'versioned', document: { version: 2, body: 'Edited', source: 'pasted' } });
    expect(res.body.document.etag).not.toBe(document.etag);
    expect(store.get(`${document.id}~v1`)).toMatchObject({ body: FIELDS.body, tags: ['outreach'] });
  });

  it('refuses a stale etag with the current summary, writing nothing', async () => {
    const { call, store, document } = await onePaste();
    await call('update', edit(document, { body: 'Tab one' }));
    store.replaceDocIfMatch.mockClear();
    store.upsertDoc.mockClear();
    const res = await call('update', edit(document, { body: 'Tab two' }));
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ code: 'CONFLICT', current: { id: document.id, version: 2 } });
    expect(res.body.current).not.toHaveProperty('body');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.get(document.id).body).toBe('Tab one');
  });

  it('turns a write that loses the race into the same 412, having lost nothing', async () => {
    const { call, store, document } = await onePaste();
    store.fail('replaceDocIfMatch', failure(412));
    const res = await call('update', edit(document, { body: 'Late' }));
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('CONFLICT');
    expect(store.get(document.id).body).toBe(FIELDS.body);
  });

  it('says the document is gone when it vanished between the read and the write', async () => {
    const { call, store, document } = await onePaste();
    store.fail('replaceDocIfMatch', failure(404));
    store.docs.delete(document.id);
    const res = await call('update', edit(document, { body: 'Late' }));
    expect(res.status).toBe(404);
  });

  it('writes nothing for identical content', async () => {
    const { call, store, document } = await onePaste();
    store.replaceDocIfMatch.mockClear();
    const res = await call('update', edit(document));
    expect(res.body.outcome).toBe('unchanged');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('renames a document, keeping its id, and finds it under the new title', async () => {
    const { call, store, document } = await onePaste();
    const res = await call('update', edit(document, { title: 'Thank-you letter' }));
    expect(res.body.document).toMatchObject({ id: document.id, title: 'Thank-you letter', version: 2 });
    expect(store.get(document.id).dedupeKey).toBe('letter|thank you letter');
    const again = await paste(call, { ...FIELDS, title: 'thank you letter', body: 'Another' });
    expect(again.body).toMatchObject({ outcome: 'versioned', document: { id: document.id, version: 3 } });
  });

  it('refuses a rename onto a title and category another document holds, in the vault or in Trash', async () => {
    const { call, document } = await onePaste();
    const other = (await paste(call, { ...FIELDS, title: 'Other letter' })).body.document;
    const clash = await call('update', edit(document, { title: 'other LETTER' }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('DUPLICATE');
    await call('remove', request({ id: other.id, body: { etag: other.etag } }));
    expect((await call('update', edit(document, { title: 'Other letter' }))).body.code).toBe('DUPLICATE');
  });

  it('refuses to change a document that is in Trash', async () => {
    const { call, document } = await onePaste();
    const trashed = await call('remove', request({ id: document.id, body: { etag: document.etag } }));
    const res = await call('update', edit(document, { body: 'x' }, trashed.body.document.etag));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_TRASH');
  });

  it('refuses a missing document and fields that break the rules', async () => {
    const { call, document } = await onePaste();
    expect((await call('update', request({ id: 'missing', body: { etag: 'e', fields: FIELDS } }))).status).toBe(404);
    expect((await call('update', edit(document, { Live: true }))).status).toBe(400);
    expect((await call('update', edit(document, { category: 'Poem' }))).status).toBe(400);
  });

  it('answers 413 for an oversize body', async () => {
    const { handlers, document } = await onePaste();
    const req = streamed(JSON.stringify({ etag: document.etag, fields: { ...FIELDS, body: 'x'.repeat(MAX_REQUEST_BYTES) } }));
    req.params = { id: document.id };
    expect(parse(await handlers.update(req, makeContext())).status).toBe(413);
  });
});

describe('restore a version', () => {
  async function history() {
    const s = setup();
    const first = (await paste(s.call, { ...FIELDS, body: 'ONE', tags: ['a'] })).body.document;
    tick();
    await paste(s.call, { ...FIELDS, body: 'TWO', tags: ['b'] });
    tick();
    const third = (await paste(s.call, { ...FIELDS, body: 'THREE', tags: ['c'] })).body.document;
    return { ...s, id: first.id, etag: third.etag };
  }
  const restore = (id, version, etag) => request({ id, body: { version, etag } });

  it('writes the old version as a new newest version, so history only grows forward', async () => {
    const { call, store, id, etag } = await history();
    tick();
    const res = await call('restoreVersion', restore(id, 1, etag));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'versioned',
      document: { version: 4, body: 'ONE', tags: ['a'], restoredFromVersion: 1 },
    });
    expect(store.get(`${id}~v3`)).toMatchObject({ body: 'THREE' });
    expect(store.get(`${id}~v1`)).toMatchObject({ body: 'ONE' });
    expect((await call('getVersion', request({ id, version: '3' }))).body.version.body).toBe('THREE');
  });

  it('accepts the version as a string, as a URL or a form would send it', async () => {
    const { call, id, etag } = await history();
    expect((await call('restoreVersion', restore(id, '2', etag))).body.document.body).toBe('TWO');
  });

  it('refuses the newest version, a version that is not kept, and one that is not a number', async () => {
    const { call, id, etag } = await history();
    expect((await call('restoreVersion', restore(id, 3, etag))).body.code).toBe('ALREADY_CURRENT');
    expect((await call('restoreVersion', restore(id, 9, etag))).body.code).toBe('VERSION_NOT_FOUND');
    expect((await call('restoreVersion', restore(id, 'two', etag))).body.code).toBe('BAD_VERSION');
    expect((await call('restoreVersion', restore(id, undefined, etag))).body.code).toBe('BAD_VERSION');
    expect((await call('restoreVersion', restore(id, { $gt: 0 }, etag))).body.code).toBe('BAD_VERSION');
  });

  it('refuses a stale etag, a missing document, a document in Trash and a title another document took', async () => {
    const { call, id } = await history();
    expect((await call('restoreVersion', restore(id, 1, '"stale"'))).status).toBe(412);
    expect((await call('restoreVersion', restore(id, 1, undefined))).body.code).toBe('ETAG_REQUIRED');
    expect((await call('restoreVersion', restore('missing', 1, 'e'))).status).toBe(404);

    const { call: c2, id: id2, etag: etag2 } = await history();
    const trashed = await c2('remove', request({ id: id2, body: { etag: etag2 } }));
    expect((await c2('restoreVersion', restore(id2, 1, trashed.body.document.etag))).body.code).toBe('IN_TRASH');
  });

  it('refuses a version whose title another document now holds', async () => {
    const s = setup();
    const doc = (await paste(s.call, { ...FIELDS, title: 'Old name', body: 'ONE' })).body.document;
    const renamed = await s.call('update', request({ id: doc.id, body: { etag: doc.etag, fields: { ...FIELDS, title: 'New name', body: 'TWO' } } }));
    await paste(s.call, { ...FIELDS, title: 'Old name', body: 'Someone else' });
    const res = await s.call('restoreVersion', restore(doc.id, 1, renamed.body.document.etag));
    expect(res.body.code).toBe('DUPLICATE');
  });

  it('answers unchanged when the current text already is that version', async () => {
    const s = setup();
    const doc = (await paste(s.call, { ...FIELDS, body: 'SAME' })).body.document;
    const v2 = (await s.call('update', request({ id: doc.id, body: { etag: doc.etag, fields: { ...FIELDS, body: 'OTHER' } } }))).body.document;
    const v3 = (await s.call('update', request({ id: doc.id, body: { etag: v2.etag, fields: { ...FIELDS, body: 'SAME' } } }))).body.document;
    const res = await s.call('restoreVersion', restore(doc.id, 1, v3.etag));
    expect(res.body.outcome).toBe('unchanged');
  });

  it('keeps the source of the version it restores', async () => {
    const s = setup();
    await upload(s.call, 'letter.md', '---\ntitle: Cover letter\ncategory: Letter\n---\nFrom a file');
    const [doc] = s.store.documents();
    const edited = await s.call('update', request({ id: doc.id, body: { etag: doc._etag, fields: { ...FIELDS, body: 'Typed in' } } }));
    expect(edited.body.document.source).toBe('pasted');
    const back = await s.call('restoreVersion', restore(doc.id, 1, edited.body.document.etag));
    expect(back.body.document).toMatchObject({ source: 'uploaded', body: 'From a file' });
  });
});

describe('delete, Trash and put back', () => {
  async function inVault() {
    const s = setup();
    const { document } = (await paste(s.call)).body;
    tick();
    await paste(s.call, { ...FIELDS, body: 'v2' });
    const current = s.store.get(document.id);
    return { ...s, id: document.id, etag: current._etag };
  }

  it('moves a document to Trash, keeping it and its versions, and out of the default list', async () => {
    const { call, store, id, etag } = await inVault();
    const deletedAt = new Date(clock).toISOString();
    const res = await call('remove', request({ id, body: { etag } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'trashed', document: { id, deletedAt } });
    expect(res.body.document).not.toHaveProperty('body');
    expect(store.get(id)).toMatchObject({ deletedAt, deletedBy: 'admin-oid-1' });
    expect(store.get(`${id}~v1`)).not.toBeNull();
    expect((await call('list', request())).body.documents).toEqual([]);
    const trash = await call('list', request({ query: { view: 'trash' } }));
    expect(trash.body.documents.map((d) => d.id)).toEqual([id]);
    expect(trash.body.documents[0].purgeAt).toBe(new Date(clock + TRASH_DAYS * DAY).toISOString());
  });

  it('answers 200 already_in_trash for a second delete', async () => {
    const { call, id, etag } = await inVault();
    const first = await call('remove', request({ id, body: { etag } }));
    const again = await call('remove', request({ id, body: { etag: first.body.document.etag } }));
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('already_in_trash');
  });

  it('needs the etag, and refuses a stale one with the current summary', async () => {
    const { call, store, id } = await inVault();
    expect((await call('remove', request({ id, body: {} }))).body.code).toBe('ETAG_REQUIRED');
    const stale = await call('remove', request({ id, body: { etag: '"old"' } }));
    expect(stale.status).toBe(412);
    expect(stale.body.current.id).toBe(id);
    expect(store.get(id).deletedAt).toBeNull();
  });

  it('turns a delete that loses the race into a 412', async () => {
    const { call, store, id, etag } = await inVault();
    store.fail('patchDoc', failure(412));
    expect((await call('remove', request({ id, body: { etag } }))).status).toBe(412);
    expect(store.get(id).deletedAt).toBeNull();
  });

  it('deletes forever only from Trash, removing the versions first and the document last', async () => {
    const { call, store, id, etag } = await inVault();
    const refused = await call('remove', request({ id, body: { etag, permanent: true } }));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_IN_TRASH');
    expect(store.get(id)).not.toBeNull();

    const trashed = await call('remove', request({ id, body: { etag } }));
    store.deleteDoc.mockClear();
    store.deleteDocIfMatch.mockClear();
    const gone = await call('remove', request({ id, body: { etag: trashed.body.document.etag, permanent: true } }));
    expect(gone.body).toEqual({ ok: true, deleted: id, permanent: true });
    expect(store.get(id)).toBeNull();
    expect(store.get(`${id}~v1`)).toBeNull();
    const order = [
      ...store.deleteDoc.mock.invocationCallOrder,
      ...store.deleteDocIfMatch.mock.invocationCallOrder,
    ];
    expect(Math.max(...store.deleteDoc.mock.invocationCallOrder)).toBeLessThan(Math.min(...store.deleteDocIfMatch.mock.invocationCallOrder));
    expect(order.length).toBeGreaterThan(1);
    expect(store.documents()).toEqual([]);
    expect(store.versions()).toEqual([]);
  });

  it('keeps a permanent delete that loses the race out of the document it did not remove', async () => {
    const { call, store, id, etag } = await inVault();
    const trashed = await call('remove', request({ id, body: { etag } }));
    store.fail('deleteDocIfMatch', failure(412));
    const res = await call('remove', request({ id, body: { etag: trashed.body.document.etag, permanent: true } }));
    expect(res.status).toBe(412);
    expect(store.get(id)).not.toBeNull();
  });

  it('puts a document back with its versions', async () => {
    const { call, store, id, etag } = await inVault();
    const trashed = await call('remove', request({ id, body: { etag } }));
    const res = await call('untrash', request({ id, body: { etag: trashed.body.document.etag } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'restored', document: { id, deletedAt: null, body: 'v2' } });
    expect(store.get(id)).toMatchObject({ deletedAt: null, deletedBy: null });
    expect((await call('list', request())).body.documents.map((d) => d.id)).toEqual([id]);
    expect((await call('get', request({ id }))).body.versions).toHaveLength(1);
  });

  it('refuses to put back what is not in Trash, with a stale etag, or when its title was taken', async () => {
    const { call, store, id, etag } = await inVault();
    expect((await call('untrash', request({ id, body: { etag } }))).body.code).toBe('NOT_IN_TRASH');
    const trashed = await call('remove', request({ id, body: { etag } }));
    expect((await call('untrash', request({ id, body: { etag: '"old"' } }))).status).toBe(412);
    // Make another document hold the trashed one's key, as a forged duplicate would.
    store.docs.set('intruder', { ...store.get(id), id: 'intruder', deletedAt: null });
    const clash = await call('untrash', request({ id, body: { etag: trashed.body.document.etag } }));
    expect(clash.body.code).toBe('DUPLICATE');
  });

  it('brings a trashed document back when the same title is added again', async () => {
    const { call, id, etag } = await inVault();
    await call('remove', request({ id, body: { etag } }));
    const same = await paste(call, { ...FIELDS, body: 'v2' });
    expect(same.body).toMatchObject({ outcome: 'restored', document: { id, deletedAt: null } });
    await call('remove', request({ id, body: { etag: same.body.document.etag } }));
    const changed = await paste(call, { ...FIELDS, body: 'v3 — new words' });
    expect(changed.body).toMatchObject({ outcome: 'versioned', document: { id, version: 3, deletedAt: null } });
  });

  it('removes what has waited in Trash for more than 30 days, with its versions, when the list is loaded', async () => {
    const { call, store, id, etag } = await inVault();
    const other = (await paste(call, { ...FIELDS, title: 'Stays', body: 'x' })).body.document;
    await call('remove', request({ id, body: { etag } }));
    tick(29 * DAY);
    await call('remove', request({ id: other.id, body: { etag: other.etag } }));
    tick(DAY + 1000);
    expect(store.get(id)).not.toBeNull();
    const res = await call('list', request({ query: { view: 'trash' } }));
    expect(res.status).toBe(200);
    expect(store.get(id)).toBeNull();
    expect(store.get(`${id}~v1`)).toBeNull();
    expect(res.body.documents.map((d) => d.id)).toEqual([other.id]);
    expect(store.get(other.id)).not.toBeNull();
  });

  it('answers the list even when the purge fails', async () => {
    const { call, store } = await inVault();
    store.fail('deleteDoc', failure(500));
    const res = await call('list', request());
    expect(res.status).toBe(200);
  });
});

describe('upload', () => {
  const FILE = [
    '---',
    'title: Cover letter',
    'category: Letter',
    'tags:',
    '  - outreach',
    '  - "#mvp"',
    'status: sent',
    '---',
    '',
    'Dear team,',
    '',
    'Uploaded text.',
  ].join('\n');

  it('creates a document as uploaded and reports what it left out', async () => {
    const { call, store } = setup();
    const res = await upload(call, 'cover.md', FILE);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      outcome: 'created',
      document: { title: 'Cover letter', category: 'Letter', tags: ['outreach', 'mvp'], source: 'uploaded', version: 1 },
    });
    expect(res.body.document).not.toHaveProperty('body');
    expect(res.body.warnings.join(' ')).toContain('status');
    expect(store.get(res.body.document.id)).toMatchObject({
      body: 'Dear team,\n\nUploaded text.',
      source: 'uploaded',
      createdBy: 'admin-oid-1',
    });
  });

  it('uploading the same title again is a new version, and the very same text writes nothing', async () => {
    const { call, store } = setup();
    const first = await upload(call, 'cover.md', FILE);
    const same = await upload(call, 'cover again.md', FILE);
    expect(same.status).toBe(200);
    expect(same.body.outcome).toBe('unchanged');
    tick();
    const changed = await upload(call, 'cover.md', FILE.replace('Uploaded text.', 'Better text.'));
    expect(changed.body).toMatchObject({ outcome: 'versioned', document: { id: first.body.document.id, version: 2 } });
    expect([...store.docs.values()].filter((d) => d.docType === 'document')).toHaveLength(1);
  });

  it('files a document with no front matter under the title of its heading and the category chosen', async () => {
    const { call } = setup();
    const res = await upload(call, 'x.txt', '# Notes from the call\n\nWe agreed…', { defaultCategory: 'notes' });
    expect(res.body.document).toMatchObject({ title: 'Notes from the call', category: 'Notes' });
  });

  it('refuses what is not a text file, in plain words, and writes nothing', async () => {
    const { call, store } = setup();
    expect((await upload(call, 'cv.docx', 'x')).body.code).toBe('BAD_FILENAME');
    expect((await upload(call, 'a.md', 'SECRET\u0000')).body.code).toBe('NOT_TEXT');
    expect((await upload(call, 'a.md', '---\ntitle: T\n---\n')).body.code).toBe('EMPTY_BODY');
    expect((await upload(call, 'a.md', 5)).status).toBe(400);
    expect((await upload(call, 'a.md', 'text', { defaultCategory: 'Poem' })).status).toBe(400);
    expect((await upload(call, 'a.md', `---\ntitle: ${'x'.repeat(201)}\n---\nbody`)).body.code).toBe('TITLE_TOO_LONG');
    expect(store.docs.size).toBe(0);
  });

  it('refuses a file over the cap in the parser and a request over the cap in the reader', async () => {
    const { call, handlers, store } = setup();
    const big = await upload(call, 'big.md', 'x'.repeat(MAX_BODY_BYTES + 20_000));
    expect(big.status).toBe(413);
    const huge = JSON.stringify({ filename: 'huge.md', text: 'x'.repeat(MAX_UPLOAD_REQUEST_BYTES) });
    const res = parse(await handlers.upload(streamed(huge), makeContext()));
    expect(res.status).toBe(413);
    expect(store.docs.size).toBe(0);
  });

  it('cannot be made to set a privileged field by front matter', async () => {
    const { call, store } = setup();
    const res = await upload(
      call,
      'hostile.md',
      '---\ntitle: Honest\nid: stolen\nversion: 99\ncreatedBy: someone\ndeletedAt: 2000-01-01\ndocType: version\ncontentStatus: published\nLive: true\nslug: public\npartitionKey: x\n__proto__: polluted\n---\nBody'
    );
    expect(res.status).toBe(201);
    const stored = store.get(res.body.document.id);
    expect(stored).toMatchObject({ title: 'Honest', version: 1, createdBy: 'admin-oid-1', deletedAt: null, docType: 'document' });
    expect(stored.id).toBe(vaultDocumentId('other|honest', SALT));
    for (const key of ['contentStatus', 'Live', 'slug', 'partitionKey', 'ttl']) expect(stored).not.toHaveProperty(key);
    expect(store.dump()).not.toContain('stolen');
    expect(store.dump()).not.toContain('polluted');
    expect({}.polluted).toBeUndefined();
  });

  it('lets a batch go through one file at a time, a failing file costing only itself', async () => {
    const { call, store } = setup();
    const files = [
      ['one.md', '# One\n\nfirst'],
      ['broken.docx', 'x'],
      ['two.md', '# Two\n\nsecond'],
      ['empty.md', '   '],
      ['three.txt', 'third, no heading'],
    ];
    const results = [];
    for (const [name, text] of files) results.push(await upload(call, name, text));
    expect(results.map((r) => r.status)).toEqual([201, 400, 201, 422, 201]);
    expect(store.documents().map((d) => d.title).sort()).toEqual(['One', 'Two', 'three']);
  });
});

describe('what is never put in a log, an audit row or an error', () => {
  const MARK = {
    title: 'TITLE-MARK-8c41',
    body: 'BODY-MARK-1f9a private paragraph',
    tag: 'tag-mark-77d2',
    link: 'https://example.com/LINK-MARK-5b3e',
  };
  const SECRET_FIELDS = {
    title: MARK.title,
    category: 'Letter',
    tags: [MARK.tag],
    body: MARK.body,
    relatedLink: MARK.link,
  };
  const marks = Object.values(MARK);

  /** Everything a run wrote outside the document store: log lines and audit rows. */
  const outside = ({ context, store }) =>
    JSON.stringify([context.log.mock.calls, context.warn.mock.calls, context.error.mock.calls, store.audit]);
  const containsMark = (text) => marks.filter((mark) => text.includes(mark));

  it('audits every write by id, version, category, source and size, and nothing else', async () => {
    const s = setup();
    const created = (await paste(s.call, SECRET_FIELDS)).body.document;
    tick();
    const v2 = (await s.call('update', request({ id: created.id, body: { etag: created.etag, fields: { ...SECRET_FIELDS, body: `${MARK.body} v2` } } }))).body.document;
    tick();
    const v3 = (await s.call('restoreVersion', request({ id: created.id, body: { version: 1, etag: v2.etag } }))).body.document;
    const trashed = (await s.call('remove', request({ id: created.id, body: { etag: v3.etag } }))).body.document;
    const back = (await s.call('untrash', request({ id: created.id, body: { etag: trashed.etag } }))).body.document;
    const trashedAgain = (await s.call('remove', request({ id: created.id, body: { etag: back.etag } }))).body.document;
    await s.call('remove', request({ id: created.id, body: { etag: trashedAgain.etag, permanent: true } }));
    await upload(s.call, 'f.md', `# ${MARK.title} two\n\n${MARK.body}`);

    expect(s.store.audit.map((row) => row.action)).toEqual([
      'doc_vault_created',
      'doc_vault_updated',
      'doc_vault_version_restored',
      'doc_vault_trashed',
      'doc_vault_untrashed',
      'doc_vault_trashed',
      'doc_vault_deleted_forever',
      'doc_vault_created',
    ]);
    for (const row of s.store.audit) {
      expect(Object.keys(row.details).sort()).toEqual(
        expect.arrayContaining(['bytes', 'category', 'documentId', 'source', 'version'])
      );
      expect(row.resource).toMatch(/^doc_vault:/);
      expect(row.userId).toBe('admin-oid-1');
      expect(row.userEmail).toBeNull();
      expect(row.userName).toBeNull();
      expect(row.before).toBeNull();
      expect(row.after).toBeNull();
    }
    expect(containsMark(outside(s))).toEqual([]);
  });

  it('puts none of it in a refusal either', async () => {
    const s = setup();
    const created = (await paste(s.call, SECRET_FIELDS)).body.document;
    const bodies = [];
    const keep = async (promise) => {
      const res = await promise;
      expect(res.status).toBeGreaterThanOrEqual(400);
      bodies.push(JSON.stringify(res.body));
    };
    await keep(s.call('create', request({ body: { fields: { ...SECRET_FIELDS, category: 'Poem' } } })));
    await keep(s.call('create', request({ body: { fields: { ...SECRET_FIELDS, [MARK.tag]: 'x' } } })));
    await keep(s.call('create', request({ body: { fields: { ...SECRET_FIELDS, body: `${MARK.body}\u0000` } } })));
    await keep(s.call('update', request({ id: created.id, body: { etag: '"stale"', fields: { ...SECRET_FIELDS, body: 'new' } } })));
    await keep(s.call('update', request({ id: created.id, body: { etag: created.etag, fields: { ...SECRET_FIELDS, relatedLink: `javascript:${MARK.link}` } } })));
    await keep(upload(s.call, 'bad.docx', MARK.body));
    await keep(upload(s.call, 'bad.md', `${MARK.body}\u0000`));
    await keep(s.call('getVersion', request({ id: created.id, version: '7' })));
    await keep(s.call('get', request({ id: `${MARK.title}` })));
    expect(containsMark(bodies.join('\n'))).toEqual([]);
    expect(containsMark(outside(s))).toEqual([]);
  });

  it('answers a fixed sentence and a reference when the store fails, even if its own error quotes the text', async () => {
    const s = setup();
    const quoting = Object.assign(new Error(`write failed for ${JSON.stringify(SECRET_FIELDS)}`), { code: 'EBROKEN' });
    s.store.fail('createDoc', quoting);
    const res = await paste(s.call, SECRET_FIELDS);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'Failed to save the document' });
    expect(res.body.correlationId).toBeTruthy();
    expect(containsMark(JSON.stringify(res.body))).toEqual([]);
    expect(containsMark(outside(s))).toEqual([]);
    expect(s.context.error.mock.calls.length + s.context.warn.mock.calls.length).toBeGreaterThan(0);
  });

  it('survives a failing audit write: the save stands and nothing is retried', async () => {
    const s = setup();
    s.store.fail('upsertDoc', failure(500), { times: 1 });
    const res = await paste(s.call, SECRET_FIELDS);
    expect(res.status).toBe(201);
    expect(s.store.get(res.body.document.id)).not.toBeNull();
    expect(containsMark(outside(s))).toEqual([]);
  });
});

describe('when the container does not exist yet', () => {
  const missing = Object.assign(new Error('Resource Not Found'), { code: 404 });

  it.each([
    ['list', request()],
    ['create', request({ body: { fields: FIELDS } })],
    ['upload', request({ body: { filename: 'a.md', text: '# A\n\nb' } })],
  ])('%s answers 503 NOT_PROVISIONED with the way to fix it', async (name, req) => {
    const { handlers, store, context } = setup();
    store.fail('queryDocs', missing, { times: 5 });
    const res = parse(await handlers[name](req, context));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: 'NOT_PROVISIONED' });
    expect(res.body.error).toContain('docs/runbooks/doc-vault.md');
  });
});

describe('unexpected failures', () => {
  it('answer 500 with a fixed sentence for each kind of work', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'EBOOM' });
    const cases = [
      ['list', request(), 'queryDocs', 'Failed to list documents'],
      ['get', request({ id: 'x' }), 'readDoc', 'Failed to read the document'],
      ['getVersion', request({ id: 'x', version: '1' }), 'readDoc', 'Failed to read the version'],
      ['remove', request({ id: 'x', body: { etag: 'e' } }), 'readDoc', 'Failed to delete the document'],
      ['untrash', request({ id: 'x', body: { etag: 'e' } }), 'readDoc', 'Failed to put the document back'],
      ['restoreVersion', request({ id: 'x', body: { etag: 'e', version: 1 } }), 'readDoc', 'Failed to restore the version'],
      ['update', request({ id: 'x', body: { etag: 'e', fields: FIELDS } }), 'readDoc', 'Failed to save the document'],
    ];
    for (const [name, req, verb, sentence] of cases) {
      const s = setup();
      s.store.fail(verb, boom, { times: 5 });
      // The list purges before it reads; a failing query is swallowed there and fails the read.
      const res = parse(await s.handlers[name](req, s.context));
      expect(res.status, name).toBe(500);
      expect(res.body.error, name).toBe(sentence);
    }
  });
});

// ── what the security review found (2026-10-26) ────────────────────────────

describe('an id says nothing about the title (F2)', () => {
  it('makes the salt once, as its own item, and derives every id from it', async () => {
    const { call, store } = setup();
    expect(store.get('vault-id-salt')).toBeNull();
    const first = (await paste(call)).body.document;
    expect(store.get('vault-id-salt')).toMatchObject({ docType: 'salt', value: SALT });
    await paste(call, { ...FIELDS, title: 'A second one' });
    expect(store.createDoc.mock.calls.filter(([, doc]) => doc.id === 'vault-id-salt')).toHaveLength(1);
    expect(first.id).toBe(vaultDocumentId('letter|cover letter', SALT));
  });

  it('gives the same title another id under another salt, so an id cannot be checked against a guess', async () => {
    const a = setup();
    const b = setup();
    b.handlers = createDocVaultHandlers({
      guard: allowGuard(),
      store: b.store,
      now: () => new Date(clock),
      uuid: () => 'x',
      newSalt: () => 'z'.repeat(64),
    });
    const callB = async (name, req) => parse(await b.handlers[name](req, b.context));
    const idA = (await paste(a.call)).body.document.id;
    const idB = (await paste(callB)).body.document.id;
    expect(idA).not.toBe(idB);
  });

  it('keeps the salt out of every list, every read and every purge', async () => {
    const { call, store } = setup();
    await paste(call);
    const list = await call('list', request());
    expect(list.body.documents).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(SALT);
    expect((await call('get', request({ id: 'vault-id-salt' }))).status).toBe(404);
    expect((await call('getVersion', request({ id: 'vault-id-salt', version: '1' }))).status).toBe(404);
    expect((await call('remove', request({ id: 'vault-id-salt', body: { etag: store.get('vault-id-salt')._etag } }))).status).toBe(404);
    tick(40 * DAY);
    await call('list', request({ query: { view: 'trash' } }));
    expect(store.get('vault-id-salt')).not.toBeNull();
  });

  it('agrees on one salt when two instances meet at the first create', async () => {
    const store = vaultStore();
    const context = makeContext();
    const make = (value) =>
      createDocVaultHandlers({
        guard: allowGuard(),
        store,
        now: () => new Date(NOW),
        uuid: () => 'u',
        newSalt: () => value,
      });
    const one = make('1'.repeat(64));
    const two = make('2'.repeat(64));
    const [a, b] = await Promise.all([
      one.create(request({ body: { fields: FIELDS } }), context),
      two.create(request({ body: { fields: FIELDS } }), context),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(store.documents()).toHaveLength(1);
    expect(['1'.repeat(64), '2'.repeat(64)]).toContain(store.get('vault-id-salt').value);
  });

  it('answers a fixed 500 when the salt item exists and cannot be read', async () => {
    const { call, store } = setup({ seed: [{ id: 'vault-id-salt', docType: 'document' }] });
    const res = await paste(call);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to save the document');
    expect(store.documents().filter((d) => d.title)).toHaveLength(0);
  });
});

describe('deleting for good, and the Trash purge, cannot lose or leave history (F3)', () => {
  async function trashedWithHistory() {
    const s = setup();
    const { document } = (await paste(s.call)).body;
    tick();
    await paste(s.call, { ...FIELDS, body: 'second' });
    const current = s.store.get(document.id);
    const trashed = (await s.call('remove', request({ id: document.id, body: { etag: current._etag } }))).body.document;
    return { ...s, id: document.id, etag: trashed.etag };
  }

  it('(a) leaves alone a document that was put back after the purge read it', async () => {
    const { call, store, id } = await trashedWithHistory();
    tick(40 * DAY);
    // The expired row is read, then the owner puts the document back before the purge acts.
    const real = store.queryDocs.getMockImplementation();
    store.queryDocs.mockImplementationOnce(async (...args) => {
      const rows = await real(...args);
      const doc = store.get(id);
      store.docs.set(id, { ...doc, deletedAt: null, deletedBy: null, _etag: '"moved-on"' });
      return rows;
    });
    const res = await call('list', request());
    expect(res.status).toBe(200);
    expect(store.get(id)).toMatchObject({ deletedAt: null });
    expect(store.versions()).toHaveLength(1);
  });

  it('(b) keeps the history when a put-back wins the race against Delete forever', async () => {
    const { call, store, id, etag } = await trashedWithHistory();
    store.fail('patchDoc', failure(412));
    const res = await call('remove', request({ id, body: { etag, permanent: true } }));
    expect(res.status).toBe(412);
    expect(store.get(id)).not.toBeNull();
    expect(store.get(id).purging).toBeUndefined();
    expect(store.versions()).toHaveLength(1);
  });

  it('marks the document before it removes anything, and the document is the last thing to go', async () => {
    const { call, store, id, etag } = await trashedWithHistory();
    store.patchDoc.mockClear();
    store.deleteDoc.mockClear();
    store.deleteDocIfMatch.mockClear();
    const res = await call('remove', request({ id, body: { etag, permanent: true } }));
    expect(res.status).toBe(200);
    expect(store.patchDoc).toHaveBeenCalledWith('doc_vault', id, { purging: true }, { ifMatch: etag });
    expect(store.patchDoc.mock.invocationCallOrder[0]).toBeLessThan(store.deleteDoc.mock.invocationCallOrder[0]);
    expect(Math.max(...store.deleteDoc.mock.invocationCallOrder)).toBeLessThan(
      store.deleteDocIfMatch.mock.invocationCallOrder[0]
    );
    expect(store.documents()).toEqual([]);
    expect(store.versions()).toEqual([]);
  });

  it('an interrupted delete leaves a marked document that cannot be put back or revived, and that a retry finishes', async () => {
    const { call, store, id, etag } = await trashedWithHistory();
    store.fail('deleteDoc', failure(500));
    const first = await call('remove', request({ id, body: { etag, permanent: true } }));
    expect(first.status).toBe(500);
    const stuck = store.get(id);
    expect(stuck).toMatchObject({ purging: true });

    const putBack = await call('untrash', request({ id, body: { etag: stuck._etag } }));
    expect(putBack.status).toBe(409);
    expect(putBack.body.code).toBe('PURGING');
    // Adding the same title again does not revive it half-deleted either.
    const again = await paste(call);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PURGING');
    expect(store.get(id).deletedAt).not.toBeNull();

    const retry = await call('remove', request({ id, body: { etag: stuck._etag, permanent: true } }));
    expect(retry.status).toBe(200);
    expect(store.documents()).toEqual([]);
    expect(store.versions()).toEqual([]);
  });

  it('the purge on list finishes a document that was left marked', async () => {
    const { call, store, id, etag } = await trashedWithHistory();
    store.fail('deleteDoc', failure(500));
    await call('remove', request({ id, body: { etag, permanent: true } }));
    expect(store.get(id)).not.toBeNull();
    tick(40 * DAY);
    await call('list', request());
    expect(store.get(id)).toBeNull();
    expect(store.versions()).toEqual([]);
  });

  it('the purge goes on to the next document when one fails', async () => {
    const s = setup();
    const ids = [];
    for (const title of ['One', 'Two']) {
      const { document } = (await paste(s.call, { ...FIELDS, title })).body;
      await s.call('remove', request({ id: document.id, body: { etag: document.etag } }));
      ids.push(document.id);
    }
    tick(40 * DAY);
    s.store.fail('patchDoc', failure(500));
    await s.call('list', request());
    expect(ids.filter((id) => s.store.get(id) === null)).toHaveLength(1);
  });

  it('(c) takes back the archived version it wrote when the document was removed meanwhile', async () => {
    const { call, store } = setup();
    const { document } = (await paste(call)).body;
    store.fail('replaceDocIfMatch', failure(404));
    store.docs.delete(document.id);
    const res = await call('update', request({ id: document.id, body: { etag: document.etag, fields: { ...FIELDS, body: 'late' } } }));
    expect(res.status).toBe(404);
    expect(store.versions()).toEqual([]);
  });

  it('(c) takes it back too when the document is marked for deletion, and keeps it when the document merely moved on', async () => {
    const marked = setup();
    const doc = (await paste(marked.call)).body.document;
    marked.store.fail('replaceDocIfMatch', failure(412));
    const real = marked.store.replaceDocIfMatch.getMockImplementation();
    marked.store.replaceDocIfMatch.mockImplementationOnce(async (...args) => {
      marked.store.docs.set(doc.id, { ...marked.store.get(doc.id), purging: true, deletedAt: 'x', _etag: '"p"' });
      return real(...args);
    });
    const res = await marked.call('update', request({ id: doc.id, body: { etag: doc.etag, fields: { ...FIELDS, body: 'late' } } }));
    expect(res.status).toBe(412);
    expect(marked.store.versions()).toEqual([]);

    const moved = setup();
    const doc2 = (await paste(moved.call)).body.document;
    moved.store.fail('replaceDocIfMatch', failure(412));
    const res2 = await moved.call('update', request({ id: doc2.id, body: { etag: doc2.etag, fields: { ...FIELDS, body: 'late' } } }));
    expect(res2.status).toBe(412);
    expect(moved.store.versions()).toHaveLength(1);
  });
});

describe('a read of a private document is recorded, without saying what it held (F4)', () => {
  it('writes one content-free row for each document opened and each version read, none for the list', async () => {
    const { call, store } = setup();
    const { document } = (await paste(call, { ...FIELDS, title: 'TITLE-MARK-read', body: 'BODY-MARK-read' })).body;
    await paste(call, { ...FIELDS, title: 'TITLE-MARK-read', body: 'BODY-MARK-read v2' });
    store.audit.length = 0;
    await call('list', request());
    expect(store.audit).toHaveLength(0);
    await call('get', request({ id: document.id }));
    await call('getVersion', request({ id: document.id, version: '1' }));
    await call('getVersion', request({ id: document.id, version: '2' }));
    expect(store.audit.map((row) => row.action)).toEqual(['doc_vault_read', 'doc_vault_read', 'doc_vault_read']);
    expect(store.audit.map((row) => row.details.readVersion)).toEqual([undefined, 1, 2]);
    for (const row of store.audit) {
      expect(row.userId).toBe('admin-oid-1');
      expect(row.userEmail).toBeNull();
      expect(JSON.stringify(row)).not.toContain('MARK');
    }
  });

  it('does not fail the read when the audit write fails', async () => {
    const { call, store } = setup();
    const { document } = (await paste(call)).body;
    store.fail('upsertDoc', failure(500));
    const res = await call('get', request({ id: document.id }));
    expect(res.status).toBe(200);
  });

  it('records nothing for a read that found nothing', async () => {
    const { call, store } = setup();
    await call('get', request({ id: 'missing' }));
    expect(store.audit).toEqual([]);
  });
});

describe('answers are never cached (I1)', () => {
  it('say so on a success and on a refusal', async () => {
    const { handlers, context } = setup();
    const ok = await handlers.list(request(), context);
    const refusedRes = await handlers.get(request({ id: 'missing' }), context);
    for (const res of [ok, refusedRes]) {
      expect(res.headers['Cache-Control']).toBe('private, no-store');
      expect(res.headers['Content-Type']).toBe('application/json');
    }
  });
});
