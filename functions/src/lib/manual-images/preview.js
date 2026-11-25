/**
 * generatePreviewImages — the Submit URLs draft builder's per-slot preview
 * generation (hero/secondary1-3), one slot per call (PR #841 split of
 * manual-images.js).
 */
import { generatedImageRecordFields, PROVIDER_THEMES } from '../triggers/ai-cover.js';
import { USAGE_SOURCES } from '../ai/usage.js';
import {
  applyKeywordMatrix,
  keywordMatrixLines,
  lineageFor,
  loadKeywordMatrix,
} from '../cms/image-prompts.js';
import { mediaUrlFor } from '../blob-paths.js';
import {
  PREVIEW_SLOTS,
  compact,
  generationFailure,
  json,
  modelInfo,
  readNamedSet,
} from './shared.js';

/**
 * The preview-slot prompt: the owner's slot template when one was written,
 * otherwise composed from the draft's own summary/details prompts.
 */
export function buildPreviewSlotPrompt({
  slot,
  template,
  summaryPrompt,
  detailsPrompt,
  title,
  summary,
  provider,
  contentType,
  keywordLines = [],
}) {
  const theme = PROVIDER_THEMES[provider] || PROVIDER_THEMES.Multi;
  const base = String(template || '').trim() || String(summaryPrompt || '').trim();
  const lines = [
    base ||
      `Professional technical illustration for a ${contentType || 'blog'} article titled "${title}".`,
    String(detailsPrompt || '').trim(),
    summary ? `Article context: ${summary}` : '',
    ...keywordLines,
    `Style: ${theme.color} color scheme, ${theme.vibe} aesthetic. No text overlays, labels, or written words.`,
    `Image slot: ${slot}. Keep composition distinct while preserving style continuity.`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Why previews cannot be generated, as the response to send, or null. */
function previewRefusal(articleId, slots, configured) {
  if (!articleId) return json(400, { error: 'articleId required' });
  if (!slots.length) {
    return json(400, {
      error: `aiImageTargets must name at least one of ${PREVIEW_SLOTS.join(', ')}`,
    });
  }
  if (!configured) return json(503, { error: 'REPLICATE_API_KEY is not configured' });
  return null;
}

/** The lineage a preview row carries: the set's when one applies, else the body's own names. */
function previewLineage({ set, promptDoc, prompt, slot, body }) {
  if (set)
    return lineageFor({ set, prompt: promptDoc, promptText: prompt, slot, source: 'content' });
  return {
    promptSetId: '',
    promptSet: String(body.promptSet || '').trim(),
    setId: '',
    promptName: String(body.promptName || '').trim(),
    promptTemplateVersion: String(body.promptTemplateVersion || '').trim(),
    prompt,
    promptSlot: slot,
    promptSource: 'preview',
  };
}

/** Generate, store and record one preview slot; `{ imageUrl, imageId, prompt }`. */
async function generatePreviewSlot(ctx, slot, run) {
  const { store, storage, replicate, fetchImage, uuid } = ctx;
  const { articleId, body, title, summary, keywordLines, set, promptDoc, stamp } = run;
  const prompt = buildPreviewSlotPrompt({
    slot,
    template: body.slotTemplates?.[slot],
    summaryPrompt: body.summaryPrompt,
    detailsPrompt: body.detailsPrompt,
    title,
    summary,
    provider: body.provider,
    contentType: body.contentType,
    keywordLines,
  });
  const generated = await replicate.generate(prompt, {
    aspectRatio: set?.aspectRatio || undefined,
    source: USAGE_SOURCES.imageManual,
  });
  const fetched = await fetchImage(generated);
  if (fetched.refused) throw new Error(`Generated ${slot} image refused: ${fetched.reason}`);
  const { buffer, contentType } = fetched;
  // Stamped, so re-generating a slot keeps the earlier preview's bytes
  // (ADR 0033 §6.2); old un-stamped paths still resolve.
  const blobPath = `preview-${articleId}-${slot}-${compact(stamp)}.png`;
  await storage.uploadBlob('covers', blobPath, buffer, contentType, {
    metadata: { articleId, slot },
  });
  const imageUrl = mediaUrlFor('covers', blobPath);
  const imageId = uuid();
  const lineage = previewLineage({ set, promptDoc, prompt, slot, body });
  await store.upsertDoc('generated_content_images', {
    id: imageId,
    contentId: articleId,
    articleId,
    slot,
    imageUrl,
    title,
    altText: title,
    provider: String(body.provider || '').trim() || '',
    contentType: String(body.contentType || '').trim() || 'blog',
    sourceUrl: String(body.sourceUrl || '').trim() || null,
    sourceCollection: 'preview',
    approvalStatus: 'draft',
    folder: 'default',
    customTags: [],
    createdAt: stamp,
    ...generatedImageRecordFields({ buffer, contentType, blobPath, replicate, lineage }),
  });
  return { imageUrl, imageId, prompt };
}

/**
 * POST /api/generatePreviewImages — the Submit URLs draft builder. One or
 * more slots per call (the page sends one at a time) →
 * { success, imageUrls: {slot: url}, imageRecords: {slot: {imageId,
 * imageUrl}}, promptLogs: {slot: prompt} }.
 */
export async function generatePreviewImages(ctx, request, context) {
  const { guard, store, replicate, now } = ctx;
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = (await request.json().catch(() => null)) || {};
    const articleId = String(body.articleId || '').trim();
    const slots = (Array.isArray(body.aiImageTargets) ? body.aiImageTargets : [])
      .map(String)
      .filter((slot) => PREVIEW_SLOTS.includes(slot));
    const refusal = previewRefusal(articleId, slots, replicate.configured);
    if (refusal) return refusal;

    const stamp = now().toISOString();
    const title = String(body.title || '').trim() || 'Untitled draft';
    const summary = String(body.summary || '').trim();
    const keyword = await loadKeywordMatrix(store, context);
    const keywordLines = keywordMatrixLines(applyKeywordMatrix(`${title} ${summary}`, keyword));
    const { set, prompt: promptDoc } = await readNamedSet(store, body.promptSet, body.promptName);
    const run = { articleId, body, title, summary, keywordLines, set, promptDoc, stamp };
    const imageUrls = {};
    const imageRecords = {};
    const promptLogs = {};
    for (const slot of slots) {
      const { imageUrl, imageId, prompt } = await generatePreviewSlot(ctx, slot, run);
      imageUrls[slot] = imageUrl;
      imageRecords[slot] = { imageId, imageUrl };
      promptLogs[slot] = prompt;
    }
    return json(200, {
      success: true,
      imageUrls,
      imageRecords,
      promptLogs,
      ...modelInfo(replicate),
    });
  } catch (error) {
    return generationFailure(
      context,
      'generatePreviewImages',
      error,
      'Failed to generate preview images'
    );
  }
}
