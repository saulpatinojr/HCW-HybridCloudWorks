/**
 * The Audio Library handlers (ADR 0033 §4): books, chapters, versions and
 * the regeneration enqueue, against an in-memory store. The load-bearing
 * assertions: every route is editor-gated and publishing is publisher-gated;
 * deletes are soft and refuse to take live audio down without `force`; the
 * active version can never be deleted; a regeneration queues the job that
 * matches the chapter's kind; a re-run never clears an approval.
 */
import { describe, it, expect, vi } from 'vitest';
import { createListenAndLearnHandlers, SPEAK_CHAPTER_JOB_TYPE } from './handlers.js';
import { EPISODE_CONTAINER, SET_CONTAINER, STATUS } from './publish.js';
import { LISTEN_AND_LEARN_JOB_TYPE } from './source-episode.js';
import { JOBS_CONTAINER } from '../jobs.js';
import { AiFeatureDisabledError } from '../ai/router.js';

const context = { log: vi.fn(), error: vi.fn() };
const NOW = '2026-10-03T14:05:09.000Z';

const roleLevel = { viewer: 1, editor: 2, publisher: 3, super_admin: 4 };
const guardFor = (role) => ({
  requireRole: vi.fn(async (_request, required) =>
    roleLevel[role] >= roleLevel[required]
      ? { user: { oid: `oid-${role}` }, role, error: null }
      : { user: null, role: null, error: { status: 403, body: '{}' } }
  ),
});
const editor = guardFor('editor');
const publisher = guardFor('publisher');
const deny = guardFor('viewer');

