/**
 * The single writer for `ai_usage`.
 *
 * Two properties carry the weight. The row shape must match what the portal's
 * Usage tab reads, because that page totals client-side and a wrong field name
 * shows as zero rather than as an error. And recording must never be able to
 * fail the work it is recording — the model has already answered and already
 * been paid for.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  USAGE_CONTAINER,
  USAGE_SOURCES,
  featureSource,
  recordAiUsage,
  recordAiUsageBatch,
  totalCostUsd,
} from './usage.js';

const deps = (over = {}) => ({
  store: { upsertDoc: vi.fn(async (_c, doc) => doc) },
  ai: { getCostEstimate: vi.fn(() => 0.25) },
  uuid: () => 'fixed-id',
  now: () => new Date('2026-08-24T12:00:00.000Z'),
  ...over,
});

const CALL = {
  provider: 'gemini',
  model: 'gemini-2.5-flash-preview-tts',
  promptTokens: 2500,
  completionTokens: 17280,
};

describe('the row shape the Usage tab reads', () => {
  it('writes every field that page totals or groups by', async () => {
    const d = deps();
    const row = await recordAiUsage(d, {
      ...CALL,
      source: USAGE_SOURCES.listenAndLearnAudio,
    });

    expect(d.store.upsertDoc).toHaveBeenCalledWith(USAGE_CONTAINER, row);
    expect(row).toEqual({
      id: 'fixed-id',
      provider: 'gemini',
      model: 'gemini-2.5-flash-preview-tts',
      promptTokens: 2500,
      completionTokens: 17280,
      totalTokens: 19780,
      estimatedCostUsd: 0.25,
      source: 'listen-and-learn:audio',
      timestamp: '2026-08-24T12:00:00.000Z',
    });
  });

  it('prices through the cost table when the caller supplies no cost', async () => {
    const d = deps();
    await recordAiUsage(d, CALL);
    expect(d.ai.getCostEstimate).toHaveBeenCalledWith(
      'gemini',
      'gemini-2.5-flash-preview-tts',
      2500,
      17280
    );
  });

  it('prefers a cost the caller already computed', async () => {
    // The router hands back what it charged, including after a failover to a
    // different provider — re-deriving it here could price the wrong one.
    const d = deps();
    const row = await recordAiUsage(d, { ...CALL, costUsd: 0.99 });
    expect(row.estimatedCostUsd).toBe(0.99);
    expect(d.ai.getCostEstimate).not.toHaveBeenCalled();
  });

  it('defaults the source rather than writing an ungrouped row', async () => {
    const row = await recordAiUsage(deps(), CALL);
    expect(row.source).toBe(USAGE_SOURCES.admin);
  });

  it('flags derived token counts, and only ever with true', async () => {
    // An absent flag reads as "reported", which is what every historical row
    // is — writing `false` on new rows would make the two look different.
    const flagged = await recordAiUsage(deps(), {
      ...CALL,
      estimatedTokens: true,
    });
    expect(flagged.estimatedTokens).toBe(true);

    const reported = await recordAiUsage(deps(), {
      ...CALL,
      estimatedTokens: false,
    });
    expect(reported).not.toHaveProperty('estimatedTokens');
  });

  it('coerces missing or unusable counts to zero rather than NaN', async () => {
    // A NaN would poison the page's total for every other row.
    const row = await recordAiUsage(deps(), { provider: 'gemini', model: 'm' });
    expect(row.promptTokens).toBe(0);
    expect(row.completionTokens).toBe(0);
    expect(row.totalTokens).toBe(0);
  });
});

describe('recording cannot destroy the work it records', () => {
  it('returns null instead of throwing when the write fails', async () => {
    const d = deps({
      store: {
        upsertDoc: vi.fn(async () => {
          throw new Error('cosmos down');
        }),
      },
    });
    await expect(recordAiUsage(d, CALL)).resolves.toBeNull();
  });

  it('survives an ai dependency with no cost table at all', async () => {
    // This is a real regression: pricing used to happen before the try, so a
    // caller that passed an `ai` without getCostEstimate threw a TypeError that
    // propagated out and failed the episode whose cost it was recording.
    await expect(recordAiUsage(deps({ ai: {} }), CALL)).resolves.toBeNull();
    await expect(recordAiUsage(deps({ ai: undefined }), CALL)).resolves.toBeNull();
  });

  it('survives a cost table that throws', async () => {
    const d = deps({
      ai: {
        getCostEstimate: () => {
          throw new Error('bad model');
        },
      },
    });
    await expect(recordAiUsage(d, CALL)).resolves.toBeNull();
  });
});

describe('batches', () => {
  it('writes each record and returns only what was written', async () => {
    let call = 0;
    const d = deps({
      store: {
        upsertDoc: vi.fn(async (_c, doc) => {
          call += 1;
          if (call === 2) throw new Error('transient');
          return doc;
        }),
      },
    });

    const written = await recordAiUsageBatch(d, [CALL, CALL, CALL]);
    expect(d.store.upsertDoc).toHaveBeenCalledTimes(3);
    expect(written).toHaveLength(2); // the failed one is dropped, not thrown
  });

  it('handles an empty batch', async () => {
    const d = deps();
    expect(await recordAiUsageBatch(d, [])).toEqual([]);
    expect(await recordAiUsageBatch(d)).toEqual([]);
    expect(d.store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('totalCostUsd', () => {
  it('sums what a run actually spent', () => {
    expect(totalCostUsd([{ estimatedCostUsd: 0.1 }, { estimatedCostUsd: 0.25 }])).toBe(0.35);
  });

  it('ignores rows that failed to write or carry no cost', () => {
    expect(totalCostUsd([null, {}, { estimatedCostUsd: 0.5 }])).toBe(0.5);
    expect(totalCostUsd([])).toBe(0);
    expect(totalCostUsd()).toBe(0);
  });

  it('does not accumulate floating-point noise across many rows', () => {
    const rows = Array.from({ length: 3 }, () => ({ estimatedCostUsd: 0.1 }));
    expect(totalCostUsd(rows)).toBe(0.3);
  });
});

describe('one row per call (ADR 0033)', () => {
  it('reuses the id the router recorded, so a caller re-recording with its own source replaces the row', async () => {
    const d = deps();
    const row = await recordAiUsage(d, {
      ...CALL,
      recordedRowId: 'router-row-1',
      source: 'listen-and-learn:script',
    });
    expect(row.id).toBe('router-row-1');
    expect(row.source).toBe('listen-and-learn:script');
    expect(d.store.upsertDoc).toHaveBeenCalledWith(
      USAGE_CONTAINER,
      expect.objectContaining({ id: 'router-row-1' })
    );
  });

  it('mints an id when nothing was recorded before', async () => {
    const row = await recordAiUsage(deps(), { ...CALL, recordedRowId: '' });
    expect(row.id).toBe('fixed-id');
  });

  it('featureSource names the feature, and the unspecified slug when there is none', () => {
    expect(featureSource('inspector')).toBe('ai:inspector');
    expect(featureSource('')).toBe(USAGE_SOURCES.aiUnspecified);
    expect(featureSource(null)).toBe('ai:unspecified');
  });

  it('an unpriced model is written at cost 0 with the flag, whatever the cost table would say', async () => {
    const d = deps({
      ai: { getCostEstimate: vi.fn(() => 0.25), isPriced: vi.fn(() => false) },
    });
    const row = await recordAiUsage(d, {
      ...CALL,
      provider: 'openai',
      model: 'gpt-5-mini',
    });
    expect(row.estimatedCostUsd).toBe(0);
    expect(row.unpriced).toBe(true);
    const explicit = await recordAiUsage(deps(), {
      ...CALL,
      unpriced: true,
      costUsd: 3,
    });
    expect(explicit).toMatchObject({ estimatedCostUsd: 0, unpriced: true });
    const priced = await recordAiUsage(deps(), CALL);
    expect(priced.unpriced).toBeUndefined();
  });
});

describe('confirmed non-token prices', () => {
  it('preserves a caller-supplied per-image cost without a token-table entry', async () => {
    const row = await recordAiUsage(deps({ ai: { isPriced: () => false } }), {
      provider: 'replicate', model: 'google/imagen-4-fast', costUsd: 0.02, source: 'ai:coverArt',
    });
    expect(row).toMatchObject({ estimatedCostUsd: 0.02 });
    expect(row).not.toHaveProperty('unpriced');
  });
});

it('marks unlisted models unpriced even when a media caller provides only getCostEstimate', async () => {
  const d = deps();
  const row = await recordAiUsage(d, { ...CALL, model: 'gemini-unknown-tts' });
  expect(row).toMatchObject({ estimatedCostUsd: 0, unpriced: true });
  expect(d.ai.getCostEstimate).not.toHaveBeenCalled();
});
