/**
 * probeAiProviders (#701, 2026-09-29): the AI Engine's Test on a weekly timer.
 *
 * What matters is that it IS the Test — the same call limits, the same fields
 * on the provider document, a usage row — so the card reads a probe result
 * the way it reads a click, and that a slow provider is recorded rather than
 * failing the run. NVIDIA timing out is the result the probe exists to catch.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAiProviderProbe } from './ai-provider-probe.js';
import { TEST_MAX_TOKENS, TEST_TIMEOUT_MS } from '../ai/proxy.js';
import { USAGE_SOURCES } from '../ai/usage.js';

const NOW = new Date('2026-10-05T06:15:00.000Z');

function makeStore(over = {}) {
  return {
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    ...over,
  };
}

/** Every provider answers after `latency[provider]` ms of the fake clock. */
function makeAi({ providers = ['gemini', 'openai', 'anthropic', 'nvidia'], fail = {} } = {}) {
  const clock = { t: 0 };
  const latency = { gemini: 900, openai: 1_400, anthropic: 1_100, nvidia: 3_200 };
  const inFlight = { count: 0, max: 0 };
  const ai = {
    availableProviders: vi.fn(() => providers),
    callProvider: vi.fn(async ({ provider }) => {
      inFlight.count += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.count);
      await Promise.resolve();
      inFlight.count -= 1;
      if (fail[provider]) {
        clock.t += TEST_TIMEOUT_MS;
        throw fail[provider];
      }
      clock.t += latency[provider];
      return { text: 'ok', promptTokens: 9, completionTokens: 2, model: `${provider}-short` };
    }),
    getCostEstimate: vi.fn((provider) => (provider === 'nvidia' ? 0 : 0.00001)),
  };
  return { ai, clock: () => clock.t, inFlight };
}

const timeout = () => Object.assign(new Error('timeout after 45000 ms'), { status: 408 });

const build = ({ store = makeStore(), ai, clock, log = { error: vi.fn() } }) =>
  createAiProviderProbe({ store, ai, log, now: () => NOW, uuid: () => 'row-1', clock });