const makeRequest = ({ params = {}, query = {}, body } = {}) => ({
  params,
  query: { get: (k) => query[k] ?? null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

/** A store over plain objects: sets by id, chapters by id within one set. */
function makeStore(seed = {}) {
  const docs = {
    [SET_CONTAINER]: { ...(seed.sets || {}) },
    [EPISODE_CONTAINER]: { ...(seed.chapters || {}) },
    [JOBS_CONTAINER]: {},
    content: { ...(seed.content || {}) },
  };
  return {
    docs,
    readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      docs[container][doc.id] = doc;
      return doc;
    }),
    patchDoc: vi.fn(async (container, id, updates) => {
      docs[container][id] = { ...(docs[container][id] || { id }), ...updates };
      return docs[container][id];
    }),
    queryDocs: vi.fn(async (container, sql) => {
      const rows = Object.values(docs[container] || {});
      // The handlers query chapters by set and the whole set list; a
      // projection reads as the whole document here, which is a superset.
      if (/c\.setId = @setId/.test(sql)) return rows.filter((r) => r.setId === 'azure_az-104');
      return rows;
    }),
  };
}

const set = (over = {}) => ({
  id: 'azure_az-104',
  provider: 'azure',
  examCode: 'AZ-104',
  certTitle: 'Azure Administrator',
  certSlug: 'az-104',
  studyGuideUrl: 'https://learn.microsoft.com/az-104',
  areaSlugs: ['area-1'],
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const chapter = (id, over = {}) => ({
  id,
  setId: 'azure_az-104',
  provider: 'azure',
  examCode: 'AZ-104',
  areaSlug: id,
  areaName: `Area ${id}`,
  title: `Title ${id}`,
  order: 0,
  status: STATUS.draft,
  audioUrl: `/u/${id}.mp3`,
  audioPath: `azure/az-104/${id}.mp3`,
  ...over,
});

const handlers = (store, guard = editor, extra = {}) =>
  createListenAndLearnHandlers({
    guard,
    store,
    now: () => new Date(NOW),
    uuid: () => 'job-1',
    env: { GEMINI_API_KEY: 'g' },
    ...extra,
  });

const parse = (res) => JSON.parse(res.body);
const bookParams = { platform: 'azure', examCode: 'AZ-104' };

describe('auth', () => {
  it('every new handler passes a denial through with zero writes', async () => {
    const store = makeStore();
    const h = handlers(store, deny);
    const enqueue = vi.fn();
    const results = await Promise.all([
      h.createBook(makeRequest({ body: { provider: 'azure', title: 'x' } }), context),
      h.patchBook(makeRequest({ params: bookParams, body: { title: 'x' } }), context),
      h.deleteBook(makeRequest({ params: bookParams }), context),
      h.createChapter(
        makeRequest({ params: bookParams, body: { title: 'x', sourceText: 'y' } }),
        context,
        { enqueue }
      ),
      h.patchChapter(
        makeRequest({ params: { ...bookParams, chapterId: 'a' }, body: { title: 'x' } }),
        context
      ),
      h.reorderChapters(makeRequest({ params: bookParams, body: { order: ['a'] } }), context),
      h.deleteChapter(makeRequest({ params: { ...bookParams, chapterId: 'a' } }), context),
      h.deleteVersion(
        makeRequest({ params: { ...bookParams, chapterId: 'a', versionId: 'b' } }),
        context
      ),
      h.regenerateChapter(
        makeRequest({ params: { ...bookParams, chapterId: 'a' }, body: {} }),
        context,
        { enqueue }
      ),
      h.speechOptions(makeRequest(), context),
      h.estimateSpeech(makeRequest({ body: { bytes: 10 } }), context),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(11).fill(403));
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('publishing is publisher-gated while withdrawing stays editor (ADR 0033 §4)', async () => {
    const store = makeStore({ chapters: { 'area-1': chapter('area-1') } });
    const body = { platform: 'azure', examCode: 'AZ-104', areaSlug: 'area-1' };
    const asEditor = await handlers(store, editor).reviewEpisode(
      makeRequest({ body: { ...body, status: 'published' } }),
      context
    );
    expect(asEditor.status).toBe(403);
    expect(editor.requireRole).toHaveBeenLastCalledWith(expect.anything(), 'publisher');

    const asPublisher = await handlers(store, publisher).reviewEpisode(
      makeRequest({ body: { ...body, status: 'published' } }),
      context
    );
    expect(asPublisher.status).toBe(200);
    expect(store.docs[EPISODE_CONTAINER]['area-1'].status).toBe('published');

    const withdraw = await handlers(store, editor).reviewEpisode(
      makeRequest({ body: { ...body, status: 'draft' } }),
      context
    );
    expect(withdraw.status).toBe(200);
    expect(editor.requireRole).toHaveBeenLastCalledWith(expect.anything(), 'editor');
  });
});

describe('listSets — the Library grid', () => {
  it('attaches counts and a duration total, hides soft-deleted books, and archived ones unless asked', async () => {
    const store = makeStore({
      sets: {
        'azure_az-104': set(),
        azure_old: set({ id: 'azure_old', examCode: 'old', archivedAt: 'x' }),
        azure_gone: set({ id: 'azure_gone', examCode: 'gone', softDeletedAt: 'x' }),
      },
      chapters: {
        'area-1': chapter('area-1', { status: STATUS.published, durationSeconds: 120 }),
        'area-2': chapter('area-2', { durationSeconds: 60 }),
      },
    });
    const res = parse(await handlers(store).listSets(makeRequest(), context));
    expect(res.items.map((i) => i.id)).toEqual(['azure_az-104']);
    expect(res.items[0].counts).toEqual({
      chapters: 2,
      published: 1,
      drafts: 1,
      failed: 0,
      archived: 0,
      durationSeconds: 180,
    });
    expect(res.items[0].kind).toBe('course');
    expect(res.items[0].title).toBe('Azure Administrator');

    const withArchived = parse(
      await handlers(store).listSets(makeRequest({ query: { archived: '1' } }), context)
    );
    expect(withArchived.items.map((i) => i.id).sort()).toEqual(['azure_az-104', 'azure_old']);
  });
});

describe('books', () => {
  it('creates a book from a title, 409s a second under the same code, and reads it back as a book', async () => {
    const store = makeStore();
    const res = await handlers(store).createBook(
      makeRequest({ body: { provider: 'azure', title: 'Zero Trust Explained', author: 'Saul' } }),
      context
    );
    expect(res.status).toBe(201);
    expect(parse(res).item).toMatchObject({
      id: 'azure_zero-trust-explained',
      kind: 'book',
      title: 'Zero Trust Explained',
      author: 'Saul',
      examCode: 'zero-trust-explained',
      areaSlugs: [],
    });
    const again = await handlers(store).createBook(
      makeRequest({ body: { provider: 'azure', title: 'zero trust explained' } }),
      context
    );
    expect(again.status).toBe(409);
    expect(
      (await handlers(store).createBook(makeRequest({ body: { title: 'no provider' } }), context))
        .status
    ).toBe(400);
  });

  it('patches metadata and a voice, and archives every live chapter with the book, then restores only those', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: {
        'area-1': chapter('area-1', { status: STATUS.published }),
        'area-2': chapter('area-2', {
          status: STATUS.archived,
          statusBeforeArchive: 'draft',
          archivedAt: 'earlier',
        }),
      },
    });
    const h = handlers(store);
    const patched = await h.patchBook(
      makeRequest({
        params: bookParams,
        body: { title: 'AZ-104 Audio Course', voice: { narrator: 'Puck' }, tags: ['Azure'] },
      }),
      context
    );
    expect(patched.status).toBe(200);
    expect(parse(patched).item).toMatchObject({ title: 'AZ-104 Audio Course', tags: ['azure'] });
    expect(parse(patched).item.voice.narrator).toBe('Puck');

    const archived = await h.patchBook(
      makeRequest({ params: bookParams, body: { archived: true } }),
      context
    );
    expect(archived.status).toBe(200);
    expect(store.docs[SET_CONTAINER]['azure_az-104'].archivedAt).toBe(NOW);
    expect(store.docs[EPISODE_CONTAINER]['area-1']).toMatchObject({
      status: STATUS.archived,
      statusBeforeArchive: 'published',
      archivedWithBook: true,
    });
    // Already archived by hand: untouched.
    expect(store.docs[EPISODE_CONTAINER]['area-2'].archivedAt).toBe('earlier');

    await h.patchBook(makeRequest({ params: bookParams, body: { archived: false } }), context);
    expect(store.docs[SET_CONTAINER]['azure_az-104'].archivedAt).toBeNull();
    expect(store.docs[EPISODE_CONTAINER]['area-1'].status).toBe('published');
    expect(store.docs[EPISODE_CONTAINER]['area-2'].status).toBe(STATUS.archived);
  });

  it('refuses a bad patch by sentence and 404s a missing book', async () => {
    const store = makeStore({ sets: { 'azure_az-104': set() } });
    expect(
      (
        await handlers(store).patchBook(
          makeRequest({ params: bookParams, body: { kind: 'x' } }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (await handlers(store).patchBook(makeRequest({ params: bookParams, body: {} }), context))
        .status
    ).toBe(400);
    expect(
      (
        await handlers(store).patchBook(
          makeRequest({ params: { platform: 'aws', examCode: 'none' }, body: { title: 'x' } }),
          context
        )
      ).status
    ).toBe(404);
  });

  it('soft-deletes, refusing with the published list unless forced', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: {
        'area-1': chapter('area-1', { status: STATUS.published }),
        'area-2': chapter('area-2'),
      },
    });
    const refused = await handlers(store).deleteBook(makeRequest({ params: bookParams }), context);
    expect(refused.status).toBe(409);
    expect(parse(refused).published).toEqual([{ id: 'area-1', title: 'Title area-1' }]);
    expect(store.patchDoc).not.toHaveBeenCalled();

    const forced = await handlers(store).deleteBook(
      makeRequest({ params: bookParams, query: { force: '1' } }),
      context
    );
    expect(forced.status).toBe(200);
    expect(store.docs[SET_CONTAINER]['azure_az-104'].softDeletedAt).toBe(NOW);
    expect(store.docs[EPISODE_CONTAINER]['area-1'].softDeletedAt).toBe(NOW);
    expect(store.docs[EPISODE_CONTAINER]['area-2'].softDeletedAt).toBe(NOW);
    // Gone from the admin reads too.
    const list = parse(await handlers(store).listSets(makeRequest(), context));
    expect(list.items).toEqual([]);
    expect(
      (await handlers(store).getSet(makeRequest({ params: bookParams }), context)).status
    ).toBe(404);
  });
});

describe('chapters', () => {
  it('creates a hand-made chapter from pasted text at the end of the book and queues its reading', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': chapter('area-1', { order: 4 }) },
    });
    const enqueue = vi.fn();
    const res = await handlers(store).createChapter(
      makeRequest({
        params: bookParams,
        body: { title: 'Closing thoughts', sourceText: 'Thank you for listening.' },
      }),
      context,
      { enqueue }
    );
    expect(res.status).toBe(201);
    const body = parse(res);
    expect(body.item).toMatchObject({
      id: 'manual_closing-thoughts',
      kind: 'manual',
      order: 5,
      status: 'draft',
      sourceText: 'Thank you for listening.',
      versions: [],
      droppedFromGuide: false,
    });
    expect(body.job).toMatchObject({ ok: true, jobId: 'job-1', type: SPEAK_CHAPTER_JOB_TYPE });
    expect(body.job.speech).toMatchObject({ provider: 'gemini' });
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: SPEAK_CHAPTER_JOB_TYPE });
    expect(store.docs[JOBS_CONTAINER]['job-1'].payload).toEqual({
      platform: 'azure',
      examCode: 'AZ-104',
      chapterId: 'manual_closing-thoughts',
    });
  });

  it('reads the text from a content item, dropping its markup, and 404s an unknown item', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      content: { 'c-1': { id: 'c-1', postContent: '<p>From the <em>article</em>.</p>' } },
    });
    const res = await handlers(store).createChapter(
      makeRequest({
        params: bookParams,
        body: { title: 'From content', contentId: 'c-1', speak: false },
      }),
      context,
      { enqueue: vi.fn() }
    );
    expect(res.status).toBe(201);
    expect(parse(res).item).toMatchObject({
      sourceText: 'From the article.',
      sourceContentId: 'c-1',
    });
    expect(parse(res).job).toBeNull();
    expect(
      (
        await handlers(store).createChapter(
          makeRequest({ params: bookParams, body: { title: 'Missing', contentId: 'c-9' } }),
          context,
          { enqueue: vi.fn() }
        )
      ).status
    ).toBe(404);
  });

  it('409s a duplicate title and 400s a chapter with nothing to speak', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { manual_dup: chapter('manual_dup', { kind: 'manual' }) },
    });
    expect(
      (
        await handlers(store).createChapter(
          makeRequest({ params: bookParams, body: { title: 'Dup', sourceText: 'x' } }),
          context,
          { enqueue: vi.fn() }
        )
      ).status
    ).toBe(409);
    expect(
      (
        await handlers(store).createChapter(
          makeRequest({ params: bookParams, body: { title: 'Empty' } }),
          context,
          {
            enqueue: vi.fn(),
          }
        )
      ).status
    ).toBe(400);
  });

  it('renames, repositions, archives and restores a chapter, marking hand edits so a re-run keeps them', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': chapter('area-1', { status: STATUS.published }) },
    });
    const h = handlers(store);
    const params = { ...bookParams, chapterId: 'area-1' };
    const renamed = await h.patchChapter(
      makeRequest({ params, body: { title: 'Identity', order: 3 } }),
      context
    );
    expect(renamed.status).toBe(200);
    expect(store.docs[EPISODE_CONTAINER]['area-1']).toMatchObject({
      title: 'Identity',
      titleEditedAt: NOW,
      order: 3,
      orderEditedAt: NOW,
    });

    await h.patchChapter(makeRequest({ params, body: { archived: true } }), context);
    expect(store.docs[EPISODE_CONTAINER]['area-1']).toMatchObject({
      status: STATUS.archived,
      statusBeforeArchive: 'published',
      archivedAt: NOW,
    });
    await h.patchChapter(makeRequest({ params, body: { archived: false } }), context);
    expect(store.docs[EPISODE_CONTAINER]['area-1'].status).toBe('published');
    expect(store.docs[EPISODE_CONTAINER]['area-1'].archivedAt).toBeNull();

    expect((await h.patchChapter(makeRequest({ params, body: {} }), context)).status).toBe(400);
    expect(
      (
        await h.patchChapter(
          makeRequest({ params: { ...bookParams, chapterId: 'nope' }, body: { title: 'x' } }),
          context
        )
      ).status
    ).toBe(404);
  });

  it('"Keep current" clears a regeneration error and leaves everything else', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: {
        'area-1': chapter('area-1', {
          status: STATUS.published,
          lastError: { message: 'HTTP 500' },
        }),
      },
    });
    const res = await handlers(store).patchChapter(
      makeRequest({ params: { ...bookParams, chapterId: 'area-1' }, body: { clearError: true } }),
      context
    );
    expect(res.status).toBe(200);
    expect(store.docs[EPISODE_CONTAINER]['area-1'].lastError).toBeNull();
    expect(store.docs[EPISODE_CONTAINER]['area-1'].status).toBe('published');
  });

  it('reorders with one write per chapter that moved', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: {
        a: chapter('a', { order: 0 }),
        b: chapter('b', { order: 1 }),
        c: chapter('c', { order: 2 }),
      },
    });
    const res = await handlers(store).reorderChapters(
      makeRequest({ params: bookParams, body: { order: ['a', 'c', 'b'] } }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res).changed).toBe(2);
    expect(store.patchDoc).toHaveBeenCalledTimes(2);
    expect(store.docs[EPISODE_CONTAINER].c.order).toBe(1);
    expect(store.docs[EPISODE_CONTAINER].b.order).toBe(2);
    expect(store.docs[EPISODE_CONTAINER].a.orderEditedAt).toBeUndefined();
    expect(
      (
        await handlers(store).reorderChapters(
          makeRequest({ params: bookParams, body: { order: ['a', 'zzz'] } }),
          context
        )
      ).status
    ).toBe(404);
  });

  it('soft-deletes a chapter, refusing a published one unless forced', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': chapter('area-1', { status: STATUS.published }) },
    });
    const params = { ...bookParams, chapterId: 'area-1' };
    expect((await handlers(store).deleteChapter(makeRequest({ params }), context)).status).toBe(
      409
    );
    const forced = await handlers(store).deleteChapter(
      makeRequest({ params, query: { force: 'true' } }),
      context
    );
    expect(forced.status).toBe(200);
    expect(store.docs[EPISODE_CONTAINER]['area-1'].softDeletedAt).toBe(NOW);
    expect((await handlers(store).deleteChapter(makeRequest({ params }), context)).status).toBe(
      404
    );
  });
});

