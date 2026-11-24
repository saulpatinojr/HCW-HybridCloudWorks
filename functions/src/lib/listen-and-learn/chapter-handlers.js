/**
 * The Audio Library's chapters and their audio versions (ADR 0033 §4):
 * create, edit, reorder, soft-delete, delete one take, and queue a
 * regeneration. Each route is a function of `ctx` answering the guarded
 * handler (PR #841 split of handlers.js). The pure planning — the patch a
 * chapter edit produces, which job regenerates which kind — is in
 * chapter-plans.js.
 *
 * Nothing is removed from storage except a single audio VERSION's blob when
 * that version is deleted by hand — never the active one.
 */
import {
  AUDIO_CONTAINER,
  EPISODE_CONTAINER,
  SET_CONTAINER,
  STATUS,
  activeVersionOf,
  versionsOf,
} from './publish.js';
import { parseChapterCreate, parseChapterPatch, parseReorder, toChapterView } from './library.js';
import {
  isSoftDeleted,
  json,
  noChapterMessage,
  noSetMessage,
  readRequest,
  readRoute,
  truthyQuery,
} from './handlers-shared.js';
import {
  SPEAK_CHAPTER_JOB_TYPE,
  chapterPatchUpdates,
  newChapterDoc,
  regenerationPlan,
} from './chapter-plans.js';

/** The regenerate body carries nothing the server reads; a `ttsModel` is ignored (the model is the task's). */
const parseRegenerateBody = () => ({ value: {} });

/** Queue the first reading of a new chapter; the 202 body, or null unwired. */
async function speakNewChapter(ctx, { ref, doc, set, sourceText, user, enqueue, context }) {
  if (typeof enqueue !== 'function') {
    context.error?.('createChapter: no queue output wired');
    return null;
  }
  const accepted = await ctx.queueJob({
    type: SPEAK_CHAPTER_JOB_TYPE,
    payload: { platform: ref.platform, examCode: ref.examCode, chapterId: doc.id },
    user,
    enqueue,
    extra: {
      speech: await ctx.estimateFor(set, { bytes: Buffer.byteLength(sourceText, 'utf8') }),
    },
  });
  return JSON.parse(accepted.body);
}

/**
 * POST /api/cms/listen-and-learn/{platform}/{examCode}/chapters
 * `{ title, sourceText? | contentId?, speak? }`
 *
 * A hand-made chapter (ADR 0033 §4): its text is pasted, or read from a
 * content item's body with the markup dropped. Lands as a draft with no
 * audio and, unless `speak: false`, queues the job that reads it, whose
 * id the 201 carries so the page can follow it.
 */
export const createChapter = (ctx) =>
  ctx.guarded(
    'editor',
    'createListenAndLearnChapter',
    'Failed to create the chapter',
    async ({ request, context, auth, io }) => {
      const { store, stamp, actorOf, resolveChapterText, nextChapterOrder } = ctx;
      const read = await readRequest(request, { parse: parseChapterCreate });
      if (!read.ok) return json(read.status, { error: read.error });
      const { ref, parsed } = read;

      const set = await store.readDoc(SET_CONTAINER, ref.id, ref.id);
      if (!set || isSoftDeleted(set)) return json(404, { error: noSetMessage(ref) });

      const text = await resolveChapterText(parsed);
      if (!text.ok) return json(text.status, { error: text.error });
      const { sourceText } = text;

      const existing = await store.readDoc(EPISODE_CONTAINER, parsed.id, ref.id);
      if (existing && !isSoftDeleted(existing)) {
        return json(409, {
          error: `A chapter titled "${parsed.title}" already exists; rename it`,
        });
      }

      const order = await nextChapterOrder(ref);
      const at = stamp();
      const by = actorOf(auth);
      const doc = newChapterDoc({ ref, parsed, sourceText, order, at, by });
      await store.upsertDoc(EPISODE_CONTAINER, doc);

      const queued = parsed.speak
        ? await speakNewChapter(ctx, {
            ref,
            doc,
            set,
            sourceText,
            user: auth.user,
            enqueue: io.enqueue,
            context,
          })
        : null;

      context.log?.('createListenAndLearnChapter: created');
      return json(201, { success: true, item: toChapterView(doc, set), job: queued });
    }
  );

