/**
 * The Tasks tab's two reads of production (ADR 0034 §4, slice 4, #859):
 * the effective read hands the resolver's answer through unchanged, and the
 * per-task Test walks that chain until a candidate answers — never past the
 * policy locks, because the chain is the resolver's.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAdminIntegrationHandlers } from '../admin-integrations.js';
import { createAiRouter } from '../ai/router.js';
import { USAGE_SOURCES } from '../ai/usage.js';
import { TEST_MAX_TOKENS, TEST_TIMEOUT_MS } from '../ai/proxy.js';

const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, role: 'editor', error: null })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};

const makeRequest = ({ params = {}, body } = {}) => ({
  query: { get: () => null },
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    deleteDoc: vi.fn(async () => {}),
    ...over,
  };
}

const fixed = {
  now: () => new Date('2026-10-05T12:00:00.000Z'),
  uuid: () => 'usage-1',
  clock: (() => {
    let t = 1000;
    return () => (t += 250);
  })(),
};

/** A resolver answer with one task, as router.resolveEffectiveSelection shapes it. */
const effectiveOf = (chain, extra = {}) => async () => ({
  tasks: {
    forgeDrafting: {
      label: 'Forge drafting',
      modality: 'text',
      needs: ['text'],
      public: false,
      recommended: null,
      entry: { mode: 'global' },
      mode: 'global',
      chain,
      rejected: [{ provider: 'nvidia', model: null, code: 'no-key', why: 'not available: nvidia holds no key' }],
      flags: [],
      ...extra,
    },
  },
  priority: [],
  availability: { keyed: ['gemini', 'openai'], enabled: ['gemini', 'openai'], disabled: [] },
  updatedAt: null,
});

const handlers = (over = {}) =>
  createAdminIntegrationHandlers({
    guard: allowGuard,
    store: makeStore(),
    ...fixed,
    ...over,
  });

describe('GET cms/ai-routing/effective', () => {
  it('answers the resolver’s answer as it is', async () => {
    const effectiveSelection = effectiveOf([{ provider: 'gemini', model: null, why: 'Priority 1' }]);
    const res = await handlers({ effectiveSelection }).getAiRoutingEffective(makeRequest(), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.tasks.forgeDrafting.chain).toEqual([{ provider: 'gemini', model: null, why: 'Priority 1' }]);
    expect(body.tasks.forgeDrafting.rejected[0].why).toMatch(/holds no key/);
    expect(body.availability.keyed).toEqual(['gemini', 'openai']);
  });

  it('is 503 when the router is not wired, 500 when it fails, 403 below editor', async () => {
    expect((await handlers().getAiRoutingEffective(makeRequest(), context)).status).toBe(503);
    const failing = handlers({ effectiveSelection: async () => { throw new Error('cosmos'); } });
    expect((await failing.getAiRoutingEffective(makeRequest(), context)).status).toBe(500);
    const denied = createAdminIntegrationHandlers({ guard: denyGuard, store: makeStore(), ...fixed });
    expect((await denied.getAiRoutingEffective(makeRequest(), context)).status).toBe(403);
  });
});

