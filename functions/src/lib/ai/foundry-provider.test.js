/**
 * The Microsoft Foundry provider (#849), end to end through the router.
 *
 * Kept apart from router.test.js because every assertion here is about the
 * ways this provider is deliberately DIFFERENT from the other four: made
 * available by an endpoint rather than a key, authenticated with an Entra
 * token the router fetches and caches (or a developer's local api-key),
 * placed first for content features and locked off the public route, and
 * priced at the Global Standard rates. No test reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAiRouter,
  createFoundryTokenProvider,
  getCostEstimate,
  DEFAULT_MODEL_TABLE,
  FOUNDRY_TOKEN_SCOPE,
  foundryBaseUrl,
} from './router.js';
import { PER_FEATURE_PROVIDERS, PROVIDER_PLACEMENT_DEFAULTS, placementFor } from './ai-config.js';

const quiet = { warn: vi.fn() };
const noSleep = vi.fn(async () => {});

const ENDPOINT = 'https://ais-test.openai.azure.com';
const KEYS = {
  GEMINI_API_KEY: 'g',
  OPENAI_API_KEY: 'o',
  ANTHROPIC_API_KEY: 'a',
  FOUNDRY_ENDPOINT: `${ENDPOINT}/`,
};

const HOSTS = {
  'generativelanguage.googleapis.com': 'gemini',
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'ais-test.openai.azure.com': 'foundry',
};

const ANSWER = JSON.stringify({
  content: [{ type: 'text', text: '{}' }],
  choices: [{ message: { content: '{}' } }],
  candidates: [{ content: { parts: [{ text: '{}' }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

/** A fetch that answers everyone and records who was called with what. */
function fetchRecording() {
  const calls = [];
  const impl = vi.fn(async (url, init) => {
    calls.push({ provider: HOSTS[new URL(url).host], url, init });
    return { ok: true, status: 200, text: async () => ANSWER };
  });
  impl.calls = calls;
  impl.providers = () => calls.map((c) => c.provider);
  return impl;
}

const token = (value, expiresInMs) => ({ token: value, expiresOnTimestamp: Date.now() + expiresInMs });

function router(fetchImpl, { env = KEYS, getToken = async () => token('tok-1', 3_600_000), store = null } = {}) {
  return createAiRouter({ env, fetch: fetchImpl, sleep: noSleep, log: quiet, getToken, store });
}

describe('availability', () => {
  it('is available when FOUNDRY_ENDPOINT is set, and absent without it', () => {
    expect(router(fetchRecording()).availableProviders()).toContain('foundry');
    const { FOUNDRY_ENDPOINT: _omit, ...without } = KEYS;
    expect(router(fetchRecording(), { env: without }).availableProviders()).not.toContain('foundry');
  });

  it('reads the base URL without a trailing slash, and as empty for an unresolved reference', () => {
    expect(foundryBaseUrl(KEYS)).toBe(ENDPOINT);
    expect(foundryBaseUrl({ FOUNDRY_ENDPOINT: '@Microsoft.KeyVault(SecretUri=x)' })).toBe('');
  });
});

describe('the request', () => {
  it('posts to the v1 chat endpoint with the deployment name as model and an Entra bearer', async () => {
    const fetchImpl = fetchRecording();
    const out = await router(fetchImpl).callProvider({ provider: 'foundry', prompt: 'ping' });
    expect(out).toMatchObject({ text: '{}', promptTokens: 100, completionTokens: 20 });
    const [call] = fetchImpl.calls;
    expect(call.url).toBe(`${ENDPOINT}/openai/v1/chat/completions`);
    expect(call.init.headers.Authorization).toBe('Bearer tok-1');
    expect(call.init.headers['api-key']).toBeUndefined();
    const body = JSON.parse(call.init.body);
    expect(body.model).toBe('gpt-5-nano');
    // Reasoning models refuse both fields; the row sends neither, like OpenAI's.
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it("sends no temperature on OpenAI's row either: the same GPT-5 defaults refuse any value but 1", async () => {
    const fetchImpl = fetchRecording();
    await router(fetchImpl).callProvider({ provider: 'openai', prompt: 'ping' });
    const [call] = fetchImpl.calls;
    expect(call.provider).toBe('openai');
    expect(JSON.parse(call.init.body)).not.toHaveProperty('temperature');
  });

  it('asks for response_format json_object on a JSON generation', async () => {
    const fetchImpl = fetchRecording();
    await router(fetchImpl).generateJsonResponse({ prompt: 'x', feature: 'inspector' });
    const call = fetchImpl.calls.find((c) => c.provider === 'foundry');
    expect(JSON.parse(call.init.body).response_format).toEqual({ type: 'json_object' });
  });

  it('sends a developer api-key header instead of a token when FOUNDRY_API_KEY is set locally', async () => {
    const fetchImpl = fetchRecording();
    const getToken = vi.fn();
    await router(fetchImpl, { env: { ...KEYS, FOUNDRY_API_KEY: 'local-key' }, getToken }).callProvider({
      provider: 'foundry',
      prompt: 'ping',
    });
    expect(fetchImpl.calls[0].init.headers['api-key']).toBe('local-key');
    expect(fetchImpl.calls[0].init.headers.Authorization).toBeUndefined();
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe('a rejection', () => {
  it('reports no key verdict: a 401 or 403 is a missing role, and there is no API-keys row for it', async () => {
    const onKeyVerdict = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'no role' } }),
    }));
    const r = createAiRouter({
      env: KEYS,
      fetch: fetchImpl,
      sleep: noSleep,
      log: quiet,
      getToken: async () => token('tok-1', 3_600_000),
      onKeyVerdict,
    });
    await expect(r.callProvider({ provider: 'foundry', prompt: 'ping' })).rejects.toMatchObject({
      status: 403,
    });
    expect(onKeyVerdict).not.toHaveBeenCalled();
  });
});