/**
 * PATCH /api/cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}
 * `{ title?, order?, sourceText?, activeVersionId?, archived?, clearError? }`
 *
 * Rename, reposition, change the text to speak next time, choose which
 * take is live, archive / restore, or keep the current take after a
 * failed regeneration (`clearError`). Choosing a version rewrites the
 * top-level audio fields from it, so the public players follow.
 */
export const patchChapter = ({ store, stamp, actorOf, loadChapter, guarded }) =>
  guarded(
    'editor',
    'patchListenAndLearnChapter',
    'Failed to update the chapter',
    async ({ request, context, auth }) => {
      const read = await readRequest(request, { chapter: true, parse: parseChapterPatch });
      if (!read.ok) return json(read.status, { error: read.error });
      const { ref, chapterId, parsed } = read;

      const chapter = await loadChapter(ref, chapterId);
      if (!chapter) return json(404, { error: noChapterMessage(ref, chapterId) });

      const at = stamp();
      const by = actorOf(auth);
      const planned = chapterPatchUpdates(chapter, parsed, { at, by });
      if (!planned.ok) return json(planned.status, { error: planned.error });
      const { updates } = planned;

      const updated = await store.patchDoc(EPISODE_CONTAINER, chapterId, updates, {
        partitionKey: ref.id,
      });
      const set = await store.readDoc(SET_CONTAINER, ref.id, ref.id);
      context.log?.(
        `patchListenAndLearnChapter: ${Object.keys(updates).join(',')}`
      );
      return json(200, {
        success: true,
        item: toChapterView(updated || { ...chapter, ...updates }, set),
      });
    }
  );

/**
 * PATCH /api/cms/listen-and-learn/{platform}/{examCode}/chapters
 * `{ order: [chapterId, …] }` — the new order, first to last. One write
 * per chapter whose position changed, none for the rest.
 */
