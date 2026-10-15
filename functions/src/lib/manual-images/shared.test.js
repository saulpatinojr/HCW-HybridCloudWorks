/**
 * What the manual image handlers share (PR #841 split of manual-images.js).
 * The routes stay pinned in manual-images.test.js.
 */
import { describe, it, expect, vi } from 'vitest';
import { compact, generationFailure, modelInfo, readNamedSet } from './shared.js';
import { ImageBudgetError } from '../triggers/ai-cover.js';

describe('compact', () => {
  it('reduces an ISO stamp to its 14 digits', () => {
    expect(compact('2026-10-03T12:34:56.789Z')).toBe('20261003123456');
    expect(compact('')).toBe('');
  });
});

describe('modelInfo', () => {
  it('names the provider and model, and the cost only when it is a number', () => {
    expect(modelInfo({ provider: 'replicate', model: 'flux', costPerImageUsd: 0.03 })).toEqual({
      imageProvider: 'replicate',
      imageModel: 'flux',
      costPerImageUsd: 0.03,
    });
    expect(modelInfo({})).toEqual({
      imageProvider: 'replicate',
      imageModel: '',
      costPerImageUsd: null,
    });
  });
});

describe('readNamedSet', () => {
  it('reads nothing without a set name or a readable store', async () => {
    expect(await readNamedSet({}, '', 'p')).toEqual({ set: null, prompt: null });
    expect(await readNamedSet({ readDoc: vi.fn() }, '  ', 'p')).toEqual({
      set: null,
      prompt: null,
    });
  });

  it('reads the set, then the prompt from the set partition, tolerating a missing one', async () => {
    const readDoc = vi.fn(async (container, id) =>
      container === 'image_prompt_sets' ? { id, aspectRatio: '16:9' } : null
    );
    const named = await readNamedSet({ readDoc }, ' hero ', 'variant');
    expect(named.set).toEqual({ id: 'hero', aspectRatio: '16:9' });
    expect(named.prompt).toBeNull();
    expect(readDoc).toHaveBeenNthCalledWith(1, 'image_prompt_sets', 'hero', 'hero');
    expect(readDoc).toHaveBeenNthCalledWith(2, 'image_prompt_sets_prompts', 'variant', 'hero');
  });

  it('reads as absent when the set read throws', async () => {
    const readDoc = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await readNamedSet({ readDoc }, 'hero', 'p')).toEqual({ set: null, prompt: null });
  });
});

describe('generationFailure', () => {
  it('answers the 500 with the message, logging only the code and the correlation id', () => {
    const context = { error: vi.fn(), invocationId: 'inv-1' };
    const response = generationFailure(context, 'generateX', new Error('boom'), 'Failed X');
    expect(context.error).toHaveBeenCalledWith('[inv-1] Failed X (name=Error)');
    expect(JSON.stringify(context.error.mock.calls)).not.toContain('boom');
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: 'Failed X', correlationId: 'inv-1' });
  });

  it('keeps the image budget\'s own status, code and (authored) sentence, so the page can say paused', () => {
    const context = { error: vi.fn(), warn: vi.fn(), invocationId: 'inv-2' };
    const paused = new ImageBudgetError('Image generation paused: $10.00 of the $10 budget used', {
      code: 'IMAGE_BUDGET_EXHAUSTED',
      status: 429,
    });
    const response = generationFailure(context, 'generateX', paused, 'Failed X');
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Failed X',
      code: 'IMAGE_BUDGET_EXHAUSTED',
      message: 'Image generation paused: $10.00 of the $10 budget used',
      correlationId: 'inv-2',
    });
    expect(context.warn).toHaveBeenCalledWith(
      '[inv-2] generateX paused (name=ImageBudgetError code=IMAGE_BUDGET_EXHAUSTED status=429)'
    );
  });

  it('a budget-coded error that is not authored keeps its status and code, not its words (#945)', () => {
    const forged = Object.assign(new Error('Cosmos says: ActivityId 9f, RequestUri /dbs/x'), {
      code: 'IMAGE_BUDGET_UNKNOWN',
      status: 503,
    });
    const body = JSON.parse(generationFailure({ error: vi.fn() }, 'generateX', forged, 'Failed X').body);
    expect(body).toMatchObject({
      code: 'IMAGE_BUDGET_UNKNOWN',
      message: 'Image generation is paused by the monthly budget.',
    });
    expect(JSON.stringify(body)).not.toContain('ActivityId');
  });
});
