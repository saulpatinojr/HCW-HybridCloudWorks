/**
 * The admin routes of the `interview` content type (ADR 0040, D5, D9, D10):
 * create at draft with the consent record, list, read with the transcript,
 * delete the recording. The schema and storage modules belong to the other
 * slices and are stood in for through the loader; the store and the blob
 * client are fakes that record what they were asked.
 *
 * One rule runs through every case: the logs carry ids and counts, never a
 * guest's name, a transcript sentence or a blob name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoredError } from '../http/error-response.js';
import { CONSENT_REQUIRED, CONSENT_WORDING_V1 } from './consent.js';
import {
  INITIAL_STAGE,
  LIST_QUERY,
  createInterviewAdminHandlers,
  deleteBlobWithVersions,
  deleteInterviewAssets,
  ownedRecordingPaths,
  toListRow,
} from './admin.js';
import { stubSiblingModulesForTests } from './sibling-modules.js';

const USER = { oid: 'oid-editor', email: 'editor@example.test' };
const guardAs = (role) => ({
  requireRole: vi.fn(async (_request, needed) =>
    role === 'publisher' || needed === role
      ? { user: USER, role, error: null }
      : { user: null, role: null, error: { status: 403, body: '{}' } }
  ),
});
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-11-05T12:00:00.000Z');
const fixed = { now: () => NOW, uuid: () => 'fixed-uuid' };

const makeRequest = ({ body, params = {} } = {}) => ({
  method: 'POST',
  headers: { get: (name) => (name === 'user-agent' ? 'vitest' : null) },
  json: async () => body ?? {},
  params,
});

const schema = {
  validateInterviewFields: vi.fn((fields) => fields),
  validateQa: vi.fn((qa) => qa),
};
const storage = {
  INTERVIEWS_AUDIO_CONTAINER: 'interviews-audio',
  transcriptBlobPath: (id, version) => `transcripts/${id}/v${version}.json`,
};

/** A fake store: documents by id, every call recorded. */
function makeStore(docs = []) {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  return {
    byId,
    readDoc: vi.fn(async (container, id) => (container === 'content' ? byId.get(id) || null : null)),
    queryDocs: vi.fn(async () => []),
    upsertDoc: vi.fn(async (container, doc) => {
      if (container === 'content') byId.set(doc.id, { ...doc, _etag: '"e1"' });
      return doc;
    }),
    patchDoc: vi.fn(async (_c, id, updates) => ({ id, ...updates })),
  };
}

/**
 * A fake blob client over a list of names. `versions` maps a name to the
 * version ids the container lists for it; every version delete is recorded
 * in `versionDeletes` as `name@versionId`. A listing with versions returns
 * the current blobs too, as the service does, and a version outlives its
 * base blob's delete.
 */
function makeBlobs(names = [], { failing = [], versions = {}, versionForbidden = false } = {}) {
  const present = new Set(names);
  const versionDeletes = [];
  const getContainerClient = vi.fn(() => ({
    listBlobsFlat: ({ prefix, includeVersions }) => {
      const current = [...present].filter((name) => name.startsWith(prefix)).map((name) => ({ name }));
      const previous = includeVersions
        ? Object.keys(versions)
            .filter((name) => name.startsWith(prefix))
            .flatMap((name) => versions[name].map((versionId) => ({ name, versionId })))
        : [];
      const items = [...current, ...previous];
      return (async function* list() {
        for (const item of items) yield item;
      })();
    },
    getBlobClient: (name) => ({
      withVersion: (versionId) => ({
        delete: async () => {
          if (versionForbidden) throw Object.assign(new Error('forbidden'), { code: 403 });
          if (failing.includes(name)) throw Object.assign(new Error('storage said no'), { code: 503 });
          versionDeletes.push(`${name}@${versionId}`);
        },
      }),
    }),
  }));
  return {
    present,
    versionDeletes,
    getContainerClient,
    deleteBlob: vi.fn(async (_container, name) => {
      if (failing.includes(name)) throw Object.assign(new Error('storage said no'), { code: 503 });
      present.delete(name);
    }),
    downloadBlob: vi.fn(async (_container, name) => {
      if (!present.has(name)) throw Object.assign(new Error('not found'), { code: 404 });
      return Buffer.from(JSON.stringify({ text: 'Speaker 1: hello', segments: [{ text: 'hello' }] }));
    }),
  };
}