describe('versions', () => {
  const versioned = () =>
    chapter('area-1', {
      audioUrl: '/u/b',
      audioPath: 'azure/az-104/area-1-20261002000000.mp3',
      versions: [
        {
          id: '20261001000000',
          audioUrl: '/u/a',
          audioPath: 'azure/az-104/area-1-20261001000000.mp3',
          active: false,
          audioBytes: 1,
          durationSeconds: 10,
        },
        {
          id: '20261002000000',
          audioUrl: '/u/b',
          audioPath: 'azure/az-104/area-1-20261002000000.mp3',
          active: true,
          audioBytes: 2,
          durationSeconds: 20,
        },
      ],
    });

  it('makes another take active and mirrors it onto the top-level fields', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': versioned() },
    });
    const res = await handlers(store).patchChapter(
      makeRequest({
        params: { ...bookParams, chapterId: 'area-1' },
        body: { activeVersionId: '20261001000000' },
      }),
      context
    );
    expect(res.status).toBe(200);
    const doc = store.docs[EPISODE_CONTAINER]['area-1'];
    expect(doc.versions.map((v) => v.active)).toEqual([true, false]);
    expect(doc).toMatchObject({ audioUrl: '/u/a', audioBytes: 1, durationSeconds: 10 });
    expect(parse(res).item.activeVersionId).toBe('20261001000000');
    expect(
      (
        await handlers(store).patchChapter(
          makeRequest({
            params: { ...bookParams, chapterId: 'area-1' },
            body: { activeVersionId: 'nope' },
          }),
          context
        )
      ).status
    ).toBe(404);
  });

  it('deletes an inactive take and its blob, and never the active one', async () => {
    const deleteBlob = vi.fn(async () => {});
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': versioned() },
    });
    const h = handlers(store, editor, { storage: { deleteBlob } });
    const active = await h.deleteVersion(
      makeRequest({ params: { ...bookParams, chapterId: 'area-1', versionId: '20261002000000' } }),
      context
    );
    expect(active.status).toBe(409);
    expect(deleteBlob).not.toHaveBeenCalled();

    const gone = await h.deleteVersion(
      makeRequest({ params: { ...bookParams, chapterId: 'area-1', versionId: '20261001000000' } }),
      context
    );
    expect(gone.status).toBe(200);
    expect(deleteBlob).toHaveBeenCalledWith(
      'listenandlearn',
      'azure/az-104/area-1-20261001000000.mp3'
    );
    expect(store.docs[EPISODE_CONTAINER]['area-1'].versions.map((v) => v.id)).toEqual([
      '20261002000000',
    ]);
    // The active take is untouched.
    expect(store.docs[EPISODE_CONTAINER]['area-1'].audioUrl).toBe('/u/b');
  });

  it('refuses to delete the implicit legacy version while it is the only take', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': chapter('area-1') },
    });
    const res = await handlers(store).deleteVersion(
      makeRequest({ params: { ...bookParams, chapterId: 'area-1', versionId: 'legacy' } }),
      context
    );
    expect(res.status).toBe(409);
  });
});

