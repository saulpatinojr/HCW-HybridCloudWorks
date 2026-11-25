/**
 * ai-cover.js — `generateAiCoverOnContentTrigger`: a content document whose
 * `altCoverImageTrigger` goes true gets up to four AI-generated images
 * (`aiImageTargets`, hero by default) through Replicate.
 *
 * Ported from Site-Main index.js (088f458) with the rising-edge claim. Not
 * carried over: the WebP responsive variants (sharp), the mascot
 * image-conditioned path (`character_profiles`), and the OpenAI image
 * fallback — the PNG original lands in `covers/` and is served through the
 * media route; `aiImageVariants` stays empty. Replicate is called over REST
 * (`Prefer: wait`, then polling) with no SDK dependency; a missing
 * `REPLICATE_API_KEY` fails the run with a clear `altCoverImageError`, and the
 * claim is released either way.
 *
 * ADR 0033 (Creative slice) changed two things about what this writes:
 *
 *   - THE PROMPT COMES FROM THE LIBRARY. `resolveCoverPrompt` uses the
 *     editor's override when one was typed, otherwise the Image Prompts set
 *     assigned to the document (its own lineage, then its provider's page),
 *     composed with the hero slot template, the set's style rules and the
 *     keyword matrix. The hardcoded "Lego minifigure" prompt is now the
 *     fallback for a document no set applies to, not the only path.
 *   - EVERY ROW IS A REAL FILE. The blob path carries the generation stamp
 *     (`{id}-ai-{slot}-{yyyymmddhhmmss}.png`), so regenerating no longer
 *     overwrites the previous cover's bytes and the history rows the gallery
 *     shows each point at their own image. Old rows keep their un-stamped
 *     paths and still resolve. Each row records its lineage (set, prompt,
 *     template version, final text), the provider and model, the blob path
 *     the delete route needs, and the measured bytes and dimensions.
 *
 * THE MODEL IS THE TASK'S (ADR 0034 slice 5, #860). A client built with
 * `modelForTask` (production: change-feed.js and manual-images-http.js hand
 * over the router's) resolves the `coverArt` or `manualImages` task before
 * every generation and calls the model the Tasks tab chose; the feature
 * switch, the key check and the resolver's locks apply, and a task with
 * nothing eligible fails the generation with the resolver's sentence, which
 * the cover trigger records as `altCoverImageError` and the manual routes
 * answer with. Without `modelForTask` — unit tests, tooling — the model is
 * the setting or the default, as before. `client.model` reads the model the
 * last generation resolved (the default until one runs), which is what the
 * gallery record and the manual routes' `modelInfo` report. Which task a
 * generation belongs to is said by its usage `source`: the cover source is
 * the cover task, every other one the manual images task.
 */
import { readKey } from '../ai/router.js';
import { USAGE_SOURCES, featureSource, monthToDateUsage, recordAiUsage } from '../ai/usage.js';
import { mediaUrlFor } from '../blob-paths.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { measureImage } from '../gallery-images.js';
import { claimRisingEdge, releaseRisingEdgeClaim, SKIP_REASONS } from './rising-edge-claim.js';
import { fetchImage as defaultFetchImage } from './fetch-image.js';
import { AuthoredError, errorCode, recordedFailure, errorFacts } from '../http/error-response.js';
import { aiCoverBlobPath, pickDefaultHero, resolveAiCoverTargets, resolveCoverPrompt, DEFAULT_HEROES_CONFIG_ID } from './ai-cover-prompt.js';
import { awaitPrediction, CoverGenerationError, createPrediction, predictionImageUrl } from './replicate-prediction.js';

// The prompt and the file path live in ai-cover-prompt.js, and one Replicate
// prediction in replicate-prediction.js; exported again here so callers keep
// importing from ai-cover.js.
export {
  aiCoverBlobPath,
  BUILTIN_PROMPT_VERSION,
  buildImagePrompt,
  compactStamp,
  DEFAULT_HEROES_CONFIG_ID,
  pickDefaultHero,
  PROVIDER_THEMES,
  resolveAiCoverTargets,
  resolveCoverPrompt,
} from './ai-cover-prompt.js';
export { CoverGenerationError } from './replicate-prediction.js';

