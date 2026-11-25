/**
 * generateCuratedArticleImage — the public news grid's curated imagery
 * (admin-generated, anonymously served via public/curated-image/{id})
 * (PR #841 split of manual-images.js).
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
import { generationFailure, json, modelInfo, readNamedSet } from './shared.js';

/** The curated news-grid prompt: the caller's base, themed by provider. */
export function buildCuratedPrompt({
  basePrompt,
  articleTitle,
  articleSummary,
  provider,
  keywordLines = [],
}) {
  const theme = PROVIDER_THEMES[provider] || PROVIDER_THEMES.Multi;
  return [
    `${basePrompt || 'Professional technical illustration'} in a ${theme.color} color scheme with a ${theme.vibe} aesthetic.`,
    `Subject: ${articleTitle}.`,
    articleSummary ? `Context: ${articleSummary}` : '',
    ...keywordLines,
    'No text overlays, labels, or written words in the image.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Why a curated image cannot be generated, as the response to send, or null. */
function curatedRefusal(articleId, articleTitle, configured) {
  if (!articleId || !articleTitle) {
    return json(400, { error: 'articleId and articleTitle required' });
  }
  if (!configured) return json(503, { error: 'REPLICATE_API_KEY is not configured' });
  return null;
}

/** The curated_article_images document for one article's image. */
function curatedImageDoc({ articleId, articleTitle, body, imageUrl, nowIso, record }) {
  return {
    id: articleId,
    imageUrl,
    articleTitle,
    title: articleTitle,
    altText: articleTitle,
    articleUrl: String(body.articleUrl || '').trim() || null,
    provider: String(body.provider || '').trim() || null,
    slot: 'curated',
    folder: 'default',
    archived: false,
    archivedAt: null,
    softDeletedAt: null,
    approvalStatus: 'approved',
    sourceCollection: 'curated_article_images',
    generatedAt: nowIso,
    createdAt: nowIso,
    ...record,
  };
}

/**
 * POST /api/generateCuratedArticleImage — { articleId, articleTitle,
 * articleSummary, basePrompt, provider, articleUrl, promptSet?, promptName? }
 * → { success, imageUrl }. Writes the curated_article_images doc the
 * anonymous public/curated-image/{id} route serves.
 */
export async function generateCuratedArticleImage(ctx, request, context) {
  const { guard, store, storage, replicate, fetchImage, now } = ctx;
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = (await request.json().catch(() => null)) || {};
    const articleId = String(body.articleId || '').trim();
    const articleTitle = String(body.articleTitle || '').trim();
    const refusal = curatedRefusal(articleId, articleTitle, replicate.configured);
    if (refusal) return refusal;

    const articleSummary = String(body.articleSummary || '').trim();
    const keyword = await loadKeywordMatrix(store, context);
    const keywordLines = keywordMatrixLines(
      applyKeywordMatrix(`${articleTitle} ${articleSummary}`, keyword)
    );
    const prompt = buildCuratedPrompt({
      basePrompt: body.basePrompt,
      articleTitle,
      articleSummary,
      provider: body.provider,
      keywordLines,
    });
    const { set, prompt: promptDoc } = await readNamedSet(store, body.promptSet, body.promptName);
    const generated = await replicate.generate(prompt, {
      aspectRatio: set?.aspectRatio || undefined,
      source: USAGE_SOURCES.imageManual,
    });
    const fetched = await fetchImage(generated);
    // Not an image: fail the request rather than store it (#415). The outer
    // catch turns this into the 500 the editor already sees for a generation
    // that did not come back.
    if (fetched.refused) throw new Error(`Generated image refused: ${fetched.reason}`);
    const { buffer, contentType } = fetched;
    // The doc id IS the article id and the public route serves one image per
    // article, so this path stays stable: a regeneration replaces the
    // article's curated image rather than adding a second one.
    const blobPath = `curated-${articleId}.png`;
    await storage.uploadBlob('covers', blobPath, buffer, contentType, {
      metadata: { articleId, slot: 'curated' },
    });
    const imageUrl = mediaUrlFor('covers', blobPath);
    const nowIso = now().toISOString();

    await store.upsertDoc(
      'curated_article_images',
      curatedImageDoc({
        articleId,
        articleTitle,
        body,
        imageUrl,
        nowIso,
        record: generatedImageRecordFields({
          buffer,
          contentType,
          blobPath,
          replicate,
          lineage: lineageFor({
            set,
            prompt: promptDoc,
            promptText: prompt,
            slot: 'curated',
            source: set ? 'page' : 'curated',
          }),
        }),
      })
    );
    return json(200, { success: true, imageUrl, ...modelInfo(replicate) });
  } catch (error) {
    return generationFailure(
      context,
      'generateCuratedArticleImage',
      error,
      'Failed to generate curated image'
    );
  }
}
