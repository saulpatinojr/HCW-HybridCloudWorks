/**
 * The Audio Library's books and courses (ADR 0033 §4): list, read, create,
 * edit and soft-delete. Each route is a function of `ctx` — the factory's
 * bound store reads and scaffold — answering the guarded handler (PR #841
 * split of handlers.js).
 *
 * DELETES ARE SOFT. A book delete stamps `softDeletedAt` on it and every
 * chapter; the public reads already drop those rows (public-reads.js
 * `isSoftDeleted`) and the admin reads drop them here.
 */
import { EPISODE_CONTAINER, SET_CONTAINER, setId } from './publish.js';
import {
  chapterArchiveUpdates,
  parseBookCreate,
  parseBookEdit,
  publishedChapters,
  summarizeChapters,
  toBookView,
  toChapterView,
} from './library.js';
import {
  MAX_CHAPTER_ROWS,
  MAX_SETS,
  isSoftDeleted,
  json,
  noSetMessage,
  parseBody,
  readRequest,
  readRoute,
  truthyQuery,
} from './handlers-shared.js';

/** Newest first, by the last edit or the generation. */
const byRecency = (a, b) =>
  String(b.updatedAt || b.generatedAt || '').localeCompare(
    String(a.updatedAt || a.generatedAt || '')
  );

/**
 * GET /api/cms/listen-and-learn — every book and course, newest first,
 * each with its chapter counts and duration total for the Library grid.
 * Soft-deleted books are never listed; archived ones only with
 * `?archived=1`.
 */
export const listSets = ({ store, guarded }) =>
  guarded(
    'editor',
    'listListenAndLearnSets',
    'Failed to list Listen & Learn sets',
    async ({ request }) => {
      const [rows, chapterRows] = await Promise.all([
        store.queryDocs(SET_CONTAINER, `SELECT TOP ${MAX_SETS} * FROM c`, []),
        store.queryDocs(
          EPISODE_CONTAINER,
          `SELECT TOP ${MAX_CHAPTER_ROWS} c.setId, c.status, c.durationSeconds, c.softDeletedAt, c.softDeleteExpiresAt FROM c`,
          []
        ),
      ]);
      const includeArchived = truthyQuery(request, 'archived');
      const counts = summarizeChapters(chapterRows);
      const items = rows
        .filter((set) => !isSoftDeleted(set) && (includeArchived || !set.archivedAt))
        .sort(byRecency)
        .map((set) => toBookView(set, counts.get(set.id) || null));
      return json(200, { success: true, items, total: items.length });
    }
  );

/**
 * GET /api/cms/listen-and-learn/{platform}/{examCode} — one book and every
 * chapter in it, drafts, failures and archived included. This is the
 * review view, so it deliberately shows what the public read hides.
 */
export const getSet = ({ loadSet, guarded }) =>
  guarded(
    'editor',
    'getListenAndLearnSet',
    'Failed to get the Listen & Learn set',
    async ({ request }) => {
      const route = readRoute(request);
      if (!route.ok) return json(route.status, { error: route.error });
      const { ref } = route;

      const loaded = await loadSet(ref);
      if (loaded.missing) return json(404, { error: noSetMessage(ref) });

      return json(200, {
        success: true,
        set: loaded.set
          ? toBookView(loaded.set, summarizeChapters(loaded.chapters).get(ref.id))
          : null,
        episodes: loaded.chapters.map((doc) => toChapterView(doc, loaded.set)),
      });
    }
  );

/** The set document a create writes, from its parsed body. */
function newBookDoc({ id, body, parsed, at, by }) {
  return {
    id,
    provider: parsed.provider,
    examCode: parsed.examCode,
    ...parsed,
    certSlug: body.certSlug ? String(body.certSlug).trim() : parsed.examCode,
    certTitle: parsed.certTitle || parsed.title,
    studyGuideUrl: null,
    studyGuideTitle: null,
    areaCount: 0,
    areaSlugs: [],
    generatedAt: at,
    generatedBy: by,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    updatedBy: by,
    archivedAt: null,
    softDeletedAt: null,
  };
}

/**
 * POST /api/cms/listen-and-learn
 * `{ provider, kind?, title, examCode?, author?, description?, coverImageUrl?, tags?, voice? }`
 *
 * A book with no certification (ADR 0033 §4), or a course shell for one.
 * 409 when the code is taken: the code is the route and the blob path
 * segment, and a second book under it would share both.
 */
