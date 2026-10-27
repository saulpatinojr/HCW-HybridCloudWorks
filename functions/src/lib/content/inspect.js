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
import { buildVoiceAndFormatBlock, pickNextFormat } from './voice.js';
import { extractPublishedDate, referenceScrapedImages } from './scrape.js';
import { blogImageDefaults } from '../rss/source-config.js';
import { fetchImage as defaultFetchImage } from '../triggers/fetch-image.js';

// The static system prompt — kept ≥1,024 tokens so Anthropic caches it.
export const ANALYSIS_SYSTEM_PROMPT = `You are a technical content analyst for Hybrid Cloud Works (HCW), a publication targeting senior cloud practitioners — architects, DevOps leads, FinOps analysts, and platform engineers — at enterprises operating multi-cloud or hybrid environments. Every article you produce must be technical, concrete, and actionable. Do not write introductory-level content.

Output schema (return ONLY valid JSON, no markdown fences, no prose):
{
  "title": "Article headline, max 100 chars. Be specific and search-optimised: prefer 'How to Optimize EKS Node Groups for Cost' over 'AWS Kubernetes Cost Tips'. Include the primary technology and action or outcome.",
  "summary": "Detailed overview, minimum 5-6 sentences (~600 characters). Identify: (1) the specific problem or trend the article addresses, (2) the primary technology or service discussed, (3) the key insight or takeaway, (4) who this is most relevant for, and (5) any important caveats or prerequisites. Do NOT repeat the title verbatim. Do NOT end with ellipsis (...).",
  "cloudProvider": "Primary provider. MUST be exactly one of: Azure, AWS, GCP, VMware, Ansible, GitHub, Terraform, FinOps, Docker, Multi. Azure, AWS, and GCP are cloud providers. VMware, Ansible, Terraform, and Docker are service providers. GitHub and FinOps are platform providers. Use 'Multi' only when the article explicitly compares two or more providers with roughly equal coverage. If primarily AWS but mentions Azure once, it is 'AWS'. GitHub Actions, Copilot, and GitHub-native CI/CD are 'GitHub'. Ansible Automation Platform, playbooks, and configuration automation are 'Ansible'. VMware Cloud Foundation, vSphere, NSX, and VMware by Broadcom are 'VMware'. Pulumi and CDK are 'Terraform' (IaC category). Docker is chosen only when Docker itself is the subject: Dockerfiles and image builds, Docker Desktop, Docker Compose, Docker Hub, Docker Scout, and Docker Sandboxes are 'Docker'. Containers that run on, or are deployed by, another provider belong to that provider: Docker images on Azure Container Apps are 'Azure', a GitHub Actions workflow that builds an image is 'GitHub', and a Terraform module that deploys containers is 'Terraform'.",
  "keyTopics": ["Array of 3-5 specific technology tags. Use precise names: 'AWS EKS' not 'Kubernetes'; 'Azure Cost Management' not 'cloud cost'; 'Terraform modules' not 'IaC'. Each tag should be independently searchable and usable as an article label."],
  "targetAudience": "Primary reader persona. MUST be exactly one of: Cloud Architect, DevOps Engineer, FinOps Analyst, Platform Engineer, Developer.",
  "visualTheme": "Describe a specific, concrete Lego-character scene in 20-30 words for the cover image. Good: 'A Lego cloud architect connecting modular database and compute blocks on a rack server with AWS orange accents'. Bad: 'cloud infrastructure concepts'. The description drives the image generation prompt, so specificity directly improves output quality.",
  "postContent": "A technical blog post formatted in clean Markdown, following the Voice and Format instructions provided separately below for structure, length, and tone — do not default to a generic open/three-sections/conclusion shape. Do NOT pad with generic cloud explanations. Write as if the reader is already a practitioner."
}

Classification rules:
- cloudProvider: see schema above. When in doubt between two providers, pick the one with more service-specific mentions.
- keyTopics: avoid generic terms. 'Cost optimisation' is too broad; 'Reserved Instances rightsizing' is correct. Cap at 5 topics.
- targetAudience: pick the role that benefits most from the article's primary action or insight, not the broadest possible audience.
- postContent: must be ready-to-publish Markdown with no placeholder text, no [INSERT X HERE] markers, and no incomplete sections.`;

export const ARCHITECTURE_NOT_PORTED =
  'Architecture-diagram inspection is not ported yet (T-322); this document needs the multimodal path';