export const AI_COVER_CLAIM_FIELDS = Object.freeze({
  flagField: 'altCoverImageTrigger',
  claimField: 'altCoverImageRunId',
  claimedAtField: 'altCoverImageRunAt',
});

/** The one image provider this site generates with today. */
export const IMAGE_PROVIDER = 'replicate';

/** The registry tasks the two image paths resolve their model under (ai/tasks.js). */
export const IMAGE_TASKS = Object.freeze({ cover: 'coverArt', manual: 'manualImages' });

/** The task a generation belongs to, by the usage source its caller names (header). */
const taskForSource = (source) =>
  source === USAGE_SOURCES.imageCover ? IMAGE_TASKS.cover : IMAGE_TASKS.manual;

/**
 * The monthly image budget (2026-10-05). Replicate bills on its own account,
 * so no Azure budget alerts on it and nothing stops it; these two numbers
 * do. Dollars count what the rows priced, images count every row, so a
 * month with no per-image price configured still has a ceiling.
 */
const IMAGE_BUDGET_DEFAULT_USD = 10;
const IMAGE_COUNT_DEFAULT = 200;

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Mirrors applyPublishTimeCoverTrigger's "already has a cover" field list. */
function hasCover(data = {}) {
  return [
    data.altCoverImage,
    data['Cover Image'],
    data.contentImageUrl,
    data.aiImageUrls?.hero,
    data.heroImageUrl,
    data.coverImage,
  ].some(Boolean);
}

/**
 * Refuse before the call, not after the bill. The guard FAILS CLOSED: there
 * is no Replicate-side limit (the owner declined one, 2026-10-05), so a
 * month that cannot be read is a month that cannot be bounded, and the
 * generation waits rather than runs. The image about to be made is counted
 * against the budget too, so $9.99 used does not permit a $0.02 image.
 *
 * What this does not do is serialise: two generations that read the month
 * at the same moment can both pass, so the overshoot is bounded by the
 * number of concurrent generations times the per-image price — a few cents
 * on this site — not unbounded. An atomic reservation document would close
 * that gap at the cost of a write per image and a reconciliation path;
 * revisit if the per-image price or the concurrency grows. Module-level
 * over the client's bookkeeping so the factory stays small (qlty, #854).
 */
async function assertImageBudget({
  store,
  now,
  costPerImageUsd,
  monthlyBudgetUsd,
  monthlyMaxImages,
}) {
  if (!store?.queryDocs) return;
  let used;
  try {
    used = await monthToDateUsage({ store, now }, IMAGE_PROVIDER);
  } catch (cause) {
    throw new ImageBudgetError(
      `Image generation paused: this month's image spend could not be read (${errorCode(cause)}), and with no account-side limit the budget cannot be enforced blind. Try again shortly.`,
      { code: 'IMAGE_BUDGET_UNKNOWN', status: 503, cause }
    );
  }
  const pending = costPerImageUsd ?? 0;
  if (used.costUsd + pending <= monthlyBudgetUsd && used.count + 1 <= monthlyMaxImages) return;
  throw new ImageBudgetError(
    `Image generation paused: $${used.costUsd.toFixed(2)} of the $${monthlyBudgetUsd} monthly image budget used, ${used.count} images since ${used.since.slice(0, 10)}. Raise CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD (or CONTENTFORGE_IMAGE_MONTHLY_MAX) or wait for the first of the month.`,
    { code: 'IMAGE_BUDGET_EXHAUSTED', status: 429 }
  );
}

/**
 * The monthly image budget refused a generation (429 exhausted, 503
 * unreadable). Its sentence is written above and names only settings and
 * totals, so the manual image routes show it (authored, #945).
 */
export class ImageBudgetError extends AuthoredError {}

/**
 * One row per output image, under the task's source with the image slug as
 * `product` (ai/usage.js, ADR 0034 slice 5). recordAiUsage swallows its own
 * failures.
 */
async function recordImageUsage({ store, now, uuid, model, costPerImageUsd }, source) {
  if (!store?.upsertDoc) return;
  const product = source || USAGE_SOURCES.imageManual;
  await recordAiUsage(
    { store, ai: { getCostEstimate: () => costPerImageUsd ?? 0 }, uuid, now },
    {
      provider: IMAGE_PROVIDER,
      model,
      costUsd: costPerImageUsd ?? undefined,
      unpriced: costPerImageUsd === null,
      source: featureSource(taskForSource(product)),
      product,
    }
  );
}