describe('the token', () => {
  it('is fetched for the Foundry audience and reused until five minutes before expiry', async () => {
    let now = 1_000_000;
    const getToken = vi.fn(async () => ({ token: `t${getToken.mock.calls.length}`, expiresOnTimestamp: now + 20 * 60_000 }));
    const provider = createFoundryTokenProvider({ getToken, now: () => now });
    expect(await provider()).toBe('t1');
    expect(getToken).toHaveBeenCalledWith(FOUNDRY_TOKEN_SCOPE);
    now += 10 * 60_000;
    expect(await provider()).toBe('t1');
    now += 6 * 60_000;
    expect(await provider()).toBe('t2');
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});

describe('the audience', () => {
  it('is ai.azure.com by default and FOUNDRY_TOKEN_SCOPE when the environment sets one', async () => {
    const { foundryTokenScope } = await import('./router.js');
    expect(foundryTokenScope({})).toBe('https://ai.azure.com/.default');
    expect(foundryTokenScope({ FOUNDRY_TOKEN_SCOPE: 'https://cognitiveservices.azure.com/.default' })).toBe(
      'https://cognitiveservices.azure.com/.default'
    );
    const getToken = vi.fn(async () => token('t', 3_600_000));
    await router(fetchRecording(), {
      env: { ...KEYS, FOUNDRY_TOKEN_SCOPE: 'https://cognitiveservices.azure.com/.default' },
      getToken,
    }).callProvider({ provider: 'foundry', prompt: 'ping' });
    expect(getToken).toHaveBeenCalledWith('https://cognitiveservices.azure.com/.default');
  });
});

describe('placement', () => {
  it('is a per-feature provider: first for content features, locked off the public route and grounding', () => {
    expect(PER_FEATURE_PROVIDERS).toContain('foundry');
    for (const feature of ['forgeDrafting', 'forgeGrading', 'inspector', 'altText', 'podcastScript']) {
      expect(PROVIDER_PLACEMENT_DEFAULTS.foundry[feature], feature).toBe('first');
    }
    for (const feature of ['pricingExplain', 'landingZoneExplain', 'sourceGrounding']) {
      expect(placementFor({ placement: { foundry: { [feature]: 'first' } } }, 'foundry', feature)).toBe(
        'off'
      );
    }
  });

  it('serves a content feature before the paid providers above it, and never the public explain route', async () => {
    const fetchImpl = fetchRecording();
    const r = router(fetchImpl);
    await r.generateTextResponse({ prompt: 'x', feature: 'forgeDrafting', purpose: 'draft' });
    expect(fetchImpl.providers()).toEqual(['foundry']);
    expect(JSON.parse(fetchImpl.calls[0].init.body).model).toBe('gpt-5-mini');

    const chain = await r.resolveProviderChain('pricingExplain');
    expect(chain.map((c) => c.provider)).not.toContain('foundry');
  });
});

describe('models and cost', () => {
  it('defaults to mini for drafts and analysis and nano for general calls', () => {
    expect(DEFAULT_MODEL_TABLE.foundry.draft[1]).toBe('gpt-5-mini');
    expect(DEFAULT_MODEL_TABLE.foundry.analysis[1]).toBe('gpt-5-mini');
    expect(DEFAULT_MODEL_TABLE.foundry.general[1]).toBe('gpt-5-nano');
  });

  it('prices at the Global Standard rates read on 2026-10-04', () => {
    expect(getCostEstimate('foundry', 'gpt-5-nano', 1_000_000, 1_000_000)).toBeCloseTo(0.45, 6);
    expect(getCostEstimate('foundry', 'gpt-5-mini', 1_000_000, 1_000_000)).toBeCloseTo(2.25, 6);
    // A deployment without a confirmed model rate is unpriced.
    expect(getCostEstimate('foundry', 'something-new', 1_000_000, 0)).toBe(0);
  });
});