export function buildAnalysisPrompt(url, markdownContent, metadataOnly) {
  const schemaForMode = metadataOnly
    ? `Extract the following fields and return ONLY valid JSON:
title, summary, cloudProvider, keyTopics, targetAudience, visualTheme.
Do NOT include a postContent field.`
    : `Extract all fields including postContent and return ONLY valid JSON.`;
  return `${schemaForMode}

Article URL: ${url}
Article Content:
${String(markdownContent || '').substring(0, 15000)}`;
}

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
  const metadataOnly = () => env.CONTENTFORGE_METADATA_ONLY === 'true';

  async function analyzeArticle(url, markdownContent, cloudProvider, format, revisionIssues, signal) {
    const only = metadataOnly();
    const modelOverride = env.CONTENTFORGE_ANALYSIS_MODEL || null;
    // Recorded on the article and shown in the portal, so it has to be the
    // provider that actually served the call. Now that the portal can reorder
    // providers, a guess taken before the call can name a different one.
    const usage = [];
    const revisionClause =
      Array.isArray(revisionIssues) && revisionIssues.length > 0
        ? `\n\nThis is a revision of a draft an editorial critique pass rejected. Fix every issue below — do not just paraphrase around them:\n${revisionIssues.map((issue) => `- ${issue}`).join('\n')}`
        : '';
    const systemPrompt = only
      ? ANALYSIS_SYSTEM_PROMPT
      : `${ANALYSIS_SYSTEM_PROMPT}\n\n${buildVoiceAndFormatBlock(cloudProvider, format)}${revisionClause}`;
    const prompt = buildAnalysisPrompt(url, markdownContent, only);

    log.log?.('[ai-model] article analysis starting', {
      metadataOnly: only,
      format: format?.key,
    });
    const metadata = await ai.generateJsonResponse({
      prompt,
      systemPrompt,
      model: modelOverride,
      purpose: 'analysis',
      usageOut: usage,
      feature: 'inspector',
      signal,
    });
    const aiProvider = usage.at(-1)?.provider || ai.getActiveAiProvider();
    log.log?.(`[ai-model] article analysis via ${aiProvider}`);
    // Fingerprint only — never the payload.
    log.log?.('[ai-model] analysis complete', {
      title: metadata?.title,
      cloudProvider: metadata?.cloudProvider,
      postContentChars:
        typeof metadata?.postContent === 'string' ? metadata.postContent.length : undefined,
    });
    return {
      metadata,
      prompt,
      model: modelOverride || `${aiProvider}:default`,
      aiProvider,
      format: format?.key || null,
    };
  }

  /** Alt text for up to five images, only when CONTENTFORGE_ALT_TEXT_ENABLED=true. */
  async function generateAltTexts(imageUrls, signal) {
    if (env.CONTENTFORGE_ALT_TEXT_ENABLED !== 'true') return {};
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) return {};
    const results = {};
    for (const url of imageUrls.slice(0, 5)) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      try {
        // These URLs come from `scraped.images` — whatever page sourceUrl
        // pointed at — so they are attacker-influenced. Bare fetch performed no
        // protocol check, no private-range refusal, no timeout and no size cap,
        // while the repository already contained exactly the right primitive:
        // fetch-image.js validates the protocol, refuses localhost, resolves
        // the host to IPv4, refuses private ranges, and re-checks on every
        // redirect hop (T-734).
        const fetched = await fetchImageImpl(url, { fetch: fetchImpl });
        // A scraped `<img src>` that turns out to be a video gets no alt text
        // rather than being posted to a vision model as an image (#415). One
        // image skipped, the other four still described.
        if (fetched.refused) {
          log.warn?.(`[alt-text] ${url}: ${fetched.reason}`);
          continue;
        }
        // The fetcher's gate guarantees a mapped `image/*` type, so this is
        // the measured type and there is no extension guess left to make.
        const { buffer, contentType: mimeType } = fetched;
        const altText = await ai.generateTextResponse({
          parts: [
            {
              text: 'Describe this image in one concise sentence suitable for an HTML alt attribute (max 125 characters). Focus on the visible subject and context. Do not start with "Image of" or "A photo of". Return only the description text, no quotes.',
            },
            { inlineData: { mimeType, data: buffer.toString('base64') } },
          ],
          purpose: 'multimodal',
          feature: 'altText',
          signal,
        });
        if (altText && altText.trim()) results[url] = altText.trim().slice(0, 125);
      } catch (error) {
        log.warn?.(`[alt-text] ${url}: ${error?.message || error}`);
      }
    }
    return results;
  }

  async function inspectArticleSource(targetUrl, cloudProvider, existingPublishedAt, signal) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const scraped = await scrape(targetUrl, { signal });
    if (!scraped.success) throw new Error(scraped.error || 'Scraping failed');
    scraped.images = referenceScrapedImages(scraped.images);

    let publishedAt = existingPublishedAt || null;
    if (!publishedAt) {
      const extracted = extractPublishedDate(scraped.html);
      if (extracted) publishedAt = extracted.toISOString();
    }

    const format = await pickNextFormat(store, 'content', cloudProvider);
    let analysis = await analyzeArticle(targetUrl, scraped.markdown, cloudProvider, format, null, signal);

    // Quality gate: one automatic revision, then the verdict stands.
    let critique = null;
    let revised = false;
    const post = analysis.metadata?.postContent;
    if (typeof post === 'string' && post.trim()) {
      critique = await critic.critiqueDraft({ title: analysis.metadata.title, postContent: post, signal });
      if (critique.verdict === 'revise') {
        analysis = await analyzeArticle(
          targetUrl,
          scraped.markdown,
          cloudProvider,
          format,
          critique.issues,
          signal
        );
        revised = true;
        critique = await critic.critiqueDraft({
          title: analysis.metadata.title,
          postContent: analysis.metadata.postContent,
          signal,
        });
      }
    }

    const imageAltTexts = await generateAltTexts(
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

    log.log?.(`[inspect:${collectionName}] ${docId} — ${targetUrl}`);
    // RSS writes 'Cloud Provider'; manual submission writes cloudProvider.
    const cloudProvider = newData.cloudProvider || newData['Cloud Provider'] || null;
    const inspection = await inspectArticleSource(
      targetUrl,
      cloudProvider,
      newData.publishedAt || newData['Published At'],
      activeSignal
    );
    const update = buildInspectionUpdateData({ newData, targetUrl, ...inspection, now: now() });
    await store.patchDoc(collectionName, docId, update);
    log.log?.(`[inspect:${collectionName}] ${docId} → ${update.contentStatus}`);
    return {
      docId,
      contentStatus: update.contentStatus,
      format: update.format || null,
      revised: inspection.revised,
    };
  }

  return { analyzeArticle, generateAltTexts, inspectArticleSource, executeInspection };
}
