import { describe, it, expect, vi } from 'vitest';
import {
  buildInspectionUpdateData,
  buildAnalysisPrompt,
  createInspector,
  ANALYSIS_SYSTEM_PROMPT,
  ARCHITECTURE_NOT_PORTED,
} from './inspect.js';

const NOW = new Date('2026-08-21T17:00:00.000Z');

// Ported from Site-Main index.handlers.test.js › buildInspectionUpdateData.
describe('buildInspectionUpdateData', () => {
  const baseArgs = {
    newData: {},
    targetUrl: 'https://example.com/post',
    scraped: { markdown: '# Post body', wordCount: 850 },
    metadata: { title: 'A Post', summary: 'S', cloudProvider: 'aws', visualTheme: 'dark' },
    analysisPrompt: 'PROMPT',
    analysisModel: 'model-x',
    publishedAt: null,
    now: NOW,
  };

  it('applies source defaults only to drafts carrying a blog-source identity', () => {
    const scraped = { ...baseArgs.scraped, images: [{ original: 'https://example.com/article.png' }] };
    expect(buildInspectionUpdateData({ ...baseArgs, scraped })).not.toHaveProperty('coverImage');
    expect(buildInspectionUpdateData({ ...baseArgs, scraped, newData: { type: 'framework' } })).not.toHaveProperty('coverImage');
    expect(buildInspectionUpdateData({ ...baseArgs, scraped, newData: { blogSourceId: 'listing-source' } })).toMatchObject({ coverImage: 'https://example.com/article.png' });
    expect(buildInspectionUpdateData({ ...baseArgs, newData: { blogSourceId: 'rss-source', blogFallbackImageUrl: 'https://example.com/default.png' } })).toMatchObject({ coverImage: 'https://example.com/default.png' });
  });

  it('defaults a blog inspection: status, type, slug, capped bodies, nulled extras', () => {
    const update = buildInspectionUpdateData(baseArgs);
    expect(update).toMatchObject({
      inspectTrigger: false,
      inspectCompletedAt: NOW.toISOString(),
      contentStatus: 'inspected',
      inspectError: null,
      type: 'blog',
      slug: 'a-post',
      scrapedMethod: 'fetch-cheerio',
      content: '# Post body',
      contentHtml: null,
      contentPlainText: null,
      scrapedImages: [],
      scrapedImagesCount: 0,
      imageAltTexts: null,
      cloudProvider: 'aws',
      keyTopics: [],
      targetAudience: 'Cloud Architect',
      scrapedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    for (const absent of [
      'postContent',
      'diagramUrl',
      'format',
      'critiqueVerdict',
      'publishedAt',
      'altCoverImageTrigger',
    ]) {
      expect(update).not.toHaveProperty(absent);
    }
  });

  it('keeps caller identity fields, spreads postContent only when generated', () => {
    const update = buildInspectionUpdateData({
      ...baseArgs,
      newData: { type: 'framework', slug: 'my-slug', cloudProvider: 'azure' },
      metadata: { ...baseArgs.metadata, postContent: 'Generated body', keyTopics: ['iam'] },
      publishedAt: '2026-08-01T00:00:00.000Z',
      format: 'news_analysis',
    });
    expect(update).toMatchObject({
      type: 'framework',
      slug: 'my-slug',
      cloudProvider: 'azure',
      keyTopics: ['iam'],
      postContent: 'Generated body',
      publishedAt: '2026-08-01T00:00:00.000Z',
      format: 'news_analysis',
    });
    expect(
      buildInspectionUpdateData({
        ...baseArgs,
        metadata: { ...baseArgs.metadata, postContent: '   ' },
      })
    ).not.toHaveProperty('postContent');
    expect(
      buildInspectionUpdateData({
        ...baseArgs,
        metadata: { ...baseArgs.metadata, tags: ['legacy-tag'] },
      }).keyTopics
    ).toEqual(['legacy-tag']);
  });

  it('adds architecture extras and switches the scrape method', () => {
    const update = buildInspectionUpdateData({
      ...baseArgs,
      newData: { type: 'architecture' },
      metadata: { ...baseArgs.metadata, category: 'networking', overviewHtml: '<p>o</p>' },
    });
    expect(update).toMatchObject({
      scrapedMethod: 'gemini-multimodal',
      diagramUrl: 'https://example.com/post',
      category: 'networking',
      overview: '<p>o</p>',
    });
  });

  it('routes a revise verdict to needs_rework with the critique fields, and honours the cover opt-in', () => {
    const update = buildInspectionUpdateData({
      ...baseArgs,
      critique: { verdict: 'revise', genericityScore: 8, specificityScore: 2, issues: ['vague'] },
      revised: true,
      newData: { generateAiCoverOnInspect: true },
    });
    expect(update.contentStatus).toBe('needs_rework');
    expect(update).toMatchObject({
      critiqueVerdict: 'revise',
      critiqueGenericityScore: 8,
      critiqueSpecificityScore: 2,
      critiqueIssues: ['vague'],
      draftRevised: true,
      altCoverImageTrigger: true,
    });
    expect(
      buildInspectionUpdateData({
        ...baseArgs,
        newData: { generateAiCoverOnInspect: true, skipImageGeneration: true },
      })
    ).not.toHaveProperty('altCoverImageTrigger');
  });
});

describe('buildAnalysisPrompt', () => {
  it('asks for metadata only when told, and caps the article at 15k chars', () => {
    expect(buildAnalysisPrompt('https://x', 'body', true)).toMatch(
      /Do NOT include a postContent field/
    );
    expect(buildAnalysisPrompt('https://x', 'body', false)).toMatch(/including postContent/);
    expect(buildAnalysisPrompt('https://x', 'y'.repeat(20000), false).length).toBeLessThan(15300);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(
      /^You are a technical content analyst for Hybrid Cloud Works/
    );
    expect(ANALYSIS_SYSTEM_PROMPT.length).toBeGreaterThan(3000); // verbatim upstream, not trimmed
  });
});

describe('createInspector', () => {
  const page =
    '<html><head><meta property="article:published_time" content="2026-08-10T09:30:00Z"></head><body><article>' +
    'Real content. '.repeat(60) +
    '<img src="/a.png" alt="A"></article></body></html>';
  const scrapedOk = {
    success: true,
    markdown: '# Body\n\nReal content.',
    html: page,
    plainText: 'Real content.',
    images: [{ url: 'https://s/a.png', alt: 'A', index: 0 }],
    wordCount: 120,
  };
  const metadata = {
    title: 'Optimising EKS',
    summary: 's',
    cloudProvider: 'AWS',
    keyTopics: ['AWS EKS'],
    targetAudience: 'Cloud Architect',
    visualTheme: 'v',
    postContent: 'A specific post about m6i.2xlarge nodes.',
  };

  function deps(over = {}) {
    const store = {
      queryDocs: vi.fn(async () => [{ format: 'how_to' }]),
      patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    };
    const ai = {
      getActiveAiProvider: () => 'anthropic',
      generateJsonResponse: vi.fn(async () => ({ ...metadata })),
      generateTextResponse: vi.fn(async () => 'An EKS diagram'),
    };
    const critic = {
      critiqueDraft: vi.fn(async () => ({
        verdict: 'pass',
        genericityScore: 2,
        specificityScore: 8,
        issues: [],
      })),
    };
    return {
      store,
      ai,
      critic,
      scrape: vi.fn(async () => ({ ...scrapedOk })),
      env: {},
      now: () => NOW,
      ...over,
    };
  }

  it('scrapes, rotates the format, analyses with the voice block, critiques, and writes the document', async () => {
    const d = deps();
    const inspector = createInspector(d);
    const out = await inspector.executeInspection({
      docId: 'doc-1',
      newData: { 'CD Url': 'https://src/post', 'Cloud Provider': 'AWS' },
    });
    expect(out).toEqual({
      docId: 'doc-1',
      contentStatus: 'inspected',
      format: 'comparison',
      revised: false,
    });
    // format rotation skipped how_to (the recent one) → comparison
    const call = d.ai.generateJsonResponse.mock.calls[0][0];
    expect(call.systemPrompt).toMatch(/Write as an AWS-focused practitioner/);
    expect(call.systemPrompt).toMatch(/Comparison \/ Trade-off/);
    expect(call.purpose).toBe('analysis');
    const [, id, update] = d.store.patchDoc.mock.calls[0];
    expect(id).toBe('doc-1');
    expect(update).toMatchObject({
      contentStatus: 'inspected',
      publishedAt: '2026-08-10T00:00:00.000Z',
      scrapedImages: [{ original: 'https://s/a.png', alt: 'A', index: 0 }],
      postContent: metadata.postContent,
      format: 'comparison',
      imageAltTexts: null,
    });
    expect(d.ai.generateTextResponse).not.toHaveBeenCalled(); // alt text off by default
  });

  it('keeps an existing publish date, revises once on a revise verdict, and lands needs_rework if still generic', async () => {
    const d = deps();
    d.critic.critiqueDraft.mockResolvedValue({
      verdict: 'revise',
      genericityScore: 8,
      specificityScore: 2,
      issues: ['too vague'],
    });
    const inspector = createInspector(d);
    const out = await inspector.executeInspection({
      docId: 'doc-2',
      newData: { sourceUrl: 'https://src/p', 'Published At': '2026-07-01T00:00:00.000Z' },
    });
    expect(out).toMatchObject({ contentStatus: 'needs_rework', revised: true });
    expect(d.ai.generateJsonResponse).toHaveBeenCalledTimes(2);
    expect(d.ai.generateJsonResponse.mock.calls[1][0].systemPrompt).toMatch(/too vague/);
    expect(d.critic.critiqueDraft).toHaveBeenCalledTimes(2);
    expect(d.store.patchDoc.mock.calls[0][2].publishedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('metadata-only mode skips the voice block and the critique; alt text runs only when enabled', async () => {
    const d = deps({
      env: { CONTENTFORGE_METADATA_ONLY: 'true', CONTENTFORGE_ALT_TEXT_ENABLED: 'true' },
      // Alt-text image fetches now go through the SSRF-validating fetcher
      // (T-734), which resolves the host and refuses private ranges — so the
      // stub is at that seam rather than at bare fetch.
      fetchImage: vi.fn(async () => ({
        buffer: Buffer.from([1, 2, 3]),
        contentType: 'image/png',
      })),
    });
    d.ai.generateJsonResponse.mockResolvedValue({ ...metadata, postContent: undefined });
    const inspector = createInspector(d);
    await inspector.executeInspection({ docId: 'doc-3', newData: { url: 'https://src/p' } });
    expect(d.ai.generateJsonResponse.mock.calls[0][0].systemPrompt).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(d.critic.critiqueDraft).not.toHaveBeenCalled();
    expect(d.ai.generateTextResponse).toHaveBeenCalledTimes(1);
    expect(d.store.patchDoc.mock.calls[0][2].imageAltTexts).toEqual({
      'https://s/a.png': 'An EKS diagram',
    });
  });

  it('skips alt text for a scraped image that is not an image, and says so (#415)', async () => {
    const d = deps({
      env: { CONTENTFORGE_METADATA_ONLY: 'true', CONTENTFORGE_ALT_TEXT_ENABLED: 'true' },
      fetchImage: vi.fn(async () => ({
        refused: 'not-an-image',
        contentType: 'video/mp4',
        reason: 'Content-Type video/mp4 is not an image',
      })),
      log: { log: vi.fn(), warn: vi.fn() },
    });
    d.ai.generateJsonResponse.mockResolvedValue({ ...metadata, postContent: undefined });
    const inspector = createInspector(d);
    await inspector.executeInspection({ docId: 'doc-4', newData: { url: 'https://src/p' } });
    // The video is never posted to the vision model as an image.
    expect(d.ai.generateTextResponse).not.toHaveBeenCalled();
    expect(d.store.patchDoc.mock.calls[0][2].imageAltTexts).toBe(null);
    expect(d.log.warn).toHaveBeenCalledWith(
      '[alt-text] https://s/a.png: Content-Type video/mp4 is not an image'
    );
  });

  it('fails loudly for a missing URL, a failed scrape, and the unported architecture path', async () => {
    const d = deps();
    const inspector = createInspector(d);
    await expect(inspector.executeInspection({ docId: 'x', newData: {} })).rejects.toThrow(
      /No URL/
    );
    await expect(
      inspector.executeInspection({
        docId: 'x',
        newData: { url: 'https://d', type: 'architecture' },
      })
    ).rejects.toThrow(ARCHITECTURE_NOT_PORTED);
    d.scrape.mockResolvedValue({ success: false, error: 'Status code 403' });
    await expect(
      inspector.executeInspection({ docId: 'x', newData: { url: 'https://d' } })
    ).rejects.toThrow('Status code 403');
    expect(d.store.patchDoc).not.toHaveBeenCalled();
  });
});