/**
 * The model the task resolves to for this generation (header), or the
 * client's own when no resolver is wired. A task that resolves to a provider
 * this client cannot call is a refusal, not a silent substitution.
 */
async function resolveImageModel(modelForTask, source, fallback) {
  if (typeof modelForTask !== 'function') return fallback;
  // Two literal sites, one per task: ai-call-sites.test.js reads the source.
  const chosen =
    source === USAGE_SOURCES.imageCover
      ? await modelForTask({ task: 'coverArt' })
      : await modelForTask({ task: 'manualImages' });
  if (chosen.provider !== IMAGE_PROVIDER) {
    throw new CoverGenerationError(
      `The ${taskForSource(source)} task resolved to ${chosen.provider}, which this image client cannot call; name a ${IMAGE_PROVIDER} model under AI Engine → Tasks.`
    );
  }
  if (!chosen.model) {
    throw new CoverGenerationError(`The ${taskForSource(source)} task resolved to no model`);
  }
  return chosen.model;
}

/**
 * Replicate over REST. `generate(prompt)` resolves to the image URL.
 * @param {{ env?: object, fetch?: typeof fetch, sleep?: Function }} deps
 */
export function createReplicateClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // With a store, every image writes an `ai_usage` row and the monthly
  // budget is checked first (2026-10-05). Without one — unit tests, tooling —
  // the client generates and records nothing, as it always did.
  store = null,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  // The router's task door (header). Null: the setting or the default below.
  modelForTask = null,
} = {}) {
  const apiKey = readKey(env, 'REPLICATE_API_KEY');
  const defaultModel =
    env.CONTENTFORGE_IMAGE_MODEL_HERO || env.CONTENTFORGE_IMAGE_MODEL || 'google/imagen-4-fast';
  // The model the last generation resolved; `client.model` reads it (header).
  let model = defaultModel;
  // Per-image price for the usage rows and the display; Replicate bills per
  // output, so this is configuration, not a measurement. Absent = unknown:
  // the row is written unpriced and the month's ceiling is the image count.
  const parsedCost = Number(env.CONTENTFORGE_IMAGE_COST_USD);
  const costPerImageUsd = Number.isFinite(parsedCost) && parsedCost >= 0 ? parsedCost : null;
  const monthlyBudgetUsd = positiveNumber(
    env.CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD,
    IMAGE_BUDGET_DEFAULT_USD
  );
  const monthlyMaxImages = positiveNumber(env.CONTENTFORGE_IMAGE_MONTHLY_MAX, IMAGE_COUNT_DEFAULT);

  const bookkeeping = { store, now, uuid, costPerImageUsd, monthlyBudgetUsd, monthlyMaxImages };

  /**
   * One image from the task's Replicate model, under the monthly budget.
   * Refusals and Replicate's statuses are CoverGenerationErrors, written
   * here (#945).
   *
   * @param {string} prompt - what to draw
   * @param {{ aspectRatio?: string, source?: string }} [options]
   * @returns {Promise<string>} the image URL
   */
  async function generate(prompt, { aspectRatio, source } = {}) {
    if (!apiKey) throw new CoverGenerationError('REPLICATE_API_KEY is not configured');
    // The task first (header): a task switched off or with nothing eligible
    // refuses before the budget is read or a byte is sent.
    model = await resolveImageModel(modelForTask, source, defaultModel);
    bookkeeping.model = model;
    await assertImageBudget(bookkeeping);
    const input = {
      prompt,
      aspect_ratio: aspectRatio || '16:9',
      image_size: env.CONTENTFORGE_IMAGE_SIZE || '2K',
      output_format: 'png',
      safety_filter_level: 'block_medium_and_above',
    };
    const headers = {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    };
    const created = await createPrediction(fetchImpl, { model, headers, input, sleep });
    const settled = await awaitPrediction(fetchImpl, created, {
      authorization: headers.Authorization,
      sleep,
    });
    const imageUrl = predictionImageUrl(settled);
    await recordImageUsage(bookkeeping, source);
    return imageUrl;
  }

  return {
    configured: Boolean(apiKey),
    provider: IMAGE_PROVIDER,
    /** The model the last generation resolved, the default until one runs (header). */
    get model() {
      return model;
    },
    costPerImageUsd,
    monthlyBudgetUsd,
    generate,
  };
}