describe('regenerateChapter — one chapter, the right job', () => {
  const run = (store, chapterId, body = {}) =>
    handlers(store).regenerateChapter(
      makeRequest({ params: { ...bookParams, chapterId }, body }),
      context,
      { enqueue: vi.fn() }
    );

  it('re-reads a guide chapter from the set’s study guide, scoped to its area, with the estimate', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { 'area-1': chapter('area-1') },
    });
    // A ttsModel in the body is ignored (ADR 0034 slice 5): the model is the
    // listenAndLearnSpeech task's, read by the job when it runs.
    const res = await run(store, 'area-1', { ttsModel: 'gemini-3.1-flash-tts-preview' });
    expect(res.status).toBe(202);
    const body = parse(res);
    expect(body).toMatchObject({
      ok: true,
      jobId: 'job-1',
      type: LISTEN_AND_LEARN_JOB_TYPE,
      chapterId: 'area-1',
    });
    // No router wired here, so the estimate prices the switch's own default.
    expect(body.speech).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-flash-preview-tts',
    });
    expect(body.speech.estimatedCostUsd).toBeGreaterThan(0);
    expect(store.docs[JOBS_CONTAINER]['job-1'].payload).toEqual({
      platform: 'azure',
      examCode: 'AZ-104',
      studyGuideUrl: 'https://learn.microsoft.com/az-104',
      areas: ['area-1'],
      certTitle: 'Azure Administrator',
      certSlug: 'az-104',
    });
  });

  it('re-reads a source chapter from its stored sources', async () => {
    const sources = [{ kind: 'page', url: 'https://example.com/a' }];
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: {
        source_entra: chapter('source_entra', { kind: 'source', areaName: 'Entra', sources }),
      },
    });
    const res = await run(store, 'source_entra');
    expect(res.status).toBe(202);
    expect(store.docs[JOBS_CONTAINER]['job-1'].payload).toMatchObject({
      title: 'Entra',
      sources,
      certTitle: 'Azure Administrator',
    });
    expect(store.docs[JOBS_CONTAINER]['job-1'].payload).not.toHaveProperty('studyGuideUrl');
  });

  it('speaks a hand-made chapter’s text through the speak job, priced by its bytes', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set() },
      chapters: { manual_x: chapter('manual_x', { kind: 'manual', sourceText: 'Hello there.' }) },
    });
    const res = await run(store, 'manual_x');
    expect(res.status).toBe(202);
    expect(parse(res).type).toBe(SPEAK_CHAPTER_JOB_TYPE);
    expect(parse(res).speech.bytes).toBe(12);
    expect(store.docs[JOBS_CONTAINER]['job-1'].payload).toEqual({
      platform: 'azure',
      examCode: 'AZ-104',
      chapterId: 'manual_x',
    });
  });

  it('refuses by sentence: no text, no study guide, a bad model, an unknown chapter', async () => {
    const store = makeStore({
      sets: { 'azure_az-104': set({ studyGuideUrl: null }) },
      chapters: {
        manual_empty: chapter('manual_empty', { kind: 'manual', sourceText: null }),
        'area-1': chapter('area-1'),
      },
    });
    expect(parse(await run(store, 'manual_empty')).error).toMatch(/no text to speak/);
    expect(parse(await run(store, 'area-1')).error).toMatch(/study guide/);
    // A model in the body is ignored rather than refused (slice 5): the
    // refusal here is the missing study guide, never the model.
    expect(parse(await run(store, 'area-1', { ttsModel: 'nope' })).error).not.toMatch(/ttsModel/);
    expect((await run(store, 'missing')).status).toBe(404);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('speech options and the estimate', () => {
  it('names the default model, the voices, the providers and the one that would run', async () => {
    const store = makeStore();
    const res = parse(await handlers(store).speechOptions(makeRequest(), context));
    expect(res.defaultModel).toBe('gemini-2.5-flash-preview-tts');
    // No router wired: the task's model is unknown here, and nothing is editable.
    expect(res.model).toBeNull();
    expect(res).not.toHaveProperty('models');
    expect(res).not.toHaveProperty('storedModel');
    expect(res.voices.gemini).toHaveLength(30);
    expect(res.speech.wouldRun).toBe('gemini');
    expect(res.speech.providers.find((p) => p.id === 'elevenlabs').allowed).toBe(false);
  });

  it('reports the listenAndLearnSpeech task’s effective model through the router (ADR 0034 slice 5)', async () => {
    const store = makeStore();
    const ai = {
      modelForTask: vi.fn(async () => ({
        provider: 'gemini',
        model: 'gemini-3.1-flash-tts-preview',
        selection: 'custom',
        why: 'custom chain, step 1 · model gemini-3.1-flash-tts-preview',
      })),
    };
    const res = parse(await handlers(store, editor, { ai }).speechOptions(makeRequest(), context));
    expect(ai.modelForTask).toHaveBeenCalledWith({ task: 'listenAndLearnSpeech' });
    expect(res.model).toMatchObject({
      task: 'listenAndLearnSpeech',
      provider: 'gemini',
      model: 'gemini-3.1-flash-tts-preview',
      why: expect.stringContaining('custom chain'),
    });
    expect(res.model.perEpisodeUsd).toBeGreaterThan(0);

    // The router's own (authored) refusal is shown whole (#945).
    const off = new AiFeatureDisabledError('listenAndLearnSpeech');
    const refused = { modelForTask: vi.fn(async () => Promise.reject(off)) };
    const said = parse(
      await handlers(store, editor, { ai: refused }).speechOptions(makeRequest(), context)
    );
    expect(said.model).toEqual({
      task: 'listenAndLearnSpeech',
      provider: null,
      model: null,
      error: off.message,
    });
  });

  it('prices text or bytes with the task’s model, by the book’s voice when one is named', async () => {
    // A book's voice.model is dropped on read (slice 5); the provider stays.
    const store = makeStore({
      sets: {
        'azure_az-104': set({
          voice: { provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' },
        }),
      },
    });
    const plain = parse(
      await handlers(store).estimateSpeech(makeRequest({ body: { text: 'Hello' } }), context)
    );
    expect(plain).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-flash-preview-tts',
      bytes: 5,
    });
    const forBook = parse(
      await handlers(store).estimateSpeech(
        makeRequest({ body: { bytes: 9000, platform: 'azure', examCode: 'AZ-104' } }),
        context
      )
    );
    expect(forBook.model).toBe('gemini-2.5-flash-preview-tts');
    expect(forBook.estimatedCostUsd).toBeCloseTo(plain.estimatedCostUsd * (9000 / 5), 1);

    // With the router wired, the task's model prices the estimate; a
    // ttsModel in the body is ignored.
    const ai = {
      modelForTask: vi.fn(async () => ({ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' })),
    };
    const best = parse(
      await handlers(store, editor, { ai }).estimateSpeech(
        makeRequest({ body: { bytes: 9000, ttsModel: 'gemini-2.5-flash-preview-tts' } }),
        context
      )
    );
    expect(best.model).toBe('gemini-3.1-flash-tts-preview');
    expect(best.estimatedCostUsd).toBeCloseTo(forBook.estimatedCostUsd * 2, 6);
    expect((await handlers(store).estimateSpeech(makeRequest({ body: {} }), context)).status).toBe(
      400
    );
  });
});
