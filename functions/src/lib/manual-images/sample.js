/**
 * generatePromptSetSample (ADR 0033) — the Image Prompts page's "Generate"
 * on a set: one hero through the same path, so a set can be tried without
 * leaving the page. The row it writes carries the set's lineage and shows
 * up under the set as its generation history (PR #841 split of
 * manual-images.js).
 */
import { generatedImageRecordFields } from '../triggers/ai-cover.js';
import { USAGE_SOURCES } from '../ai/usage.js';
import {
  composeSetPrompt,
  lineageFor,
  loadKeywordMatrix,
  normalizePromptConfigKey,
  promptTemplateVersionFor,
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
 * Why a sample cannot be generated, as the response to send, or null when it
 * can (PR #841). Checked in the order the page can act on: name the set,
 * configure the key, then the set itself.
 */
function sampleRefusal(setName, configured, set) {
  if (!setName) return json(400, { error: 'setName required' });
  if (!configured) return json(503, { error: 'REPLICATE_API_KEY is not configured' });
  if (!set) return json(404, { error: `Prompt set "${setName}" not found` });
  if (set.archivedAt) return json(409, { error: `Prompt set "${setName}" is archived` });
  return null;
}

function cleanTagsOf(tags) {
  return Array.isArray(tags)
    ? tags
        .map((t) =>
          String(t || '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    : [];
}

/** `promptset-{slug}` — the article id every sample of a set files under. */
function sampleArticleId(setName) {
  const slug = setName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `promptset-${slug || 'set'}`;
}

/**
 * POST /api/cms/image-prompts/sample — { setName, promptName?, slot?,
 * title?, summary?, provider? } → { success, imageUrl, imageId, prompt,
 * imageProvider, imageModel, costPerImageUsd }. One image from a set, so a
 * set can be tried from the Image Prompts page. The row is a `preview`
 * under `promptset-{slug}` and carries the set's lineage.
 */
export async function generatePromptSetSample(ctx, request, context) {
  const { guard, store, storage, replicate, fetchImage, now, uuid } = ctx;
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = (await request.json().catch(() => null)) || {};
    const setName = normalizePromptConfigKey(body.setName);
    const slot = PREVIEW_SLOTS.includes(String(body.slot || '')) ? String(body.slot) : 'hero';
    const named =
      setName && replicate.configured ? await readNamedSet(store, setName, body.promptName) : {};
    const refusal = sampleRefusal(setName, replicate.configured, named.set);
    if (refusal) return refusal;
    const { set, prompt: promptDoc } = named;

    const article = {
      title: String(body.title || '').trim() || `${setName} sample`,
      summary: String(body.summary || '').trim(),
      cloudProvider: String(body.provider || '').trim(),
    };
    const keyword = await loadKeywordMatrix(store, context);
    const prompt = composeSetPrompt({ set, prompt: promptDoc, slot, article, keyword });
    const generated = await replicate.generate(prompt, {
      aspectRatio: set.aspectRatio || undefined,
      source: USAGE_SOURCES.imageManual,
    });
    const fetched = await fetchImage(generated);
    if (fetched.refused) throw new Error(`Generated sample refused: ${fetched.reason}`);
    const { buffer, contentType } = fetched;
    const stamp = now().toISOString();
    const articleId = sampleArticleId(setName);
    const blobPath = `${articleId}-${slot}-${compact(stamp)}.png`;
    await storage.uploadBlob('covers', blobPath, buffer, contentType, { metadata: { articleId, slot } });
    const imageUrl = mediaUrlFor('covers', blobPath);
    const imageId = uuid();
    await store.upsertDoc('generated_content_images', {
      id: imageId,
      contentId: articleId,
      articleId,
      slot,
      imageUrl,
      title: article.title,
      altText: article.title,
      provider: article.cloudProvider,
      contentType: 'sample',
      sourceCollection: 'preview',
      approvalStatus: 'draft',
      folder: 'default',
      customTags: cleanTagsOf(set.tags),
      createdAt: stamp,
      ...generatedImageRecordFields({
        buffer,
        contentType,
        blobPath,
        replicate,
        lineage: lineageFor({
          set,
          prompt: promptDoc,
          promptText: prompt,
          slot,
          source: 'sample',
        }),
      }),
    });
    return json(200, {
      success: true,
      imageUrl,
      imageId,
      prompt,
      promptTemplateVersion: promptTemplateVersionFor(set),
      ...modelInfo(replicate),
    });
  } catch (error) {
    return generationFailure(
      context,
      'generatePromptSetSample',
      error,
      'Failed to generate sample image'
    );
  }
}