describe('POST cms/ai-routing/test/{task}', () => {
  const okFor = (answering) =>
    vi.fn(async ({ provider, model }) => {
      if (provider !== answering) {
        const error = new Error(`${provider} refused`);
        error.code = 'AI_PROVIDER_ERROR';
        throw error;
      }
      return { text: 'ok', promptTokens: 10, completionTokens: 1, model: model || `${provider}-default` };
    });

  it('walks the chain until one answers, says which, and why the ones above did not', async () => {
    const store = makeStore();
    const callProvider = okFor('openai');
    const res = await handlers({
      store,
      effectiveSelection: effectiveOf([
        { provider: 'gemini', model: null, why: 'Priority 1' },
        { provider: 'openai', model: 'gpt-5-mini', why: 'Priority 2' },
        { provider: 'anthropic', model: null, why: 'Priority 3' },
      ]),
      ai: { callProvider, getCostEstimate: () => 0 },
    }).testAiTask(makeRequest({ params: { task: 'forgeDrafting' } }), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.answeredBy).toEqual({ provider: 'openai', model: 'gpt-5-mini', latencyMs: 250 });
    expect(body.skipped).toEqual([
      {
        provider: 'gemini',
        model: null,
        why: 'The provider call failed',
        code: 'AI_PROVIDER_ERROR',
        latencyMs: 250,
      },
    ]);
    // The ones after the answer are not tried.
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(callProvider).toHaveBeenLastCalledWith({
      provider: 'openai',
      model: 'gpt-5-mini',
      prompt: expect.any(String),
      maxTokens: TEST_MAX_TOKENS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    // The resolver's rejections travel with the answer.
    expect(body.rejected[0].provider).toBe('nvidia');
    // One usage row, sourced to the task test; nothing written on the card.
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      source: USAGE_SOURCES.aiTaskTest,
    });
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('is ok:false with every candidate skipped when none answers', async () => {
    const res = await handlers({
      effectiveSelection: effectiveOf([
        { provider: 'gemini', model: null },
        { provider: 'openai', model: null },
      ]),
      ai: { callProvider: okFor('nobody'), getCostEstimate: () => 0 },
    }).testAiTask(makeRequest({ params: { task: 'forgeDrafting' } }), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.answeredBy).toBeNull();
    expect(body.skipped.map((s) => s.provider)).toEqual(['gemini', 'openai']);
    expect(body.error).toMatch(/No candidate/);
  });

  it('is 400 for a task the registry does not list, 503 when the router is not wired, 403 below editor', async () => {
    const wired = handlers({
      effectiveSelection: effectiveOf([]),
      ai: { callProvider: vi.fn(), getCostEstimate: () => 0 },
    });
    const bad = await wired.testAiTask(makeRequest({ params: { task: 'nope' } }), context);
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/Unknown AI task: nope/);
    expect((await handlers().testAiTask(makeRequest({ params: { task: 'forgeDrafting' } }), context)).status).toBe(503);
    const denied = createAdminIntegrationHandlers({ guard: denyGuard, store: makeStore(), ...fixed });
    expect((await denied.testAiTask(makeRequest({ params: { task: 'forgeDrafting' } }), context)).status).toBe(403);
  });

  it('never runs the public explain route against the trial tier, whatever the Priority list says', async () => {
    // The real resolver over a document that puts NVIDIA first for everything.
    const docs = {
      'ai-routing': {
        id: 'ai-routing',
        version: 2,
        global: { priority: [{ provider: 'nvidia', model: null }, { provider: 'gemini', model: null }] },
        tasks: {},
      },
    };
    const store = makeStore({ readDoc: vi.fn(async (_c, id) => docs[id] || null) });
    const router = createAiRouter({
      env: { NVIDIA_API_KEY: 'nv', GEMINI_API_KEY: 'g' },
      log: { warn: vi.fn() },
      store,
    });
    const callProvider = okFor('gemini');
    const res = await handlers({
      store,
      effectiveSelection: router.resolveEffectiveSelection,
      ai: { callProvider, getCostEstimate: () => 0 },
    }).testAiTask(makeRequest({ params: { task: 'pricingExplain' } }), context);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.answeredBy.provider).toBe('gemini');
    expect(callProvider.mock.calls.map((c) => c[0].provider)).toEqual(['gemini']);
    expect(body.rejected).toContainEqual(
      expect.objectContaining({ provider: 'nvidia', code: 'policy', why: 'not eligible: trial tier on a public route' })
    );
    // The same list serves the trial tier first for an owner-only task.
    const owner = await handlers({
      store,
      effectiveSelection: router.resolveEffectiveSelection,
      ai: { callProvider: okFor('nvidia'), getCostEstimate: () => 0 },
    }).testAiTask(makeRequest({ params: { task: 'telegram' } }), context);
    expect(JSON.parse(owner.body).answeredBy.provider).toBe('nvidia');
  });
});