export const reorderChapters = ({ store, stamp, actorOf, loadSet, guarded }) =>
  guarded(
    'editor',
    'reorderListenAndLearnChapters',
    'Failed to reorder the chapters',
    async ({ request, context, auth }) => {
      const read = await readRequest(request, { parse: parseReorder });
      if (!read.ok) return json(read.status, { error: read.error });
      const { ref, parsed: order } = read;

      const loaded = await loadSet(ref);
      if (loaded.missing) return json(404, { error: noSetMessage(ref) });
      const byId = new Map(loaded.chapters.map((c) => [c.id, c]));
      const unknown = order.filter((id) => !byId.has(id));
      if (unknown.length) {
        return json(404, {
          error: `Unknown chapter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
        });
      }

      const at = stamp();
      let changed = 0;
      for (const [index, id] of order.entries()) {
        if (byId.get(id).order === index) continue;
        await store.patchDoc(
          EPISODE_CONTAINER,
          id,
          { order: index, orderEditedAt: at, updatedAt: at, updatedBy: actorOf(auth) },
          { partitionKey: ref.id }
        );
        changed += 1;
      }
      context.log?.(`reorderListenAndLearnChapters: ${changed} moved`);
      return json(200, { success: true, changed, order });
    }
  );

/**
 * DELETE /api/cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}[?force=1]
 * Soft; refused with 409 for a published chapter unless `force`.
 */
export const deleteChapter = ({ store, stamp, actorOf, loadChapter, guarded }) =>
  guarded(
    'editor',
    'deleteListenAndLearnChapter',
    'Failed to delete the chapter',
    async ({ request, context, auth }) => {
      const route = readRoute(request, { chapter: true });
      if (!route.ok) return json(route.status, { error: route.error });
      const { ref, chapterId } = route;
      const chapter = await loadChapter(ref, chapterId);
      if (!chapter) return json(404, { error: noChapterMessage(ref, chapterId) });
      if (chapter.status === STATUS.published && !truthyQuery(request, 'force')) {
        return json(409, {
          error: 'This chapter is published; confirm to take it off the site and delete it',
          published: [{ id: chapter.id, title: chapter.title || chapter.areaName || chapter.id }],
        });
      }
      const at = stamp();
      const by = actorOf(auth);
      await store.patchDoc(
        EPISODE_CONTAINER,
        chapterId,
        { softDeletedAt: at, softDeletedBy: by, updatedAt: at },
        { partitionKey: ref.id }
      );
      context.log?.('deleteListenAndLearnChapter: deleted');
      return json(200, { success: true, id: chapterId });
    }
  );

/**
 * DELETE /api/cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}/versions/{versionId}
 *
 * Removes one take: its blob and its entry. Never the active one — the
 * players would point at nothing — and never the implicit `legacy`
 * version's blob while it is the only take, for the same reason.
 */
export const deleteVersion = ({ store, storage, stamp, actorOf, loadChapter, guarded }) =>
  guarded(
    'editor',
    'deleteListenAndLearnVersion',
    'Failed to delete the version',
    async ({ request, context, auth }) => {
      const route = readRoute(request, { chapter: true, version: true });
      if (!route.ok) return json(route.status, { error: route.error });
      const { ref, chapterId, versionId } = route;
      const chapter = await loadChapter(ref, chapterId);
      if (!chapter) return json(404, { error: noChapterMessage(ref, chapterId) });

      const versions = versionsOf(chapter);
      const target = versions.find((v) => v.id === versionId);
      if (!target) return json(404, { error: `No version ${versionId} on this chapter` });
      if (target.active || activeVersionOf(chapter)?.id === versionId) {
        return json(409, {
          error: 'The active version cannot be deleted; make another one active first',
        });
      }

      if (target.audioPath && typeof storage.deleteBlob === 'function') {
        await storage.deleteBlob(AUDIO_CONTAINER, target.audioPath);
      }
      const at = stamp();
      const by = actorOf(auth);
      const remaining = versions.filter((v) => v.id !== versionId);
      await store.patchDoc(
        EPISODE_CONTAINER,
        chapterId,
        { versions: remaining, updatedAt: at, updatedBy: by },
        { partitionKey: ref.id }
      );
      context.log?.(
        `deleteListenAndLearnVersion: ${remaining.length} version(s) left`
      );
      return json(200, { success: true, id: versionId, versions: remaining });
    }
  );

/**
 * POST /api/cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}/regenerate
 * `{}` — a `ttsModel` is ignored; the model is the task's (ADR 0034 slice 5)
 *
 * One chapter, a new take (ADR 0033 §4). Which job runs depends on the
 * chapter's kind — `REGENERATION_PLANS` in chapter-plans.js. Each lands as
 * a new active version; the approval is kept; a failure keeps the current
 * take live. The 202 carries the expected speech spend.
 */
export const regenerateChapter = (ctx) =>
  ctx.guarded(
    'editor',
    'regenerateListenAndLearnChapter',
    'Failed to queue the regeneration',
    async ({ request, context, auth, io }) => {
      const { store, loadChapter, estimateFor, queueJob } = ctx;
      const read = await readRequest(request, {
        chapter: true,
        parse: parseRegenerateBody,
        emptyBody: true,
      });
      if (!read.ok) return json(read.status, { error: read.error });
      const { ref, chapterId } = read;

      const [set, chapter] = await Promise.all([
        store.readDoc(SET_CONTAINER, ref.id, ref.id),
        loadChapter(ref, chapterId),
      ]);
      if (!chapter) return json(404, { error: noChapterMessage(ref, chapterId) });
      if (typeof io.enqueue !== 'function') {
        context.error?.('regenerateChapter: no queue output wired');
        return json(500, { error: 'Job queue is not configured' });
      }

      const plan = regenerationPlan({ chapter, chapterId, set, ref });
      if (!plan.ok) return json(plan.status, { error: plan.error });

      const speech = await estimateFor(set, { bytes: plan.bytes });
      context.log?.(`regenerateListenAndLearnChapter: as ${plan.type}`);
      return await queueJob({
        type: plan.type,
        payload: plan.payload,
        user: auth.user,
        enqueue: io.enqueue,
        extra: { chapterId, speech },
      });
    }
  );
