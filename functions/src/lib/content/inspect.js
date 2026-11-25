/**
 * inspect.js — turn an ingested URL into an inspected draft.
 *
 * Ported from Site-Main `inspectArticleSource`, `analyzeWithGemini`,
 * `generateAltTexts`, `buildInspectionUpdateData` and
 * `executeInspectionTrigger` (functions/index.js, 088f458). Upstream this ran
 * as the Firestore trigger `inspectAndPopulateContent` whenever a document
 * carried `inspectTrigger: true`; on Azure it runs from the `batch-inspect`
 * job (./inspect-job.js) over flagged documents, which is the same work on a
 * pull instead of a push. The change-feed form is T-324.
 *
 * Not ported yet, and said so at the call site rather than silently skipped:
 *   - the architecture-diagram path (`inspectArchitectureSource`, multimodal
 *     analysis of a diagram image) — a document of `type: 'architecture'`
 *     records an inspectError naming this;
 *   - the "generate cover on inspect" opt-in, which needs the image pipeline.
 *
 * Timestamps are ISO strings (the codebase convention); `publishedAt` keeps
 * whatever the caller already had ('Published At' from the RSS ingest) and
 * otherwise the page's own date.
 */
import { generateSlug } from '../rss/feeds.js';
import { pickNextFormat } from './voice.js';
import { analyzeArticle, generateAltTexts } from './inspect-ai.js';
import { extractPublishedDate, referenceScrapedImages } from './scrape.js';
import { blogImageDefaults } from '../rss/source-config.js';
import { fetchImage as defaultFetchImage } from '../triggers/fetch-image.js';