/**
 * Upload ids are UUIDs (the upload route mints them); these are made-up
 * ones. A recording lives at audio/<interview id>/<upload id>.<ext>.
 */
const U_CURRENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const U_OLDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const U_OLDEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const U_STRAY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const U_GONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const CURRENT = `audio/i1/${U_CURRENT}.mp3`;
const OLDER = `audio/i1/${U_OLDER}.m4a`;
const OLDEST = `audio/i1/${U_OLDEST}.wav`;

const interviewDoc = (over = {}) => ({
  id: 'i1',
  type: 'interview',
  Title: 'A conversation',
  title: 'A conversation',
  slug: 'a-conversation',
  guest: { name: 'Test Guest', role: 'Test Role' },
  date: '2026-11-01',
  contentStatus: 'draft',
  interview: { stage: 'ready' },
  transcription: { version: 2, status: 'done' },
  provenance: {
    source: 'upload',
    audio: { container: 'interviews-audio', path: CURRENT, superseded: [OLDER] },
  },
  updatedAt: '2026-11-02T00:00:00.000Z',
  _etag: '"e9"',
  ...over,
});

/** Every string the logger was handed, joined. */
const logged = () =>
  [context.log, context.warn, context.error]
    .flatMap((fn) => fn.mock.calls)
    .flat()
    .map(String)
    .join('\n');

beforeEach(() => {
  stubSiblingModulesForTests({ schema, storage });
  vi.clearAllMocks();
});
afterEach(() => stubSiblingModulesForTests(null));

const handlersWith = (store, blobs = makeBlobs(), role = 'editor') =>
  createInterviewAdminHandlers({ guard: guardAs(role), store, blobs, ...fixed });

