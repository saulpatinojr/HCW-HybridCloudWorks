/**
 * createDrafter: the time budget it hands the AI router (router.js header,
 * SYNCHRONOUS CALLS HAVE A TIME BUDGET). The drafter's use by the forge is
 * covered in forge.test.js; this file covers only what a synchronous caller
 * relies on.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildDraftPrompt, createDrafter } from './drafting.js';
import { ARTICLE_TOPICS } from '../cms/article-topics.js';

const reply = { title: 'T', summary: 'S', postContent: '# P', keyTopics: [] };
const aiReturning = () => ({
  generateJsonResponse: vi.fn(async () => reply),
  getActiveAiProvider: () => 'gemini',
});

describe('createDrafter: time budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the router what is left of the budget after the format lookup', async () => {
    vi.useFakeTimers();
    const store = {
      queryDocs: vi.fn(async () => {
        vi.advanceTimersByTime(1_500);
        return [];
      }),
    };
    const ai = aiReturning();
    await createDrafter({ store, ai, env: {} }).generateDraft({
      url: 'https://a.example/x',
      markdown: 'body',
      budgetMs: 60_000,
    });
    expect(ai.generateJsonResponse).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'forgeDrafting', purpose: 'draft', budgetMs: 58_500 })
    );
  });

  it('passes no budget when given none, so the forge and the digest keep the full timeouts', async () => {
    const ai = aiReturning();
    await createDrafter({ store: { queryDocs: async () => [] }, ai, env: {} }).generateDraft({
      url: 'https://a.example/x',
      markdown: 'body',
    });
    expect(ai.generateJsonResponse.mock.calls[0][0].budgetMs).toBeUndefined();
  });
});

describe('createDrafter: the address topic (#1628)', () => {
  it('asks for one word from the list', () => {
    const prompt = buildDraftPrompt({ url: 'https://a.example/x', instructionPrompt: '' });
    expect(prompt).toContain(`topic (exactly one of: ${ARTICLE_TOPICS.join(', ')};`);
  });

  it.each([
    ['hybrid', 'hybrid'],
    ['Copilot', null],
    [undefined, null],
  ])('keeps a topic on the list and drops anything else (%s → %s)', async (given, kept) => {
    const ai = {
      generateJsonResponse: vi.fn(async () => ({ ...reply, topic: given })),
      getActiveAiProvider: () => 'gemini',
    };
    const draft = await createDrafter({ store: { queryDocs: async () => [] }, ai, env: {} }).generateDraft({
      url: 'https://a.example/x',
      markdown: 'body',
    });
    expect(draft.topic).toBe(kept);
  });
});
