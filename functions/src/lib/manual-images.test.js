import { describe, it, expect, vi } from 'vitest';
import {
  createManualImageHandlers,
  buildCuratedPrompt,
  buildPreviewSlotPrompt,
  TRIGGER_MAX_CONTENT_IDS,
} from './manual-images.js';

const guardAs = (role) => ({
  requireRole: vi.fn(async () =>
    role ? { user: { oid: 'u1' }, role, error: null } : { error: { status: 403, body: '{}' } }
  ),
});
const request = (body) => ({ json: async () => body, headers: { get: () => null } });
const context = { error: vi.fn() };

function makeHandlers({
  role = 'editor',
  doc,
  configured = true,
  fetchImage = vi.fn(async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' })),
} = {}) {
  const store = {
    readDoc: vi.fn(async () => doc ?? null),
    patchDoc: vi.fn(async () => ({})),
    upsertDoc: vi.fn(async (c, d) => d),
  };
  const storage = { uploadBlob: vi.fn(async () => 'ok') };
  const replicate = { configured, generate: vi.fn(async () => 'https://replicate/img.png') };
  let n = 0;
  const handlers = createManualImageHandlers({
    guard: guardAs(role),
    store,
    storage,
    replicate,
    fetchImage,
    now: () => new Date('2026-08-28T12:00:00Z'),
    uuid: () => `img-${++n}`,
  });
  return { handlers, store, storage, replicate };
}

describe('prompt builders', () => {
  it('curated prompt themes by provider and bans text overlays', () => {
    const prompt = buildCuratedPrompt({
      basePrompt: 'Isometric datacenter',
      articleTitle: 'AWS re:Invent recap',
      articleSummary: 'The launches that matter.',
      provider: 'AWS',
    });
    expect(prompt).toContain('Isometric datacenter');
    expect(prompt).toContain('orange and dark blue');
    expect(prompt).toContain('AWS re:Invent recap');
    expect(prompt).toContain('No text overlays');
  });

  it('preview prompt prefers the slot template, falls back to summary prompt, always names the slot', () => {
    const templated = buildPreviewSlotPrompt({
      slot: 'hero',
      template: 'A custom hero scene',
      summaryPrompt: 'ignored',
      title: 'T',
      provider: 'Azure',
    });
    expect(templated).toContain('A custom hero scene');
    expect(templated).not.toContain('ignored');
    expect(templated).toContain('Image slot: hero');

    const fallback = buildPreviewSlotPrompt({ slot: 'secondary1', title: 'My draft' });
    expect(fallback).toContain('My draft');
    expect(fallback).toContain('Image slot: secondary1');
  });
});

describe('triggerAiImageGeneration', () => {
  it('arms the change-feed flag with targets and seed, per id', async () => {
    const { handlers, store } = makeHandlers();
    const res = await handlers.triggerAiImageGeneration(
      request({ contentIds: ['c1', 'c2'], aiImageTargets: ['hero'], imagePromptSeed: ' seed ' }),
      context
    );
    expect(JSON.parse(res.body)).toEqual({ success: true, queued: 2, errors: [] });
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'c1', {
      altCoverImageTrigger: true,
      aiImageTargets: ['hero'],
      altCoverImagePrompt: 'seed',
    });
  });

  it('rejects empty and oversized batches, reports per-id failures', async () => {
    const { handlers, store } = makeHandlers();
    expect((await handlers.triggerAiImageGeneration(request({}), context)).status).toBe(400);
    expect(
      (
        await handlers.triggerAiImageGeneration(
          request({
            contentIds: Array.from({ length: TRIGGER_MAX_CONTENT_IDS + 1 }, (_, i) => `c${i}`),
          }),
          context
        )
      ).status
    ).toBe(400);

    store.patchDoc.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    const res = await handlers.triggerAiImageGeneration(
      request({ contentIds: ['ghost', 'c2'] }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body.queued).toBe(1);
    expect(body.errors).toEqual([{ contentId: 'ghost', error: 'not found' }]);
  });
});

describe('generateReviewHeroImage', () => {
  it('generates through the shared cover path and patches the doc like the feed would', async () => {
    const { handlers, store } = makeHandlers({
      doc: { id: 'c1', Title: 'T', 'Cloud Provider': 'AWS' },
    });
    const res = await handlers.generateReviewHeroImage(request({ contentId: 'c1' }), context);
    const body = JSON.parse(res.body);
    // Stamped path (ADR 0033 §6.2): a regeneration never overwrites.
    const url = '/api/public/media/covers/c1-ai-hero-20260828120000.png';
    expect(body).toMatchObject({ success: true, imageUrl: url, promptSource: 'builtin' });
    expect(body.imageProvider).toBe('replicate');
    // Gallery record via the shared path, carrying the delete ref, the model
    // and the lineage of the prompt that produced it…
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'generated_content_images',
      expect.objectContaining({
        slot: 'hero',
        sourceCollection: 'content',
        storagePath: 'covers/c1-ai-hero-20260828120000.png',
        imageProvider: 'replicate',
        promptTemplateVersion: 'builtin-lego-v1',
        bytes: 3,
      })
    );
    // …and the same update fields the change-feed trigger writes.
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'c1',
      expect.objectContaining({ altCoverImage: url, altCoverImageError: null })
    );
  });

  it('404s a missing doc and 503s when Replicate is unconfigured', async () => {
    const missing = makeHandlers();
    expect(
      (await missing.handlers.generateReviewHeroImage(request({ contentId: 'ghost' }), context))
        .status
    ).toBe(404);
    const unconfigured = makeHandlers({ configured: false, doc: { id: 'c1' } });
    expect(
      (await unconfigured.handlers.generateReviewHeroImage(request({ contentId: 'c1' }), context))
        .status
    ).toBe(503);
  });
});

