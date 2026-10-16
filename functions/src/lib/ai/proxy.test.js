/**
 * aiProxy and testAiProvider (#180).
 *
 * These two are what an administrator uses to find out whether the AI
 * configuration works. Both were 404s while the portal called them, so the
 * Playground and every Test button failed — and the failure looked like a
 * broken page rather than a missing endpoint.
 *
 * The assertions that matter are the ones about what these deliberately do NOT
 * do: they do not fall through the preference order, they are not gated by the
 * feature switches, and they do not return 5xx for a provider that simply is not
 * configured. Each of those would make the tool answer a different question from
 * the one it was asked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAiProxyHandlers,
  testProviderConnection,
  testTaskCandidate,
  TEST_MAX_TOKENS,
  TEST_TIMEOUT_MS,
} from './proxy.js';
import { USAGE_SOURCES } from './usage.js';

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = { requireRole: vi.fn(async () => ({ role: 'editor', error: null })) };
const denyGuard = {
  requireRole: vi.fn(async () => ({ error: { status: 403, body: '{}' } })),
};

const makeRequest = (body) => ({ json: async () => body });

function makeStore(over = {}) {
  const docs = new Map();
  return {
    docs,
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    incrementIf: vi.fn(async (_container, id, { value, conditionValues }) => {
      const doc = docs.get(id);
      if (!doc) {
        const err = new Error('cosmos 404');
        err.code = 404;
        throw err;
      }
      if (conditionValues && typeof conditionValues.limit === 'number' && !(doc.count < conditionValues.limit)) {
        const err = new Error('cosmos 412');
        err.code = 412;
        throw err;
      }
      doc.count += value;
      return doc;
    }),
    createDoc: vi.fn(async (_container, doc) => {
      if (docs.has(doc.id)) {
        const err = new Error('cosmos 409');
        err.code = 409;
        throw err;
      }
      docs.set(doc.id, { ...doc });
      return doc;
    }),
    ...over,
  };
}

const okAi = () => ({
  callProvider: vi.fn(async ({ provider, model }) => ({
    text: 'ok',
    promptTokens: 10,
    completionTokens: 4,
    model: model || `${provider}-default`,
  })),
  getCostEstimate: vi.fn(() => 0.000042),
});

/** Fixed clock so latency is asserted rather than tolerated. */
const fixed = {
  now: () => new Date('2026-08-23T20:00:00.000Z'),
  uuid: () => 'usage-1',
  clock: (() => {
    let t = 1000;
    return () => (t += 250);
  })(),
};

const build = (over = {}) =>
  createAiProxyHandlers({
    guard: allowGuard,
    store: makeStore(),
    ai: okAi(),
    ...fixed,
    ...over,
  });

