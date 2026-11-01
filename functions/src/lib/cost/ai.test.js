/**
 * The AI section: the usage ledger's month totals, the ElevenLabs credits and
 * the image budget, each degrading on its own.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FOUNDRY_NOTE,
  FREE_NOTE,
  LEDGER_NOTE,
  aggregateUsage,
  imageBudgetFrom,
  monthBounds,
  readAiCosts,
  readCredits,
} from './ai.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const now = () => NOW;

const THIS_MONTH = [
  { provider: 'gemini', source: 'ai:articleDraft', estimatedCostUsd: 0.25, totalTokens: 1000 },
  { provider: 'gemini', source: 'ai:articleDraft', estimatedCostUsd: 0.25, totalTokens: 500 },
  { provider: 'anthropic', source: 'ai:summary', estimatedCostUsd: 0.1, totalTokens: 200 },
  { provider: 'anthropic', source: 'ai:summary', unpriced: true, estimatedCostUsd: 0, totalTokens: 50 },
  { provider: 'replicate', source: 'ai:coverArt', estimatedCostUsd: 0.02 },
  { provider: 'replicate', source: 'ai:coverArt', estimatedCostUsd: 0.02 },
  {},
];
const LAST_MONTH = [{ provider: 'gemini', estimatedCostUsd: 2.1 }];

function usageStore({ fail = false } = {}) {
  return {
    queryDocs: vi.fn(async (container, query, parameters) => {
      if (fail) throw Object.assign(new Error('down'), { code: 503 });
      expect(container).toBe('ai_usage');
      expect(query).not.toContain('SELECT *');
      const since = parameters.find((p) => p.name === '@since').value;
      return since.startsWith('2026-11') ? THIS_MONTH : LAST_MONTH;
    }),
  };
}

describe('aggregateUsage', () => {
  it('totals priced rows, counts unpriced ones, and groups by provider and source', () => {
    const totals = aggregateUsage(THIS_MONTH);
    expect(totals).toMatchObject({ costUsd: 0.64, calls: 7, unpricedCalls: 2, tokens: 1750 });
    expect(totals.byProvider.map((r) => [r.provider, r.costUsd, r.calls])).toEqual([
      ['gemini', 0.5, 2],
      ['anthropic', 0.1, 2],
      ['replicate', 0.04, 2],
      ['unknown', 0, 1],
    ]);
    expect(totals.bySource[0]).toMatchObject({ source: 'ai:articleDraft', costUsd: 0.5, tokens: 1500 });
    expect(totals.bySource.map((r) => r.source)).toContain('ai:unspecified');
    expect(aggregateUsage(null)).toMatchObject({ costUsd: 0, calls: 0, byProvider: [] });
  });

  it('names a month by its first instant and the next month’s', () => {
    expect(monthBounds('2026-12')).toEqual({ since: '2026-12-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z' });
  });
});

describe('imageBudgetFrom', () => {
  it('reads the settings the generators read, with their defaults', () => {
    expect(
      imageBudgetFrom({
        CONTENTFORGE_IMAGE_COST_USD: '0.02',
        CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD: '10',
        CONTENTFORGE_IMAGE_MONTHLY_MAX: '50',
      })
    ).toEqual({ unitCostUsd: 0.02, budget: 10, maxImages: 50 });
    expect(imageBudgetFrom({})).toEqual({ unitCostUsd: null, budget: 10, maxImages: 200 });
    expect(imageBudgetFrom({ CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD: '-1' }).budget).toBe(10);
  });
});

describe('readCredits', () => {
  const answer = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  it('reads nothing without a key', async () => {
    const fetchImpl = vi.fn();
    expect(await readCredits({ env: {}, fetchImpl, now })).toEqual({ configured: false, error: null });
    expect(await readCredits({ env: { ELEVENLABS_API_KEY: '@Microsoft.KeyVault(x)' }, fetchImpl, now })).toEqual({
      configured: false,
      error: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the plan and the credits left', async () => {
    const fetchImpl = vi.fn(async () =>
      answer(200, {
        tier: 'free',
        status: 'free',
        character_count: 3400,
        character_limit: 10000,
        next_character_count_reset_unix: 1795651200,
      })
    );
    const credits = await readCredits({ env: { ELEVENLABS_API_KEY: 'sk_test1234567890' }, fetchImpl, now });
    expect(credits).toMatchObject({ configured: true, plan: 'free', used: 3400, limit: 10000, left: 6600, percentLeft: 66, error: null });
    expect(credits.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says why when the account cannot be read, without the key', async () => {
    const fetchImpl = vi.fn(async () => answer(403, { detail: { code: 'missing_permissions' } }));
    const credits = await readCredits({ env: { ELEVENLABS_API_KEY: 'sk_test1234567890' }, fetchImpl, now });
    expect(credits.configured).toBe(true);
    expect(credits.error).toContain('User → Read');
    expect(credits.error).not.toContain('sk_test');
  });
});

describe('readAiCosts', () => {
  const env = {
    GEMINI_API_KEY: 'g',
    ANTHROPIC_API_KEY: 'a',
    NVIDIA_API_KEY: 'n',
    REPLICATE_API_KEY: 'r',
    ELEVENLABS_API_KEY: 'e',
    CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD: '10',
    CONTENTFORGE_IMAGE_COST_USD: '0.02',
  };
  const credits = async () => ({ configured: true, plan: 'free', used: 1, limit: 10, left: 9, percentLeft: 90, resetAt: null, error: null });

  it('builds every provider card from the ledger and the reads', async () => {
    const { ai, sources } = await readAiCosts({ store: usageStore(), env, now, readCreditsImpl: credits, budgetUsd: 20 });
    expect(ai.monthToDate.costUsd).toBe(0.64);
    expect(ai.previousMonth).toEqual({ costUsd: 2.1, calls: 1 });
    expect(ai.budgetUsd).toBe(20);
    const byId = Object.fromEntries(ai.providers.map((card) => [card.id, card]));
    expect(Object.keys(byId)).toEqual(['foundry', 'elevenlabs', 'replicate', 'gemini', 'anthropic', 'openai', 'nvidia']);
    expect(byId.foundry).toMatchObject({ kind: 'azure-budget', scopeId: 'foundry', configured: true, note: FOUNDRY_NOTE });
    expect(byId.elevenlabs).toMatchObject({ kind: 'credits', left: 9, percentLeft: 90, error: null });
    expect(byId.replicate).toMatchObject({ kind: 'budget', budget: 10, images: 2, unitCostUsd: 0.02, monthToDate: 0.04, percentUsed: 0.4 });
    expect(byId.gemini).toMatchObject({ kind: 'ledger', configured: true, monthToDate: 0.5, calls: 2, note: LEDGER_NOTE });
    expect(byId.openai).toMatchObject({ configured: false, monthToDate: 0, calls: 0 });
    expect(byId.nvidia).toMatchObject({ kind: 'free', note: FREE_NOTE });
    expect(sources.map((s) => [s.id, s.ok])).toEqual([
      ['ai-ledger', true],
      ['elevenlabs', true],
    ]);
  });

  it('keeps the cards when the ledger cannot be read, and says so', async () => {
    const { ai, sources } = await readAiCosts({
      store: usageStore({ fail: true }),
      env: {},
      now,
      readCreditsImpl: async () => ({ configured: false, error: null }),
    });
    expect(ai.monthToDate.calls).toBe(0);
    expect(ai.previousMonth).toBeNull();
    expect(sources[0]).toMatchObject({ id: 'ai-ledger', ok: false, error: expect.stringContaining('503') });
    expect(sources[1]).toMatchObject({ id: 'elevenlabs', ok: true, skipped: expect.any(String) });
    expect(ai.providers.find((c) => c.id === 'elevenlabs')).toMatchObject({ configured: false, left: null });
  });
});