// The analysis prompt and its builder are in inspect-ai.js.
export { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from './inspect-ai.js';

export const ARCHITECTURE_NOT_PORTED =
  'Architecture-diagram inspection is not ported yet (T-322); this document needs the multimodal path';

// ---------------------------------------------------------------------------
// The update document (pure) — ported with its upstream tests
// ---------------------------------------------------------------------------

function scrapeFields(scraped, imageAltTexts, stamp) {
  return {
    content: String(scraped.markdown || '').substring(0, 50000),
    contentHtml: scraped.html ? scraped.html.substring(0, 100000) : null,
    contentPlainText: scraped.plainText ? scraped.plainText.substring(0, 50000) : null,
    wordCount: scraped.wordCount,
    scrapedAt: stamp,
    scrapedImages: scraped.images || [],
    scrapedImagesCount: (scraped.images || []).length,
    imageAltTexts: Object.keys(imageAltTexts || {}).length > 0 ? imageAltTexts : null,
  };
}

function metadataFields(newData, metadata) {
  return {
    type: newData.type || 'blog',
    slug: newData.slug || generateSlug(metadata.title),
    scrapedMethod: newData.type === 'architecture' ? 'gemini-multimodal' : 'fetch-cheerio',
    title: metadata.title,
    summary: metadata.summary,
    cloudProvider: newData.cloudProvider || metadata.cloudProvider,
    keyTopics: metadata.keyTopics || metadata.tags || [],
    targetAudience: metadata.targetAudience || 'Cloud Architect',
    visualTheme: metadata.visualTheme,
  };
}

function architectureFields(newData, metadata, targetUrl) {
  if (newData.type !== 'architecture') return {};
  return {
    diagramUrl: targetUrl,
    category: metadata.category,
    complexity: metadata.complexity,
    technicalSpecs: metadata.technicalSpecs,
    costAnalysis: metadata.costAnalysis,
    terraformCode: metadata.terraformCode,
    deploymentSteps: metadata.deploymentSteps,
    overview: metadata.overviewHtml,
  };
}

function critiqueFields(critique, revised) {
  if (!critique) return {};
  return {
    critiqueVerdict: critique.verdict,
    critiqueGenericityScore: critique.genericityScore,
    critiqueSpecificityScore: critique.specificityScore,
    critiqueIssues: critique.issues || [],
    draftRevised: revised,
  };
}

/**
 * Everything the inspection writes back to the document. A draft that still
 * reads generic after one automatic revision lands as `needs_rework`, not
 * `inspected`, so it does not sit in the "ready to approve" queue.
 */
export function buildInspectionUpdateData({
  newData,
  targetUrl,
  scraped,
  metadata,
  analysisPrompt,
  analysisModel,
  publishedAt,
  imageAltTexts = {},
  format = null,
  critique = null,
  revised = false,
  now = new Date(),
}) {
  const stamp = now.toISOString();
  const hasGeneratedPostContent =
    typeof metadata.postContent === 'string' && metadata.postContent.trim().length > 0;
  const needsRework = critique?.verdict === 'revise';

  const update = {
    inspectTrigger: false,
    inspectCompletedAt: stamp,
    contentStatus: needsRework ? 'needs_rework' : 'inspected',
    inspectError: null,
    ...metadataFields(newData, metadata),
    ...scrapeFields(scraped, imageAltTexts, stamp),
    ...(newData.blogSourceId ? blogImageDefaults(newData, scraped.images || []) : {}),
    ...(hasGeneratedPostContent && { postContent: metadata.postContent }),
    ...architectureFields(newData, metadata, targetUrl),
    analysisPrompt,
    analysisModel,
    ...(format && { format }),
    ...critiqueFields(critique, revised),
    updatedAt: stamp,
  };
  if (publishedAt) update.publishedAt = publishedAt;
  // Cover generation is a publish-time concern (R1); the explicit opt-in is
  // honoured as a flag for the image pipeline to pick up.
  if (newData.generateAiCoverOnInspect === true && newData.skipImageGeneration !== true) {
    update.altCoverImageTrigger = true;
  }
  return update;
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

/** Scrape, analyse (with one revision when the critique asks), and describe the images. */
async function inspectArticleSource(ctx, { targetUrl, cloudProvider, existingPublishedAt, signal }) {
  const { scrape, store } = ctx;
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const scraped = await scrape(targetUrl, { signal });
  if (!scraped.success) throw new Error(scraped.error || 'Scraping failed');
  scraped.images = referenceScrapedImages(scraped.images);

  const publishedAt = existingPublishedAt || pageDateOf(scraped.html);

  const format = await pickNextFormat(store, 'content', cloudProvider);
  const request = { url: targetUrl, markdownContent: scraped.markdown, cloudProvider, format, signal };
  const { analysis, critique, revised } = await analyseWithCritique(ctx, request);

  const imageAltTexts = await generateAltTexts(
    ctx,
    (scraped.images || []).map((img) => img.original || img.url).filter(Boolean),
    signal
  );

  return {
    scraped,
    metadata: analysis.metadata,
    analysisPrompt: analysis.prompt,
    analysisModel: analysis.model,
    publishedAt,
    imageAltTexts,
    format: format?.key || null,
    critique,
    revised,
  };
}

/** The page's own publish date as ISO text, or null. */
function pageDateOf(html) {
  const extracted = extractPublishedDate(html);
  return extracted ? extracted.toISOString() : null;
}

/** Quality gate: one automatic revision, then the verdict stands. */
async function analyseWithCritique(ctx, request) {
  const { critic } = ctx;
  const { signal } = request;
  let analysis = await analyzeArticle(ctx, { ...request, revisionIssues: null });
  const post = analysis.metadata?.postContent;
  if (typeof post !== 'string' || !post.trim()) return { analysis, critique: null, revised: false };
  let critique = await critic.critiqueDraft({ title: analysis.metadata.title, postContent: post, signal });
  if (critique.verdict !== 'revise') return { analysis, critique, revised: false };
  analysis = await analyzeArticle(ctx, { ...request, revisionIssues: critique.issues });
  critique = await critic.critiqueDraft({
    title: analysis.metadata.title,
    postContent: analysis.metadata.postContent,
    signal,
  });
  return { analysis, critique, revised: true };
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, patchDoc: Function }} deps.store
 * @param {{ generateJsonResponse: Function, generateTextResponse: Function, getActiveAiProvider: Function }} deps.ai
 * @param {(url: string) => Promise<object>} deps.scrape - scrapeArticle or a fake
 * @param {{ critiqueDraft: Function }} deps.critic
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch] - for alt-text image downloads
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createInspector({
  store,
  ai,
  scrape,
  critic,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  // Injected so tests can stub it; defaults to the SSRF-validating fetcher
  // rather than bare fetch (T-734).
  fetchImage: fetchImageImpl = defaultFetchImage,
  now = () => new Date(),
  log = {},
  signal: defaultSignal,
}) {
  const ctx = { store, ai, scrape, critic, env, fetchImpl, fetchImageImpl, now, log };

  /**
   * Inspect one document and write the result back. Throws on failure; the
   * caller records the error on the document.
   */
  async function executeInspection({ collectionName = 'content', docId, newData, signal: callSignal }) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const targetUrl = newData.url || newData.sourceUrl || newData['CD Url'];
    if (!targetUrl) throw new Error('No URL provided in document (checked url, sourceUrl, CD Url)');
    if (newData.type === 'architecture') throw new Error(ARCHITECTURE_NOT_PORTED);

    // No document id or URL in these lines (#1635).
    log.log?.(`[inspect:${collectionName}] inspecting`);
    // RSS writes 'Cloud Provider'; manual submission writes cloudProvider.
    const cloudProvider = newData.cloudProvider || newData['Cloud Provider'] || null;
    const inspection = await inspectArticleSource(ctx, {
      targetUrl,
      cloudProvider,
      existingPublishedAt: newData.publishedAt || newData['Published At'],
      signal: activeSignal,
    });
    const update = buildInspectionUpdateData({ newData, targetUrl, ...inspection, now: now() });
    await store.patchDoc(collectionName, docId, update);
    log.log?.(`[inspect:${collectionName}] → ${update.contentStatus}`);
    return {
      docId,
      contentStatus: update.contentStatus,
      format: update.format || null,
      revised: inspection.revised,
    };
  }

  return {
    analyzeArticle: (request) => analyzeArticle(ctx, request),
    generateAltTexts: (imageUrls, signal) => generateAltTexts(ctx, imageUrls, signal),
    inspectArticleSource: (request) => inspectArticleSource(ctx, request),
    executeInspection,
  };
}