export const createBook = ({ store, stamp, actorOf, guarded }) =>
  guarded(
    'editor',
    'createListenAndLearnBook',
    'Failed to create the book',
    async ({ request, context, auth }) => {
      const read = parseBody(await request.json().catch(() => null), parseBookCreate);
      if (!read.ok) return json(read.status, { error: read.error });
      const { body, parsed } = read;

      const { provider, examCode } = parsed;
      const id = setId(provider, examCode);
      const existing = await store.readDoc(SET_CONTAINER, id, id);
      if (existing && !isSoftDeleted(existing)) {
        return json(409, { error: `A book or course already exists at ${provider}/${examCode}` });
      }

      const by = actorOf(auth);
      const doc = newBookDoc({ id, body, parsed, at: stamp(), by });
      await store.upsertDoc(SET_CONTAINER, doc);
      context.log?.(`createListenAndLearnBook: kind ${doc.kind}`);
      return json(201, { success: true, item: toBookView(doc) });
    }
  );

/** Archive or restore every live chapter of a book, one write each. */
async function archiveChapters(store, ref, chapters, archive, at) {
  for (const chapter of chapters) {
    const fields = chapterArchiveUpdates(chapter, archive, { at, withBook: true });
    if (!fields) continue;
    await store.patchDoc(
      EPISODE_CONTAINER,
      chapter.id,
      { ...fields, updatedAt: at },
      { partitionKey: ref.id }
    );
  }
}

/**
 * PATCH /api/cms/listen-and-learn/{platform}/{examCode}
 * `{ title?, certTitle?, author?, description?, coverImageUrl?, tags?, kind?, voice?, archived? }`
 *
 * Metadata edits and archive / restore. Archiving a book archives every
 * live chapter with it, so the public reads — which select
 * `status = 'published'` — stop serving them in the same stroke; restore
 * puts back the chapters the archive took, and only those.
 */
export const patchBook = ({ store, stamp, actorOf, loadSet, guarded }) =>
  guarded(
    'editor',
    'patchListenAndLearnBook',
    'Failed to update the book',
    async ({ request, context, auth }) => {
      const read = await readRequest(request, { parse: parseBookEdit });
      if (!read.ok) return json(read.status, { error: read.error });
      const { ref, parsed } = read;
      const { fields, archived } = parsed;

      const loaded = await loadSet(ref);
      if (loaded.missing || !loaded.set) return json(404, { error: noSetMessage(ref) });

      const at = stamp();
      const by = actorOf(auth);
      const updates = { ...fields, updatedAt: at, updatedBy: by };
      // Only a move changes anything: archiving an archived book, or
      // restoring a live one, leaves the chapters alone.
      const moves = archived !== undefined && archived !== Boolean(loaded.set.archivedAt);
      if (moves) {
        updates.archivedAt = archived ? at : null;
        await archiveChapters(store, ref, loaded.chapters, archived, at);
      }

      const updated = await store.patchDoc(SET_CONTAINER, ref.id, updates, {
        partitionKey: ref.id,
      });
      context.log?.(
        `patchListenAndLearnBook: ${Object.keys(updates).join(',')}`
      );
      return json(200, {
        success: true,
        item: toBookView(updated || { ...loaded.set, ...updates }),
      });
    }
  );

/** The 409 a delete answers while published chapters are live and `force` is not set. */
function liveChaptersRefusal(live) {
  return json(409, {
    error: `${live.length} published ${live.length === 1 ? 'chapter is' : 'chapters are'} live; confirm to delete them too`,
    published: live.map((c) => ({ id: c.id, title: c.title || c.areaName || c.id })),
  });
}

/**
 * DELETE /api/cms/listen-and-learn/{platform}/{examCode}[?force=1]
 *
 * Soft: stamps `softDeletedAt` on the book and every chapter. Refused
 * with 409 and the list of published chapters unless `force`, because a
 * delete that silently takes live audio off the site is the kind of
 * thing a confirm dialog exists for.
 */
export const deleteBook = ({ store, stamp, actorOf, loadSet, guarded }) =>
  guarded(
    'editor',
    'deleteListenAndLearnBook',
    'Failed to delete the book',
    async ({ request, context, auth }) => {
      const route = readRoute(request);
      if (!route.ok) return json(route.status, { error: route.error });
      const { ref } = route;
      const loaded = await loadSet(ref);
      if (loaded.missing) return json(404, { error: noSetMessage(ref) });
      const live = publishedChapters(loaded.chapters);
      if (live.length > 0 && !truthyQuery(request, 'force')) return liveChaptersRefusal(live);

      const at = stamp();
      const by = actorOf(auth);
      const tombstone = { softDeletedAt: at, softDeletedBy: by, updatedAt: at };
      for (const chapter of loaded.chapters) {
        await store.patchDoc(EPISODE_CONTAINER, chapter.id, tombstone, { partitionKey: ref.id });
      }
      if (loaded.set) {
        await store.patchDoc(SET_CONTAINER, ref.id, tombstone, { partitionKey: ref.id });
      }
      context.log?.(
        `deleteListenAndLearnBook: ${loaded.chapters.length} chapters`
      );
      return json(200, { success: true, id: ref.id, chapters: loaded.chapters.length });
    }
  );