describe('create', () => {
  const form = {
    title: 'A conversation',
    guest: { name: 'Test Guest', role: 'Test Role' },
    date: '2026-11-01',
    tags: ['landing-zones'],
    consent: { confirmed: true, date: '2026-11-01' },
  };

  it('denies without a role, touching no store', async () => {
    const store = makeStore();
    const h = createInterviewAdminHandlers({ guard: denyGuard, store, blobs: makeBlobs(), ...fixed });
    expect((await h.create(makeRequest({ body: form }), context)).status).toBe(403);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses an unconfirmed consent with 422 CONSENT_REQUIRED before reading the schema', async () => {
    const store = makeStore();
    const res = await handlersWith(store).create(
      makeRequest({ body: { ...form, consent: { confirmed: false, date: '2026-11-01' } } }),
      context
    );
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: CONSENT_REQUIRED });
    expect(schema.validateInterviewFields).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses fields the schema refuses, with its sentence, writing nothing', async () => {
    schema.validateInterviewFields.mockImplementationOnce(() => {
      throw new AuthoredError('title is 200 characters; the most is 160.');
    });
    const store = makeStore();
    const res = await handlersWith(store).create(makeRequest({ body: form }), context);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      code: 'INVALID_INTERVIEW',
      error: 'title is 200 characters; the most is 160.',
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('writes a draft interview through the content pipeline, attributes the consent, audits the create', async () => {
    const store = makeStore();
    const res = await handlersWith(store).create(makeRequest({ body: form }), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, id: 'fixed-uuid', etag: '"e1"' });

    const [, doc] = store.upsertDoc.mock.calls.find(([container]) => container === 'content');
    expect(doc).toMatchObject({
      id: 'fixed-uuid',
      type: 'interview',
      publishTarget: 'interview',
      cloudProvider: 'Azure',
      'Cloud Provider': 'Azure',
      Title: 'A conversation',
      title: 'A conversation',
      guest: { name: 'Test Guest', role: 'Test Role' },
      date: '2026-11-01',
      tags: ['landing-zones'],
      qa: [],
      related: { labs: [], learn: [] },
      contentStatus: 'draft',
      interview: { stage: INITIAL_STAGE },
      consent: {
        confirmed: true,
        date: '2026-11-01',
        wording: 'v1',
        confirmedBy: { oid: 'oid-editor', email: 'editor@example.test' },
        confirmedAt: NOW.toISOString(),
      },
    });
    // The form's own idea of who confirmed is never trusted.
    const res2 = await handlersWith(makeStore()).create(
      makeRequest({
        body: { ...form, consent: { confirmed: true, date: '2026-11-01', confirmedBy: { oid: 'x' } } },
      }),
      context
    );
    expect(res2.status).toBe(200);

    const [, audit] = store.upsertDoc.mock.calls.find(([container]) => container === 'audits');
    expect(audit).toMatchObject({
      action: 'interview_created',
      resourceId: 'fixed-uuid',
      userId: 'oid-editor',
      metadata: { consentDate: '2026-11-01', consentWording: 'v1' },
    });
    expect(JSON.stringify(audit)).not.toContain('Test Guest');
    expect(JSON.stringify(audit)).not.toContain('editor@example.test');
    expect(logged()).not.toContain('Test Guest');
  });

  it('is the only door: the generic create pipeline refuses type interview and drops the private blocks', async () => {
    const { createContentDocument } = await import('../cms/content-create.js');
    const store = makeStore();
    const refused = await createContentDocument({
      store,
      user: USER,
      data: { type: 'interview', Title: 'Sneaky', consent: { confirmed: true } },
      ...fixed,
    });
    expect(refused).toMatchObject({ status: 400, body: { code: 'USE_INTERVIEW_ROUTE' } });
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const byTarget = await createContentDocument({
      store,
      user: USER,
      data: { type: 'blog', publishTarget: 'interview', Title: 'Sneaky' },
      ...fixed,
    });
    expect(byTarget.status).toBe(400);

    const blog = await createContentDocument({
      store,
      user: USER,
      data: { type: 'blog', Title: 'A post', consent: { confirmed: true }, provenance: { audio: {} }, interview: {}, transcription: {} },
      runEditorialCritique: false,
      ...fixed,
    });
    expect(blog.status).toBe(200);
    const [, doc] = store.upsertDoc.mock.calls.find(([container]) => container === 'content');
    for (const key of ['consent', 'provenance', 'interview', 'transcription']) {
      expect(doc, key).not.toHaveProperty(key);
    }
  });

  it('answers the pipeline’s 409 for a title published within the dedup window', async () => {
    const store = makeStore();
    store.queryDocs.mockImplementation(async (_c, query) =>
      query.includes('normalizedTitle') ? [{ id: 'older', publishedAt: NOW.toISOString() }] : []
    );
    const res = await handlersWith(store).create(makeRequest({ body: form }), context);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it('refuses a body larger than a form', async () => {
    const store = makeStore();
    const request = {
      ...makeRequest({ body: form }),
      headers: { get: (name) => (name === 'content-length' ? String(10 * 1024 * 1024) : null) },
    };
    const res = await handlersWith(store).create(request, context);
    expect(res.status).toBe(413);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('queries interviews only, not soft-deleted, and answers rows newest edit first without bodies', async () => {
    const store = makeStore();
    store.queryDocs.mockResolvedValue([
      interviewDoc({ id: 'old', updatedAt: '2026-10-01T00:00:00.000Z' }),
      interviewDoc({ id: 'new', updatedAt: '2026-11-03T00:00:00.000Z', qa: [{ q: 'q', a: 'secret body' }] }),
    ]);
    const res = await handlersWith(store).list(makeRequest(), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe('content');
    expect(query).toBe(LIST_QUERY);
    expect(query).toContain('LOWER(c.type) = @type');
    expect(query).not.toContain('c.qa');
    expect(params).toEqual([{ name: '@type', value: 'interview' }]);
    const { interviews } = JSON.parse(res.body);
    expect(interviews.map((row) => row.id)).toEqual(['new', 'old']);
    expect(interviews[0]).toEqual({
      id: 'new',
      title: 'A conversation',
      slug: 'a-conversation',
      subtitle: '',
      date: '2026-11-01',
      guest: { name: 'Test Guest', role: 'Test Role' },
      contentStatus: 'draft',
      live: false,
      stage: 'ready',
      stageError: null,
      transcription: { version: 2, status: 'done' },
      curatedSubpagePath: null,
      updatedAt: '2026-11-03T00:00:00.000Z',
      createdAt: null,
      etag: '"e9"',
    });
    expect(res.body).not.toContain('secret body');
  });

  it('denies a caller without the editor role', async () => {
    const store = makeStore();
    const h = createInterviewAdminHandlers({ guard: denyGuard, store, blobs: makeBlobs(), ...fixed });
    expect((await h.list(makeRequest(), context)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('toListRow reads the stage as created when nothing has set one', () => {
    expect(toListRow({ id: 'x' }).stage).toBe(INITIAL_STAGE);
    expect(toListRow({ id: 'x', interview: { stage: 'failed', error: 'BUDGET_EXCEEDED' } })).toMatchObject({
      stage: 'failed',
      stageError: 'BUDGET_EXCEEDED',
    });
  });
});

describe('get', () => {
  it('answers the document, its etag, the consent wording and the transcript it points at', async () => {
    const store = makeStore([interviewDoc()]);
    const blobs = makeBlobs(['transcripts/i1/v2.json']);
    const res = await handlersWith(store, blobs).get(makeRequest({ params: { id: 'i1' } }), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    const body = JSON.parse(res.body);
    expect(body.interview.id).toBe('i1');
    expect(body.etag).toBe('"e9"');
    expect(body.consentWording).toBe(CONSENT_WORDING_V1);
    expect(body.transcript).toEqual({
      version: 2,
      text: 'Speaker 1: hello',
      segments: [{ text: 'hello' }],
    });
    expect(blobs.downloadBlob).toHaveBeenCalledWith('interviews-audio', 'transcripts/i1/v2.json');
  });

  it('answers a null transcript when there is none yet, or it cannot be read, logging only the code', async () => {
    const none = makeStore([interviewDoc({ transcription: undefined })]);
    const blobs = makeBlobs();
    let body = JSON.parse((await handlersWith(none, blobs).get(makeRequest({ params: { id: 'i1' } }), context)).body);
    expect(body.transcript).toBeNull();
    expect(blobs.downloadBlob).not.toHaveBeenCalled();

    const missing = makeStore([interviewDoc()]);
    body = JSON.parse((await handlersWith(missing, blobs).get(makeRequest({ params: { id: 'i1' } }), context)).body);
    expect(body.transcript).toBeNull();
    expect(logged()).toMatch(/transcript v2 of i1 was not read \(404\)/);
    expect(logged()).not.toContain('transcripts/i1');
  });

  it('is the same 404 for a missing id and a document of another type', async () => {
    const store = makeStore([{ id: 'b1', type: 'blog', Title: 'A post' }]);
    for (const id of ['nope', 'b1']) {
      const res = await handlersWith(store).get(makeRequest({ params: { id } }), context);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ ok: false, code: 'NOT_FOUND', error: 'No interview has that id.' });
    }
  });

  it('refuses an id that is not shaped like one before reading', async () => {
    const store = makeStore();
    const res = await handlersWith(store).get(makeRequest({ params: { id: '../x' } }), context);
    expect(res.status).toBe(400);
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});

describe('deleteAudio', () => {
  it('needs the publisher role', async () => {
    const store = makeStore([interviewDoc()]);
    const res = await handlersWith(store, makeBlobs(), 'editor').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(res.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('deletes the recording and every recording it superseded, keeps the transcripts, clears provenance.audio under the etag', async () => {
    const doc = interviewDoc({
      provenance: {
        source: 'upload',
        audio: { container: 'interviews-audio', path: CURRENT, superseded: [OLDER, OLDEST] },
      },
    });
    const store = makeStore([doc]);
    const blobs = makeBlobs([CURRENT, OLDER, OLDEST, 'transcripts/i1/v1.json', 'transcripts/i1/v2.json'], {
      versions: { [CURRENT]: ['v-1'] },
    });
    const res = await handlersWith(store, blobs, 'publisher').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, id: 'i1', deleted: 3 });
    expect([...blobs.present].sort()).toEqual(['transcripts/i1/v1.json', 'transcripts/i1/v2.json']);
    expect(blobs.versionDeletes).toEqual([`${CURRENT}@v-1`]);
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'i1',
      { provenance: { source: 'upload', audio: null }, updatedAt: NOW.toISOString() },
      { ifMatch: '"e9"' }
    );
    expect(logged()).not.toContain(CURRENT);
  });

  it('leaves alone a blob under the interview’s prefix that the document does not name: only the interview delete sweeps', async () => {
    const stray = `audio/i1/${U_STRAY}.mp3`;
    const store = makeStore([interviewDoc()]);
    const blobs = makeBlobs([CURRENT, stray]);
    await handlersWith(store, blobs, 'publisher').deleteAudio(makeRequest({ params: { id: 'i1' } }), context);
    expect([...blobs.present]).toEqual([stray]);
  });

  it('answers 502 and leaves the document alone when the blob could not be deleted', async () => {
    const store = makeStore([interviewDoc()]);
    const blobs = makeBlobs([CURRENT], { failing: [CURRENT] });
    const res = await handlersWith(store, blobs, 'publisher').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(res.status).toBe(502);
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(logged()).toMatch(/not deleted \(503\)/);
    expect(logged()).not.toContain('storage said no');
  });

  it('answers 409 INTERVIEW_BUSY and deletes nothing while a transcription reads the recording', async () => {
    const doc = interviewDoc({ transcription: { version: 1, jobId: 'job-t', status: 'queued' } });
    const store = makeStore([doc]);
    const content = store.readDoc.getMockImplementation();
    let jobStatus = 'running';
    store.readDoc.mockImplementation(async (container, id) =>
      container === 'jobs' && id === 'job-t' ? { id, status: jobStatus } : content(container, id)
    );
    const blobs = makeBlobs([CURRENT]);
    const res = await handlersWith(store, blobs, 'publisher').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('INTERVIEW_BUSY');
    expect([...blobs.present]).toEqual([CURRENT]);
    expect(store.patchDoc).not.toHaveBeenCalled();
    // Once the job has ended the same delete goes through.
    jobStatus = 'succeeded';
    const after = await handlersWith(store, blobs, 'publisher').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(after.status).toBe(200);
    expect([...blobs.present]).toEqual([]);
  });

  it('answers 409 when the document changed since it was read', async () => {
    const store = makeStore([interviewDoc()]);
    store.patchDoc.mockRejectedValueOnce(Object.assign(new Error('precondition'), { code: 412 }));
    const res = await handlersWith(store, makeBlobs([CURRENT]), 'publisher').deleteAudio(
      makeRequest({ params: { id: 'i1' } }),
      context
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('CONFLICT');
  });
});

describe('deleteBlobWithVersions (ADR 0040, D10)', () => {
  it('deletes the base blob first, then every listed version by id: two versions, three deletes', async () => {
    const order = [];
    const sibling = `${CURRENT}.other`;
    const blobs = makeBlobs([CURRENT, sibling], {
      versions: { [CURRENT]: ['v-older', 'v-current'], [sibling]: ['v-x'] },
    });
    blobs.deleteBlob.mockImplementation(async (_c, name) => {
      order.push(`base:${name}`);
      blobs.present.delete(name);
    });
    const outcome = await deleteBlobWithVersions({ blobs, log: context }, 'interviews-audio', CURRENT);
    expect(outcome).toEqual({ versions: 2, versionFailures: 0 });
    expect(blobs.versionDeletes).toEqual([`${CURRENT}@v-older`, `${CURRENT}@v-current`]);
    expect(order).toEqual([`base:${CURRENT}`]);
    expect(blobs.deleteBlob).toHaveBeenCalledTimes(1);
    expect(blobs.getContainerClient).toHaveBeenCalledWith('interviews-audio');
    // A blob whose name merely starts with the same characters is left alone.
    expect(blobs.present.has(sibling)).toBe(true);
  });

  it('still deletes the base blob when the container lists no versions', async () => {
    const blobs = makeBlobs([CURRENT]);
    expect(await deleteBlobWithVersions({ blobs }, 'interviews-audio', CURRENT)).toEqual({
      versions: 0,
      versionFailures: 0,
    });
    expect(blobs.present.has(CURRENT)).toBe(false);
  });

  it('counts a version the identity may not delete and keeps going: the base blob is gone either way', async () => {
    // Before the owner applies the container-scoped Storage Blob Data Owner
    // grant, a version delete answers 403; it must not leave the recording
    // current or fail the caller.
    const blobs = makeBlobs([CURRENT], { versions: { [CURRENT]: ['v-1', 'v-2'] }, versionForbidden: true });
    const outcome = await deleteBlobWithVersions({ blobs, log: context }, 'interviews-audio', CURRENT);
    expect(outcome).toEqual({ versions: 0, versionFailures: 2 });
    expect(blobs.present.has(CURRENT)).toBe(false);
    expect(logged()).toMatch(/a blob version was not deleted \(403\)/);
    expect(logged()).not.toContain('forbidden');
  });
});

describe('ownedRecordingPaths (ADR 0040, D1 and D10 layout)', () => {
  it('names the current recording and every superseded one under audio/<this id>/<upload id>.<ext>', () => {
    const doc = interviewDoc({
      provenance: { audio: { path: CURRENT, superseded: [OLDER, CURRENT, OLDEST] } },
    });
    expect(ownedRecordingPaths(doc, context)).toEqual([CURRENT, OLDER, OLDEST]);
  });

  it('refuses every path outside the layout, and logs how many, never which', () => {
    const planted = [
      `audio/i2/${U_CURRENT}.mp3`,
      `transcripts/i1/v1.json`,
      'audio/i1.mp3',
      `audio/i1/../i2/${U_CURRENT}.mp3`,
      `audio/i1/${U_CURRENT}.exe`,
      `audio/i1/not-an-upload-id.mp3`,
      `audio/i1/${U_CURRENT}.mp3/x`,
      '',
      null,
      42,
    ];
    const doc = interviewDoc({ provenance: { audio: { path: planted[0], superseded: planted.slice(1) } } });
    expect(ownedRecordingPaths(doc, context)).toEqual([]);
    expect(logged()).toMatch(/i1 names 8 recording path\(s\) it does not own/);
    expect(logged()).not.toContain('audio/i2');
  });

  it('is empty for a document with no recording', () => {
    expect(ownedRecordingPaths(interviewDoc({ provenance: { source: 'transcript' } }))).toEqual([]);
    expect(ownedRecordingPaths({})).toEqual([]);
  });
});

describe('deleteInterviewAssets, the interview delete hook', () => {
  it('sweeps the whole audio/<id>/ and transcripts/<id>/ prefixes, versions included, and nothing of another interview', async () => {
    const stray = `audio/i1/${U_STRAY}.wav`;
    const blobs = makeBlobs(
      [
        CURRENT,
        OLDER,
        stray,
        'transcripts/i1/v1.json',
        'transcripts/i1/v2.parts/000.json',
        `audio/i10/${U_CURRENT}.mp3`,
        'transcripts/i10/v1.json',
        'transcripts/other/v1.json',
      ],
      { versions: { [CURRENT]: ['v-1', 'v-2'], 'transcripts/i1/v1.json': ['v-1'], [`audio/i1/${U_GONE}.mp3`]: ['v-9'] } }
    );
    const outcome = await deleteInterviewAssets({ blobs, log: context }, interviewDoc());
    // CURRENT, OLDER, the stray, two transcripts, and a recording whose base
    // is already gone but whose version remains.
    expect(outcome).toEqual({ deleted: 6, failed: 0, versionFailures: 0 });
    expect([...blobs.present].sort()).toEqual(
      [`audio/i10/${U_CURRENT}.mp3`, 'transcripts/i10/v1.json', 'transcripts/other/v1.json'].sort()
    );
    expect(blobs.versionDeletes.sort()).toEqual(
      [`${CURRENT}@v-1`, `${CURRENT}@v-2`, 'transcripts/i1/v1.json@v-1', `audio/i1/${U_GONE}.mp3@v-9`].sort()
    );
    expect(logged()).toContain('i1: 6 blob(s) deleted, 0 failed, 0 version(s) kept');
    expect(logged()).not.toContain('.mp3');
  });

  it('refuses an id that is not shaped like one before listing anything: an empty id would sweep every recording', async () => {
    const blobs = makeBlobs([CURRENT]);
    for (const id of ['', 'a/b', '../i1', undefined]) {
      expect(await deleteInterviewAssets({ blobs, log: context }, interviewDoc({ id }))).toEqual({
        deleted: 0,
        failed: 0,
        versionFailures: 0,
      });
    }
    expect(blobs.getContainerClient).not.toHaveBeenCalled();
    expect(blobs.present.has(CURRENT)).toBe(true);
  });

  it('does nothing for a document that is not an interview', async () => {
    const blobs = makeBlobs([`audio/b1/${U_CURRENT}.mp3`]);
    expect(await deleteInterviewAssets({ blobs }, { id: 'b1', type: 'blog' })).toEqual({
      deleted: 0,
      failed: 0,
      versionFailures: 0,
    });
    expect(blobs.getContainerClient).not.toHaveBeenCalled();
  });

  it('keeps going past one failed blob and reports it', async () => {
    const blobs = makeBlobs([CURRENT, 'transcripts/i1/v1.json'], { failing: [CURRENT] });
    const doc = interviewDoc({ provenance: { source: 'upload', audio: { path: CURRENT } } });
    const outcome = await deleteInterviewAssets({ blobs, log: context }, doc);
    expect(outcome).toEqual({ deleted: 1, failed: 1, versionFailures: 0 });
    expect(blobs.present.has('transcripts/i1/v1.json')).toBe(false);
  });
});

describe('deleting an interview through deleteContentItem: tombstone, delete, sweep (ADR 0040, D10)', () => {
  /** A store whose document is the interview; patch answers a new ETag. */
  function workflowStore(doc, { onTombstone = () => {}, patchError = null } = {}) {
    const calls = [];
    return {
      calls,
      readDoc: vi.fn(async () => doc),
      patchDoc: vi.fn(async (_c, id, updates, options) => {
        calls.push(['patch', options?.ifMatch, updates.provenance?.audio?.deletedAt ?? null]);
        if (patchError) throw patchError;
        onTombstone();
        return { ...doc, ...updates, _etag: '"tomb"' };
      }),
      deleteDocIfMatch: vi.fn(async (_c, id, etag) => {
        calls.push(['delete', etag]);
      }),
      upsertDoc: vi.fn(async (_c, d) => d),
    };
  }
  const run = async (store, blobs) => {
    const { createContentWorkflowHandlers } = await import('../content-workflow.js');
    const handlers = createContentWorkflowHandlers({
      guard: guardAs('publisher'),
      store,
      onInterviewDeleted: (doc, ctx) => deleteInterviewAssets({ blobs, log: ctx }, doc),
      ...fixed,
    });
    return handlers.deleteContentItem(
      { headers: { get: () => 'vitest' }, json: async () => ({ contentId: 'i1' }) },
      context
    );
  };

  it('writes the tombstone under the read ETag, deletes under the tombstone’s ETag, then sweeps', async () => {
    const blobs = makeBlobs([CURRENT, 'transcripts/i1/v1.json']);
    const listedBefore = [];
    const client = blobs.getContainerClient.getMockImplementation();
    blobs.getContainerClient.mockImplementation((...args) => {
      listedBefore.push(store.calls.length);
      return client(...args);
    });
    const store = workflowStore(interviewDoc());
    const res = await run(store, blobs);
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([
      ['patch', '"e9"', NOW.toISOString()],
      ['delete', '"tomb"'],
    ]);
    // Every listing happened after both writes.
    expect(listedBefore.length).toBeGreaterThan(0);
    expect(new Set(listedBefore)).toEqual(new Set([2]));
    expect([...blobs.present]).toEqual([]);
  });

  it('removes a recording an upload committed between the tombstone and the sweep, which the document never named', async () => {
    const late = `audio/i1/${U_STRAY}.m4a`;
    const blobs = makeBlobs([CURRENT]);
    // The completion that read the document before the tombstone commits its
    // blob now; its own pointer write then fails on the ETag, so the
    // document never names it.
    const store = workflowStore(interviewDoc(), { onTombstone: () => blobs.present.add(late) });
    const res = await run(store, blobs);
    expect(res.status).toBe(200);
    expect(blobs.present.has(late)).toBe(false);
    expect(blobs.present.has(CURRENT)).toBe(false);
  });

  it('answers 409 and deletes nothing when the document changed before the tombstone', async () => {
    const blobs = makeBlobs([CURRENT]);
    const store = workflowStore(interviewDoc(), {
      patchError: Object.assign(new Error('precondition'), { code: 412 }),
    });
    const res = await run(store, blobs);
    expect(res.status).toBe(409);
    expect(store.deleteDocIfMatch).not.toHaveBeenCalled();
    expect(blobs.present.has(CURRENT)).toBe(true);
    expect(blobs.getContainerClient).not.toHaveBeenCalled();
  });

  it('writes no tombstone for a document that is not an interview', async () => {
    const store = workflowStore({ id: 'i1', type: 'blog', Title: 'A post', _etag: '"e9"' });
    const res = await run(store, makeBlobs());
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([['delete', '"e9"']]);
  });
});