describe('generateCuratedArticleImage', () => {
  it('stores the blob and the doc the public curated-image route serves', async () => {
    const { handlers, store, storage } = makeHandlers();
    const res = await handlers.generateCuratedArticleImage(
      request({
        articleId: 'a1',
        articleTitle: 'Title',
        articleSummary: 'Sum',
        basePrompt: 'Base',
        provider: 'GCP',
        articleUrl: 'https://src',
      }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      imageUrl: '/api/public/media/covers/curated-a1.png',
      imageProvider: 'replicate',
    });
    expect(storage.uploadBlob.mock.calls[0][1]).toBe('curated-a1.png');
    // Doc id IS the article id — the public route's lookup key.
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'curated_article_images',
      expect.objectContaining({
        id: 'a1',
        imageUrl: '/api/public/media/covers/curated-a1.png',
        archived: false,
      })
    );
  });

  it('400s without an articleId or title', async () => {
    const { handlers } = makeHandlers();
    expect(
      (await handlers.generateCuratedArticleImage(request({ articleTitle: 'T' }), context)).status
    ).toBe(400);
  });

  it('answers the image budget\'s 429 with its code, not a generic 500 (#854)', async () => {
    const { handlers, replicate, storage } = makeHandlers();
    replicate.generate = vi.fn(async () => {
      throw Object.assign(new Error('Image generation paused: $10.00 of the $10 monthly image budget used'), {
        code: 'IMAGE_BUDGET_EXHAUSTED',
        status: 429,
      });
    });
    const res = await handlers.generateCuratedArticleImage(
      request({ articleId: 'a1', articleTitle: 'Title' }),
      context
    );
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'IMAGE_BUDGET_EXHAUSTED' });
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('500s and stores nothing when the generated file is not an image (#415)', async () => {
    const { handlers, storage, store } = makeHandlers({
      fetchImage: vi.fn(async () => ({
        refused: 'not-an-image',
        contentType: 'video/mp4',
        reason: 'Content-Type video/mp4 is not an image',
      })),
    });
    const res = await handlers.generateCuratedArticleImage(
      request({ articleId: 'a1', articleTitle: 'Title' }),
      context
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe('Failed to generate curated image');
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('generatePreviewImages', () => {
  it('returns the slot-keyed triple the Submit URLs page reads', async () => {
    const { handlers, store } = makeHandlers();
    const res = await handlers.generatePreviewImages(
      request({
        articleId: 'draft-1',
        aiImageTargets: ['hero'],
        slotTemplates: { hero: 'Hero template' },
        title: 'Draft',
        provider: 'Azure',
        contentType: 'blog',
        sourceUrl: 'https://src',
      }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const url = '/api/public/media/covers/preview-draft-1-hero-20260828120000.png';
    expect(body.imageUrls.hero).toBe(url);
    expect(body.imageRecords.hero).toEqual({ imageId: 'img-1', imageUrl: url });
    expect(body.promptLogs.hero).toContain('Hero template');
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'generated_content_images',
      expect.objectContaining({ id: 'img-1', slot: 'hero', sourceCollection: 'preview' })
    );
  });

  it('rejects unknown slots and missing articleId', async () => {
    const { handlers } = makeHandlers();
    expect(
      (
        await handlers.generatePreviewImages(
          request({ articleId: 'a', aiImageTargets: ['banner'] }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (await handlers.generatePreviewImages(request({ aiImageTargets: ['hero'] }), context)).status
    ).toBe(400);
  });
});

describe('authorization', () => {
  it('every handler refuses without the editor role', async () => {
    const { handlers } = makeHandlers({ role: null });
    for (const [name, body] of [
      ['triggerAiImageGeneration', { contentIds: ['c1'] }],
      ['generateReviewHeroImage', { contentId: 'c1' }],
      ['generateCuratedArticleImage', { articleId: 'a', articleTitle: 'T' }],
      ['generatePreviewImages', { articleId: 'a', aiImageTargets: ['hero'] }],
    ]) {
      expect((await handlers[name](request(body), context)).status).toBe(403);
    }
  });
});

// ── ADR 0033: lineage, the keyword matrix and the per-set sample ────────────

describe('lineage and the keyword matrix', () => {
  function libraryHandlers() {
    const set = {
      id: 'S',
      name: 'S',
      primaryPrompt: 'Set prompt',
      styleRules: 'flat',
      aspectRatio: '1:1',
      version: 2,
      tags: ['Azure'],
    };
    const promptDoc = { id: 'Hero', name: 'Hero', setName: 'S', slotTemplates: { hero: 'wide shot' } };
    const store = {
      readDoc: vi.fn(async (c, id) => {
        if (c === 'image_prompt_sets' && id === 'S') return set;
        if (c === 'image_prompt_sets_prompts' && id === 'Hero') return promptDoc;
        return null;
      }),
      patchDoc: vi.fn(async () => ({})),
      upsertDoc: vi.fn(async (c, d) => d),
      queryDocs: vi.fn(async (c) =>
        c === 'prompt_keyword_augmentations'
          ? [{ id: 'k', label: 'kiro', patterns: ['kiro'], directive: 'Include the Kiro icon.' }]
          : []
      ),
    };
    const storage = { uploadBlob: vi.fn(async () => 'ok') };
    const replicate = {
      configured: true,
      provider: 'replicate',
      model: 'm',
      costPerImageUsd: 0.02,
      generate: vi.fn(async () => 'https://replicate/img.png'),
    };
    const handlers = createManualImageHandlers({
      guard: guardAs('editor'),
      store,
      storage,
      replicate,
      fetchImage: vi.fn(async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' })),
      now: () => new Date('2026-08-28T12:00:00Z'),
      uuid: () => 'img-1',
    });
    return { handlers, store, storage, replicate };
  }

  it('generatePreviewImages applies the matrix and records the named set’s lineage', async () => {
    const { handlers, store, replicate } = libraryHandlers();
    const res = await handlers.generatePreviewImages(
      request({
        articleId: 'd1',
        aiImageTargets: ['hero'],
        title: 'Kiro on Azure',
        promptSet: 'S',
        promptName: 'Hero',
      }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body.promptLogs.hero).toContain('Include the Kiro icon.');
    expect(body).toMatchObject({ imageProvider: 'replicate', imageModel: 'm', costPerImageUsd: 0.02 });
    expect(replicate.generate.mock.calls[0][1]).toEqual({
      aspectRatio: '1:1',
      source: 'images:manual',
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'generated_content_images',
      expect.objectContaining({
        promptSet: 'S',
        promptName: 'Hero',
        promptTemplateVersion: 'S@v2',
        imageModel: 'm',
        approvalStatus: 'draft',
      })
    );
  });

  it('generateCuratedArticleImage writes createdAt, title and the model so the gallery can sort and label it', async () => {
    const { handlers, store } = libraryHandlers();
    await handlers.generateCuratedArticleImage(
      request({ articleId: 'a1', articleTitle: 'Kiro news', provider: 'AWS' }),
      context
    );
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc).toMatchObject({
      id: 'a1',
      title: 'Kiro news',
      slot: 'curated',
      storagePath: 'covers/curated-a1.png',
      imageModel: 'm',
    });
    expect(doc.createdAt).toBe('2026-08-28T12:00:00.000Z');
    expect(doc.prompt).toContain('Include the Kiro icon.');
  });

  it('generatePromptSetSample composes from the set and files the row under the set', async () => {
    const { handlers, store, storage, replicate } = libraryHandlers();
    const res = await handlers.generatePromptSetSample(
      request({ setName: 'S', promptName: 'Hero', title: 'Try it' }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      imageId: 'img-1',
      promptTemplateVersion: 'S@v2',
      imageProvider: 'replicate',
      costPerImageUsd: 0.02,
    });
    expect(body.prompt).toContain('Set prompt');
    expect(body.prompt).toContain('Slot composition: wide shot');
    expect(replicate.generate.mock.calls[0][1]).toEqual({
      aspectRatio: '1:1',
      source: 'images:manual',
    });
    expect(storage.uploadBlob.mock.calls[0][1]).toBe('promptset-s-hero-20260828120000.png');
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'generated_content_images',
      expect.objectContaining({
        articleId: 'promptset-s',
        sourceCollection: 'preview',
        promptSet: 'S',
        customTags: ['azure'],
      })
    );
  });

  it('generatePromptSetSample 400s without a set, 404s an unknown one, 403s without the role', async () => {
    const { handlers } = libraryHandlers();
    expect((await handlers.generatePromptSetSample(request({}), context)).status).toBe(400);
    expect((await handlers.generatePromptSetSample(request({ setName: 'Nope' }), context)).status).toBe(404);
    const denied = makeHandlers({ role: null });
    expect((await denied.handlers.generatePromptSetSample(request({ setName: 'S' }), context)).status).toBe(403);
  });

  it('triggerAiImageGeneration clears a previous override when the seed is empty, so the library applies again', async () => {
    const { handlers, store } = makeHandlers();
    await handlers.triggerAiImageGeneration(request({ contentIds: ['c1'], imagePromptSeed: '' }), context);
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'c1',
      expect.objectContaining({ altCoverImagePrompt: null })
    );
  });
});