describe('aiProxy', () => {
  it('returns the text, token counts, a cost and a latency', async () => {
    const response = await build().aiProxy(makeRequest({ provider: 'gemini', prompt: 'hi' }), context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      text: 'ok',
      promptTokens: 10,
      completionTokens: 4,
      estimatedCostUsd: 0.000042,
    });
    expect(body.latencyMs).toBeGreaterThan(0);
  });

  it('records the call in ai_usage, which nothing had written since the port', async () => {
    // The portal's Usage tab reads this container and does its arithmetic
    // client-side on provider / totalTokens / estimatedCostUsd, so a record
    // under other field names totals to zero and looks like no usage at all.
    const store = makeStore();
    await build({ store }).aiProxy(
      makeRequest({ provider: 'gemini', prompt: 'hi', source: 'admin_playground' }),
      context
    );

    expect(store.upsertDoc).toHaveBeenCalledWith(
      'ai_usage',
      expect.objectContaining({
        provider: 'gemini',
        totalTokens: 14,
        estimatedCostUsd: 0.000042,
        source: 'admin_playground',
        timestamp: '2026-08-23T20:00:00.000Z',
      })
    );
  });

  it('calls the NAMED provider and does not fall through the preference order', async () => {
    // callProvider, not generateTextResponse. "Test Anthropic" that quietly
    // succeeds against Gemini answers the wrong question.
    const ai = okAi();
    await build({ ai }).aiProxy(
      makeRequest({ provider: 'anthropic', prompt: 'hi', model: 'claude-haiku-4-5' }),
      context
    );
    expect(ai.callProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-4-5' })
    );
  });

  it('answers 200 with ok:false when the provider fails, not 5xx', async () => {
    // The caller is a Playground that renders the message. An unconfigured
    // provider is an answer, and AI_NOT_CONFIGURED already says what to do.
    const ai = okAi();
    ai.callProvider.mockRejectedValue(
      Object.assign(new Error('openai is not configured'), { code: 'AI_NOT_CONFIGURED' })
    );
    const response = await build({ ai }).aiProxy(
      makeRequest({ provider: 'openai', prompt: 'hi' }),
      context
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      code: 'AI_NOT_CONFIGURED',
    });
  });

  it('does not record usage for a call that never happened', async () => {
    const ai = okAi();
    ai.callProvider.mockRejectedValue(new Error('boom'));
    const store = makeStore();
    await build({ ai, store }).aiProxy(makeRequest({ provider: 'gemini', prompt: 'hi' }), context);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('still returns the answer when recording usage fails', async () => {
    // The model has already answered and already been paid for. Losing the
    // record is better than losing the response.
    const store = makeStore({ upsertDoc: vi.fn(async () => { throw new Error('cosmos down'); }) });
    const response = await build({ store }).aiProxy(
      makeRequest({ provider: 'gemini', prompt: 'hi' }),
      context
    );
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it('400s a missing provider or prompt', async () => {
    for (const body of [{ prompt: 'hi' }, { provider: 'gemini' }, { provider: 'gemini', prompt: '  ' }]) {
      const response = await build().aiProxy(makeRequest(body), context);
      expect(response.status).toBe(400);
    }
  });

  it('rejects an unknown provider with 400', async () => {
    const response = await build().aiProxy(
      makeRequest({ provider: 'unsupported-llm', prompt: 'hi' }),
      context
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      code: 'INVALID_PROVIDER',
    });
  });

  it('rejects an unknown model with 400', async () => {
    const response = await build().aiProxy(
      makeRequest({ provider: 'gemini', model: 'nonexistent-model-v99', prompt: 'hi' }),
      context
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      code: 'INVALID_MODEL',
    });
  });

  it('rejects a retired model in the catalogue with 400', async () => {
    const readCatalog = async () => ({
      providers: {
        gemini: {
          models: {
            'gemini-retired-model': { status: 'retired' },
          },
        },
      },
    });
    const response = await build({ readCatalog }).aiProxy(
      makeRequest({ provider: 'gemini', model: 'gemini-retired-model', prompt: 'hi' }),
      context
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      code: 'RETIRED_MODEL',
    });
  });

  it('rejects an overly long prompt or system prompt with 400', async () => {
    const longText = 'x'.repeat(40_000);
    const res1 = await build().aiProxy(
      makeRequest({ provider: 'gemini', prompt: longText }),
      context
    );
    expect(res1.status).toBe(400);
    expect(JSON.parse(res1.body).code).toBe('PROMPT_TOO_LONG');

    const res2 = await build().aiProxy(
      makeRequest({ provider: 'gemini', prompt: 'hi', systemPrompt: longText }),
      context
    );
    expect(res2.status).toBe(400);
    expect(JSON.parse(res2.body).code).toBe('PROMPT_TOO_LONG');
  });

  it('enforces per-actor daily spend ceiling with 429', async () => {
    const guard = {
      requireRole: vi.fn(async () => ({ user: { oid: 'actor-123' }, role: 'editor', error: null })),
    };
    const store = makeStore();
    const handler = build({ guard, store, actorDailyLimit: 2 });

    const r1 = await handler.aiProxy(makeRequest({ provider: 'gemini', prompt: 'hi' }), context);
    expect(r1.status).toBe(200);

    const r2 = await handler.aiProxy(makeRequest({ provider: 'gemini', prompt: 'hi again' }), context);
    expect(r2.status).toBe(200);

    const r3 = await handler.aiProxy(makeRequest({ provider: 'gemini', prompt: 'exceed limit' }), context);
    expect(r3.status).toBe(429);
    expect(JSON.parse(r3.body)).toMatchObject({
      ok: false,
      code: 'AI_SPEND_LIMIT_EXCEEDED',
    });
  });

  it('enforces global daily spend ceiling with 429', async () => {
    const store = makeStore();
    const handler = build({ store, actorDailyLimit: 10, globalDailyLimit: 1 });

    const r1 = await handler.aiProxy(makeRequest({ provider: 'gemini', prompt: 'hi' }), context);
    expect(r1.status).toBe(200);

    const r2 = await handler.aiProxy(makeRequest({ provider: 'gemini', prompt: 'global exceed' }), context);
    expect(r2.status).toBe(429);
    expect(JSON.parse(r2.body)).toMatchObject({
      ok: false,
      code: 'AI_SPEND_LIMIT_EXCEEDED',
    });
  });

  it('requires a role', async () => {
    const response = await build({ guard: denyGuard }).aiProxy(
      makeRequest({ provider: 'gemini', prompt: 'hi' }),
      context
    );
    expect(response.status).toBe(403);
  });
});