describe('probeAiProviders', () => {
  it('runs the Test against every provider with a key, one at a time', async () => {
    const { ai, clock, inFlight } = makeAi();
    await build({ ai, clock }).run();

    expect(ai.callProvider.mock.calls.map(([args]) => args)).toEqual(
      ['gemini', 'openai', 'anthropic', 'nvidia'].map((provider) => ({
        provider,
        model: null,
        prompt: expect.any(String),
        maxTokens: TEST_MAX_TOKENS,
        timeoutMs: TEST_TIMEOUT_MS,
      }))
    );
    expect(inFlight.max).toBe(1);
  });

  it('writes each verdict onto the provider document, as the Test does, marked as the probe', async () => {
    const store = makeStore();
    const { ai, clock } = makeAi();
    await build({ store, ai, clock }).run();

    expect(store.patchDoc).toHaveBeenCalledTimes(4);
    expect(store.patchDoc).toHaveBeenCalledWith('ai_providers', 'nvidia', {
      status: 'connected',
      latencyMs: 3_200,
      lastTested: NOW.toISOString(),
      lastTestError: null,
      lastTestedBy: 'probe',
    });
    expect(store.patchDoc).toHaveBeenCalledWith(
      'ai_providers',
      'gemini',
      expect.objectContaining({ status: 'connected', latencyMs: 900, lastTestedBy: 'probe' })
    );
  });

  it('records usage for each answer, under its own source', async () => {
    const store = makeStore();
    const { ai, clock } = makeAi();
    await build({ store, ai, clock }).run();

    const rows = store.upsertDoc.mock.calls.map(([container, row]) => [container, row]);
    expect(rows).toHaveLength(4);
    for (const [container, row] of rows) {
      expect(container).toBe('ai_usage');
      expect(row).toMatchObject({ source: USAGE_SOURCES.aiProviderProbe, totalTokens: 11 });
    }
    expect(rows.find(([, row]) => row.provider === 'nvidia')[1].estimatedCostUsd).toBe(0);
  });

  it('a timeout is recorded as an error with its message, and the run carries on', async () => {
    const store = makeStore();
    const log = { error: vi.fn() };
    const { ai, clock } = makeAi({ fail: { nvidia: timeout() } });
    const summary = await build({ store, ai, clock, log }).run();

    expect(store.patchDoc).toHaveBeenCalledWith('ai_providers', 'nvidia', {
      status: 'error',
      latencyMs: TEST_TIMEOUT_MS,
      lastTested: NOW.toISOString(),
      lastTestError: 'The provider call failed',
      lastTestedBy: 'probe',
    });
    // No answer, no usage row for it; the three that answered have theirs.
    expect(store.upsertDoc.mock.calls.map(([, row]) => row.provider)).toEqual([
      'gemini',
      'openai',
      'anthropic',
    ]);
    expect(log.error).toHaveBeenCalledWith('probeAiProviders(nvidia) failed:', expect.any(Error));
    expect(summary).toEqual({
      probed: 4,
      connected: 3,
      results: [
        { provider: 'gemini', status: 'connected', latencyMs: 900 },
        { provider: 'openai', status: 'connected', latencyMs: 1_400 },
        { provider: 'anthropic', status: 'connected', latencyMs: 1_100 },
        {
          provider: 'nvidia',
          status: 'error',
          latencyMs: TEST_TIMEOUT_MS,
          error: 'The provider call failed',
        },
      ],
    });
  });

  it('a provider whose document cannot be written still leaves the others probed', async () => {
    const store = makeStore({
      patchDoc: vi.fn(async (_c, id) => {
        if (id === 'gemini') throw new Error('cosmos down');
      }),
    });
    const { ai, clock } = makeAi();
    const summary = await build({ store, ai, clock }).run();
    expect(summary.probed).toBe(4);
    expect(store.patchDoc).toHaveBeenCalledTimes(4);
  });

  it('with no key present, probes nothing and says so', async () => {
    const store = makeStore();
    const { ai, clock } = makeAi({ providers: [] });
    expect(await build({ store, ai, clock }).run()).toEqual({ probed: 0, connected: 0, results: [] });
    expect(ai.callProvider).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('probeAiProviders — the model catalogue step (ADR 0034 slice 2, #857)', () => {
  const probeWith = ({ store = makeStore(), ai, clock, refresh, log = { error: vi.fn() } }) =>
    createAiProviderProbe({
      store,
      ai,
      catalog: { refresh },
      log,
      now: () => NOW,
      uuid: () => 'row-1',
      clock,
    });

  it('refreshes the catalogue after the Tests and reports its summary', async () => {
    const { ai, clock } = makeAi();
    const order = [];
    ai.callProvider.mockImplementation(async () => {
      order.push('test');
      return { text: 'ok', promptTokens: 9, completionTokens: 2, model: 'm' };
    });
    const listed = { gemini: { listed: 3, added: 1, retired: 0, error: null } };
    const refresh = vi.fn(async () => {
      order.push('refresh');
      return { updatedAt: NOW.toISOString(), providers: listed };
    });
    const summary = await probeWith({ ai, clock, refresh }).run();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['test', 'test', 'test', 'test', 'refresh']);
    expect(summary.probed).toBe(4);
    expect(summary.catalog).toEqual({ updatedAt: NOW.toISOString(), providers: listed });
  });

  it('a catalogue that cannot be refreshed is logged and reported; the Tests already written stand', async () => {
    const store = makeStore();
    const log = { error: vi.fn() };
    const { ai, clock } = makeAi();
    const refresh = vi.fn(async () => {
      throw new Error('cosmos down');
    });
    const summary = await probeWith({ store, ai, clock, refresh, log }).run();

    expect(store.patchDoc).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ probed: 4, connected: 4, catalog: { error: 'cosmos down' } });
    expect(log.error).toHaveBeenCalledWith(
      'probeAiProviders catalogue refresh failed:',
      expect.any(Error)
    );
  });

  it('without a catalogue dependency the run is the probe alone, as before', async () => {
    const { ai, clock } = makeAi();
    expect(await build({ ai, clock }).run()).not.toHaveProperty('catalog');
  });
});