/**
 * The fields a generated image row carries about the bytes and the model —
 * shared by every generator so the gallery reads one shape (ADR 0033 §4).
 */
export function generatedImageRecordFields({ buffer, contentType, blobPath, replicate, lineage }) {
  const measured = measureImage(buffer, contentType);
  return {
    storagePath: `covers/${blobPath}`,
    bytes: buffer?.length ?? null,
    format: String(contentType || '').replace(/^image\//, '') || null,
    width: measured?.width ?? null,
    height: measured?.height ?? null,
    imageProvider: replicate?.provider || IMAGE_PROVIDER,
    imageModel: replicate?.model || '',
    ...(lineage || {}),
  };
}

/**
 * Generate + persist the requested cover slots for one content document:
 * Replicate per slot → blob in `covers/` → gallery record — and return the
 * content-doc `update` (URLs, history, stamps) WITHOUT writing it, so each
 * caller composes its own patch. Shared by the change-feed trigger (which
 * adds its claim-release fields) and the manual generateReviewHeroImage RPC
 * (lib/manual-images.js) — one generation path, not two (T-324 shape).
 *
 * @returns {Promise<{ generatedUrls: Record<string,string>, update: object, stamp: string, records: object[] }>}
 */
export async function generateCoversForContent(
  { store, storage, replicate, fetchImage = defaultFetchImage, now = () => new Date(), uuid },
  contentId,
  data,
  { targets, prompt, lineage = {}, aspectRatio }
) {
  const generatedUrls = {};
  const records = [];
  const stamp = now().toISOString();
  for (const target of targets) {
    const slotPrompt = `${prompt}\n\nImage slot: ${target}. Keep composition distinct while preserving style continuity.`;
    const imageUrl = await replicate.generate(slotPrompt, {
      aspectRatio,
      source: USAGE_SOURCES.imageCover,
    });
    const fetched = await fetchImage(imageUrl);
    // A generation that came back as something other than an image is a failed
    // generation, so it fails the slot rather than being skipped (#415): the
    // caller's catch writes `altCoverImageError` and the doc never claims a
    // cover it has no bytes for.
    if (fetched.refused) {
      throw new CoverGenerationError(`Generated ${target} cover refused: ${fetched.reason}`);
    }
    const { buffer, contentType } = fetched;
    const blobPath = aiCoverBlobPath(contentId, target, stamp);
    await storage.uploadBlob('covers', blobPath, buffer, contentType, {
      metadata: { contentId, slot: target },
    });
    const publicUrl = mediaUrlFor('covers', blobPath);
    generatedUrls[target] = publicUrl;
    const title = data.Title || data.title || 'Untitled';
    const record = {
      id: uuid(),
      contentId,
      articleId: contentId,
      slot: target,
      imageUrl: publicUrl,
      title,
      altText: title,
      provider: data['Cloud Provider'] || data.cloudProvider || '',
      contentType: data.type || data.contentType || 'blog',
      sourceCollection: 'content',
      approvalStatus: 'approved',
      folder: 'default',
      customTags: [],
      createdAt: stamp,
      ...generatedImageRecordFields({
        buffer,
        contentType,
        blobPath,
        replicate,
        lineage: { ...lineage, prompt: slotPrompt, promptSlot: target },
      }),
    };
    await store.upsertDoc('generated_content_images', record);
    records.push(record);
  }
  const history = { ...(data.aiImageHistory || {}) };
  for (const [target, url] of Object.entries(generatedUrls))
    history[target] = [...new Set([...(history[target] || []), url])];
  const update = {
    altCoverImagePrompt: prompt,
    altCoverImageGeneratedAt: stamp,
    altCoverImageError: null,
    aiImageUrls: { ...(data.aiImageUrls || {}), ...generatedUrls },
    aiImageHistory: history,
  };
  if (lineage.promptSet) {
    update.imagePromptSet = lineage.promptSet;
    update.imagePromptName = lineage.promptName || '';
    update.promptTemplateVersion = lineage.promptTemplateVersion || '';
  }
  if (generatedUrls.hero) update.altCoverImage = generatedUrls.hero;
  return { generatedUrls, update, stamp, records };
}

/** Generate the covers and record them, once the claim is held. */
async function generateAndStore(d, contentId, data) {
  const { store, log } = d;
  const resolved = await resolveCoverPrompt({ store, log }, data);
  const targets = resolveAiCoverTargets(data);
  const { update } = await generateCoversForContent(d, contentId, data, {
    targets,
    prompt: resolved.prompt,
    lineage: resolved.lineage,
    aspectRatio: resolved.aspectRatio,
  });
  await store.patchDoc('content', contentId, {
    ...releaseRisingEdgeClaim(AI_COVER_CLAIM_FIELDS),
    altCoverImageTrigger: false,
    altCoverImagePromptSource: resolved.source,
    ...update,
  });
  return { ran: true, reason: 'generated', targets, promptSource: resolved.source };
}

/**
 * The owner's default hero for this document's provider, or null. Best
 * effort: a failure reading the mapping is logged and gives null.
 */
async function defaultHeroFor({ store, log }, data) {
  try {
    const config = await store.readDoc('admin_config', DEFAULT_HEROES_CONFIG_ID, ADMIN_CONFIG_PARTITION);
    return pickDefaultHero(config?.heroes, data['Cloud Provider'] || data.cloudProvider || '');
  } catch (fallbackErr) {
    log.warn?.(`[generateAiCover:content] default-hero fallback failed: ${errorFacts(fallbackErr)}`);
    return null;
  }
}

/**
 * @param {object} d - the generator's dependencies
 * @param {string} contentId
 * @param {string} eventId - stable across redeliveries (the item's _etag)
 * @returns {Promise<{ ran: boolean, reason: string, targets?: string[] }>}
 */
async function run(d, contentId, eventId) {
  const { store, now, log } = d;
  const claim = await claimRisingEdge(store, 'content', contentId, {
    ...AI_COVER_CLAIM_FIELDS,
    eventId,
    now,
  });
  if (!claim.claim) {
    if (claim.reason !== SKIP_REASONS.FLAG_NOT_SET)
      log.log?.(`[generateAiCover:content] a document was skipped: ${claim.reason}`);
    return { ran: false, reason: claim.reason };
  }
  const data = claim.data;
  try {
    return await generateAndStore(d, contentId, data);
  } catch (err) {
    // The review page shows altCoverImageError: this module's sentence, or
    // a fixed one with the code and the reference of the content-free log
    // line, never Replicate's or a socket's own words (#945).
    const failure = recordedFailure(log, 'The cover could not be generated.', err);
    // Releasing the claim is required: a claim left behind blocks the next request for the whole window.
    const errorUpdate = {
      ...releaseRisingEdgeClaim(AI_COVER_CLAIM_FIELDS),
      altCoverImageTrigger: false,
      altCoverImageError: failure,
    };
    // Deterministic fallback (T-606): generation failed or is unconfigured,
    // but a post should still stage with a designed cover. Best effort — a
    // failure reading the mapping keeps the plain error patch.
    const fallback = hasCover(data) ? null : await defaultHeroFor(d, data);
    if (fallback) {
      // contentImageUrl too: the public list projection carries it but
      // not heroImageUrl (lib/public-reads.js PUBLIC_CONTENT_LIST_FIELDS).
      errorUpdate.altCoverImage = fallback;
      errorUpdate.contentImageUrl = fallback;
      errorUpdate.altCoverImageError = `fallback: default hero (${failure})`;
    }
    await store.patchDoc('content', contentId, errorUpdate);
    return {
      ran: false,
      reason: fallback ? `error_with_default_hero: ${errorCode(err)}` : `error: ${errorCode(err)}`,
    };
  }
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function, queryDocs?: Function }} deps.store
 * @param {{ uploadBlob: Function }} deps.storage
 * @param {{ generate: Function }} deps.replicate
 * @param {Function} [deps.fetchImage]
 * @param {() => string} deps.uuid
 */
export function createAiCoverGenerator({
  store,
  storage,
  replicate,
  fetchImage = defaultFetchImage,
  now = () => new Date(),
  uuid,
  log = {},
}) {
  const d = { store, storage, replicate, fetchImage, now, uuid, log };
  return { run: (contentId, eventId) => run(d, contentId, eventId) };
}