describe('testAiProvider', () => {
  it('asks for a few tokens inside 45 s, so a reasoning model answers the Test in seconds', async () => {
    // #701, 2026-09-29: with the drafting limits the one-word NVIDIA Test took 56-58 s.
    const ai = okAi();
    await build({ ai }).testAiProvider(makeRequest({ providerId: 'nvidia' }), context);
    expect(ai.callProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'nvidia',
        maxTokens: TEST_MAX_TOKENS,
        timeoutMs: TEST_TIMEOUT_MS,
      })
    );
    expect(TEST_MAX_TOKENS).toBeLessThanOrEqual(32);
    // Under the edge's ~100 s request limit, with room for the page's own wait.
    expect(TEST_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('writes the verdict onto the provider document so the badge survives a reload', async () => {
    const store = makeStore();
    const response = await build({ store }).testAiProvider(
      makeRequest({ providerId: 'gemini' }),
      context
    );

    expect(JSON.parse(response.body)).toMatchObject({ ok: true, status: 'connected' });
    expect(store.patchDoc).toHaveBeenCalledWith(
      'ai_providers',
      'gemini',
      expect.objectContaining({
        status: 'connected',
        lastTested: '2026-08-23T20:00:00.000Z',
        lastTestError: null,
        // The button, not the weekly probe (#701): the card says which ran.
        lastTestedBy: 'admin',
      })
    );
  });

  it('records the call as an admin Test in ai_usage, a registered source', async () => {
    const store = makeStore();
    await build({ store }).testAiProvider(makeRequest({ providerId: 'gemini' }), context);
    expect(USAGE_SOURCES.adminTest).toBe('admin_test');
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'ai_usage',
      expect.objectContaining({ provider: 'gemini', source: USAGE_SOURCES.adminTest })
    );
  });

  it('records status "error" AND the message when the provider refuses', async () => {
    // A test button that fails silently is worse than no test button.
    const ai = okAi();
    ai.callProvider.mockRejectedValue(new Error('API key not valid'));
    const store = makeStore();
    const response = await build({ ai, store }).testAiProvider(
      makeRequest({ providerId: 'openai' }),
      context
    );

    expect(JSON.parse(response.body)).toMatchObject({ ok: false, status: 'error' });
    expect(JSON.parse(response.body).error).toBe('The provider call failed');
    expect(store.patchDoc).toHaveBeenCalledWith(
      'ai_providers',
      'openai',
      expect.objectContaining({ status: 'error', lastTestError: 'The provider call failed' })
    );
  });

  it('still reports the result when the status write fails', async () => {
    const store = makeStore({ patchDoc: vi.fn(async () => { throw new Error('cosmos down'); }) });
    const response = await build({ store }).testAiProvider(
      makeRequest({ providerId: 'gemini' }),
      context
    );
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it('400s a missing providerId', async () => {
    const response = await build().testAiProvider(makeRequest({}), context);
    expect(response.status).toBe(400);
  });

  it('rejects an unknown provider with 400', async () => {
    const response = await build().testAiProvider(
      makeRequest({ providerId: 'unsupported-provider' }),
      context
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      code: 'INVALID_PROVIDER',
    });
  });

  it('requires a role', async () => {
    const response = await build({ guard: denyGuard }).testAiProvider(
      makeRequest({ providerId: 'gemini' }),
      context
    );
    expect(response.status).toBe(403);
  });
});

describe('testProviderConnection — the Test with no HTTP, shared with the weekly probe (#701)', () => {
  const deps = (over = {}) => ({
    store: makeStore(),
    ai: okAi(),
    now: fixed.now,
    uuid: fixed.uuid,
    clock: (() => {
      let t = 0;
      return () => (t += 1_200);
    })(),
    ...over,
  });

  it('returns the verdict and writes it, marked as the probe, with its own usage source', async () => {
    const d = deps();
    const outcome = await testProviderConnection(d, { providerId: 'nvidia', trigger: 'probe' });

    expect(outcome).toEqual({ ok: true, status: 'connected', latencyMs: 1_200, model: 'nvidia-default' });
    expect(d.ai.callProvider).toHaveBeenCalledWith({
      provider: 'nvidia',
      model: null,
      prompt: expect.any(String),
      maxTokens: TEST_MAX_TOKENS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    expect(d.store.patchDoc).toHaveBeenCalledWith('ai_providers', 'nvidia', {
      status: 'connected',
      latencyMs: 1_200,
      lastTested: '2026-08-23T20:00:00.000Z',
      lastTestError: null,
      lastTestedBy: 'probe',
    });
    expect(d.store.upsertDoc).toHaveBeenCalledWith(
      'ai_usage',
      expect.objectContaining({ provider: 'nvidia', source: USAGE_SOURCES.aiProviderProbe })
    );
  });

  it('never throws for the provider: a timeout is the result, with its message', async () => {
    const ai = okAi();
    ai.callProvider.mockRejectedValue(
      Object.assign(new Error('timeout after 45000 ms'), { status: 408 })
    );
    const log = { error: vi.fn() };
    const d = deps({ ai, log });
    const outcome = await testProviderConnection(d, { providerId: 'nvidia', trigger: 'probe' });

    expect(outcome).toEqual({
      ok: false,
      status: 'error',
      latencyMs: 1_200,
      error: 'The provider call failed',
      code: null,
    });
    expect(d.store.patchDoc).toHaveBeenCalledWith(
      'ai_providers',
      'nvidia',
      expect.objectContaining({ status: 'error', lastTestError: 'The provider call failed' })
    );
    expect(d.store.upsertDoc).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('probeAiProviders(nvidia) failed:', expect.any(Error));
  });

  it('refuses a trigger it does not know, before calling anything', async () => {
    const d = deps();
    await expect(
      testProviderConnection(d, { providerId: 'gemini', trigger: 'cron' })
    ).rejects.toThrow(/Unknown test trigger: cron/);
    expect(d.ai.callProvider).not.toHaveBeenCalled();
    expect(d.store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('testTaskCandidate — the call half alone, for the Tasks tab’s per-task Test (#859)', () => {
  const deps = (over = {}) => ({
    store: makeStore(),
    ai: okAi(),
    now: fixed.now,
    uuid: fixed.uuid,
    clock: (() => {
      let t = 0;
      return () => (t += 300);
    })(),
    ...over,
  });

  it('sends the Test’s prompt and caps to the named model, records a task-test usage row, and writes nothing on the card', async () => {
    const d = deps();
    const outcome = await testTaskCandidate(d, { providerId: 'openai', model: 'gpt-5-mini' });
    expect(outcome).toEqual({ ok: true, status: 'connected', latencyMs: 300, model: 'gpt-5-mini' });
    expect(d.ai.callProvider).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-5-mini',
      prompt: expect.any(String),
      maxTokens: TEST_MAX_TOKENS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    expect(d.store.upsertDoc).toHaveBeenCalledWith(
      'ai_usage',
      expect.objectContaining({ provider: 'openai', model: 'gpt-5-mini', source: USAGE_SOURCES.aiTaskTest })
    );
    expect(d.store.patchDoc).not.toHaveBeenCalled();
  });

  it('a refusal is the outcome, with the message and code, and still nothing on the card', async () => {
    const ai = okAi();
    ai.callProvider.mockRejectedValueOnce(Object.assign(new Error('model not found'), { code: 'AI_PROVIDER_ERROR' }));
    const log = { error: vi.fn() };
    const d = deps({ ai, log });
    const outcome = await testTaskCandidate(d, { providerId: 'gemini', model: 'gemini-9' });
    expect(outcome).toEqual({
      ok: false,
      status: 'error',
      latencyMs: 300,
      error: 'The provider call failed',
      code: 'AI_PROVIDER_ERROR',
    });
    expect(d.store.patchDoc).not.toHaveBeenCalled();
    expect(d.store.upsertDoc).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('testAiTask(gemini) failed:', expect.any(Error));
  });
});
