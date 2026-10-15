/**
 * manual-images.js — the manual image RPC cluster (Blog Machine backlog #2;
 * the four remaining image entries in api-surface.json notImplemented).
 * Every one has been a live 404 the admin UI calls today:
 *
 *   - triggerAiImageGeneration — BlogReviewBoard's "regenerate cover":
 *     fire-and-forget by design; it arms `altCoverImageTrigger` (plus
 *     targets and prompt seed) and the existing content change feed
 *     (lib/triggers/ai-cover.js) does the work. No generation here.
 *   - generateReviewHeroImage — the queue's synchronous "generate hero":
 *     the SAME path the change feed runs (generateCoversForContent), called
 *     inline so the queue card can show the result immediately.
 *   - generateCuratedArticleImage — the public news grid's curated imagery
 *     (admin-generated, anonymously served via public/curated-image/{id}).
 *     In ./manual-images/curated.js.
 *   - generatePreviewImages — the Submit URLs draft builder's per-slot
 *     preview generation (hero/secondary1-3), one slot per call. In
 *     ./manual-images/preview.js.
 *   - generatePromptSetSample (ADR 0033) — the Image Prompts page's "Generate"
 *     on a set: one hero through the same path, so a set can be tried without
 *     leaving the page. The row it writes carries the set's lineage and shows
 *     up under the set as its generation history. In ./manual-images/sample.js.
 *
 * All are editor-guarded. Distinct from the automatic ai-cover trigger only
 * in WHO asks; the generation path is shared, not duplicated. Every prompt
 * composed here passes through the keyword matrix (`applyKeywordMatrix`),
 * which until ADR 0033 was configured in the admin and read by nothing.
 *
 * Each handler is a module-level function over `ctx` — the factory's deps —
 * and the factory only binds them (PR #841).
 */
import { generateCoversForContent, resolveCoverPrompt } from './triggers/ai-cover.js';
import { fetchImage as defaultFetchImage } from './triggers/fetch-image.js';
import { errorCode } from './http/error-response.js';
import { generationFailure, json, modelInfo } from './manual-images/shared.js';
import { generateCuratedArticleImage } from './manual-images/curated.js';
import { generatePreviewImages } from './manual-images/preview.js';
import { generatePromptSetSample } from './manual-images/sample.js';

export { PREVIEW_SLOTS } from './manual-images/shared.js';
export { buildCuratedPrompt } from './manual-images/curated.js';
export { buildPreviewSlotPrompt } from './manual-images/preview.js';

export const TRIGGER_MAX_CONTENT_IDS = 25;

/** The distinct, trimmed content ids a trigger body names. */
function contentIdsOf(body) {
  return [
    ...new Set(
      (Array.isArray(body.contentIds) ? body.contentIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ),
  ];
}

/** Why a trigger cannot be queued, as the response to send, or null. */
function triggerRefusal(contentIds) {
  if (!contentIds.length) return json(400, { error: 'contentIds required' });
  if (contentIds.length > TRIGGER_MAX_CONTENT_IDS) {
    return json(400, { error: `At most ${TRIGGER_MAX_CONTENT_IDS} contentIds per request` });
  }
  return null;
}

/** Arm the change-feed flag on each document; `{ queued, errors }`. */
async function armTriggers(store, contentIds, { targets, seed }) {
  const errors = [];
  let queued = 0;
  for (const contentId of contentIds) {
    try {
      await store.patchDoc('content', contentId, {
        altCoverImageTrigger: true,
        ...(targets?.length ? { aiImageTargets: targets } : {}),
        // An empty seed CLEARS a previous override so the library applies
        // again; a non-empty one is used verbatim (ADR 0033).
        altCoverImagePrompt: seed || null,
      });
      queued += 1;
    } catch (error) {
      // In the answer, so the store's code and never its sentence (#945).
      errors.push({ contentId, error: `patch failed (${errorCode(error)})` });
    }
  }
  return { queued, errors };
}

/**
 * POST /api/triggerAiImageGeneration — { contentIds[], aiImageTargets?,
 * imagePromptSeed? } → { success, queued, errors }. Queues by arming the
 * change-feed flag; the Images panel updates when the feed lands the file.
 */
async function triggerAiImageGeneration({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = (await request.json().catch(() => null)) || {};
    const contentIds = contentIdsOf(body);
    const refusal = triggerRefusal(contentIds);
    if (refusal) return refusal;
    const targets = Array.isArray(body.aiImageTargets)
      ? body.aiImageTargets.map(String).filter(Boolean).slice(0, 4)
      : null;
    const seed = String(body.imagePromptSeed || '').trim();
    const { queued, errors } = await armTriggers(store, contentIds, { targets, seed });
    return json(queued > 0 ? 200 : 404, { success: queued > 0, queued, errors });
  } catch (error) {
    context.error('triggerAiImageGeneration failed:', error);
    return json(500, { error: 'Failed to queue image generation' });
  }
}

/** Why a hero cannot be generated, as the response to send, or null. */
function heroRefusal(contentId, configured, data) {
  if (!contentId) return json(400, { error: 'contentId required' });
  if (!configured) return json(503, { error: 'REPLICATE_API_KEY is not configured' });
  if (!data) return json(404, { error: `Content ${contentId} not found` });
  return null;
}

/**
 * POST /api/generateReviewHeroImage — { contentId } → { success, imageUrl }.
 * Synchronous hero generation for a queue card, through the shared cover
 * path; the doc patch matches what the change-feed trigger would write.
 */
async function generateReviewHeroImage(ctx, request, context) {
  const { guard, store, replicate } = ctx;
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = (await request.json().catch(() => null)) || {};
    const contentId = String(body.contentId || '').trim();
    const data =
      contentId && replicate.configured
        ? await store.readDoc('content', contentId, contentId)
        : null;
    const refusal = heroRefusal(contentId, replicate.configured, data);
    if (refusal) return refusal;

    const resolved = await resolveCoverPrompt({ store, log: context }, data);
    const { generatedUrls, update } = await generateCoversForContent(
      ctx.coverDeps,
      contentId,
      data,
      {
        targets: ['hero'],
        prompt: resolved.prompt,
        lineage: resolved.lineage,
        aspectRatio: resolved.aspectRatio,
      }
    );
    await store.patchDoc('content', contentId, {
      ...update,
      altCoverImagePromptSource: resolved.source,
    });
    return json(200, {
      success: true,
      imageUrl: generatedUrls.hero,
      promptSource: resolved.source,
      promptSet: resolved.lineage?.promptSet || '',
      ...modelInfo(replicate),
    });
  } catch (error) {
    return generationFailure(
      context,
      'generateReviewHeroImage',
      error,
      'Failed to generate hero image'
    );
  }
}

const HANDLERS = Object.freeze({
  triggerAiImageGeneration,
  generateReviewHeroImage,
  generateCuratedArticleImage,
  generatePreviewImages,
  generatePromptSetSample,
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function, queryDocs?: Function }} deps.store
 * @param {{ uploadBlob: Function }} deps.storage
 * @param {{ configured: boolean, generate: Function, model?: string }} deps.replicate
 */
export function createManualImageHandlers({
  guard,
  store,
  storage,
  replicate,
  fetchImage = defaultFetchImage,
  now = () => new Date(),
  uuid,
  log = {},
}) {
  const coverDeps = { store, storage, replicate, fetchImage, now, uuid };
  const ctx = { guard, store, storage, replicate, fetchImage, now, uuid, log, coverDeps };
  return Object.fromEntries(
    Object.entries(HANDLERS).map(([name, handler]) => [
      name,
      (request, context) => handler(ctx, request, context),
    ])
  );
}
