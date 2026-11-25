/**
 * aiProxy and testAiProvider — the two admin RPCs that call a model directly
 * (#180).
 *
 * Both were listed `notImplemented` in `.azure/api-surface.json` while the AI
 * Engine page called them anyway, so the Playground and every provider's Test
 * button returned 404. Configuring providers worked — #181 wired that — and the
 * two controls for *checking whether the configuration is any good* did not.
 *
 * These are deliberately thin. `router.callProvider()` already does the work:
 * it validates the provider, refuses one whose key is absent, calls it, and
 * reports token counts. What is added here is the part the portal needs and the
 * router has no business knowing — an HTTP shape, a cost figure, a latency, a
 * usage record, and a status written back onto the provider document.
 *
 * NEITHER IS FEATURE-GATED. The AI feature switches (#181) decide whether the
 * SITE may call a model — the inspector, the forge, the Telegram bot. These are
 * an administrator testing their own configuration from the portal, behind the
 * editor role. Gating them would make a switched-off feature impossible to
 * diagnose, which is the opposite of what a test button is for.
 *
 * THEY BYPASS THE PREFERENCE ORDER TOO. `callProvider` takes an explicit
 * provider and does not fall through to the next one, because "test Anthropic"
 * that quietly succeeds against Gemini answers the wrong question.
 *
 * THE TEST HAS A SECOND CALLER (#701, 2026-09-29). `testProviderConnection`
 * below is the Test with no HTTP and no auth, and the weekly
 * `probeAiProviders` timer (lib/timers/ai-provider-probe.js) runs it too.
 * Both write the same fields onto the provider document, so the card reads a
 * probe result exactly as it reads a click; `lastTestedBy` says which it was.
 * A third caller, the Tasks tab's per-task Test (ADR 0034 slice 4, #859),
 * runs only the call half (`testTaskCandidate`) down a task's chain and
 * writes nothing onto the cards.
 */

import { recordAiUsage, USAGE_SOURCES } from './usage.js';
import { takeDailyCap } from '../daily-cap.js';
import { readModelCatalog } from './model-catalog-doc.js';
import { CACHE_CONTAINER, utcDay } from '../cloud-tools/history.js';
import { errorFacts } from '../http/error-response.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const PROVIDERS_CONTAINER = 'ai_providers';

export const AI_PROXY_ACTOR_DAILY_LIMIT = 50;
export const AI_PROXY_GLOBAL_DAILY_LIMIT = 500;
export const AI_PROXY_MAX_PROMPT_CHARS = 32_768;
export const AI_PROXY_DEFAULT_MAX_TOKENS = 4096;

/** A short, cheap prompt. The answer does not matter; reaching the model does. */
const TEST_PROMPT = 'Reply with the single word: ok';

/**
 * Limits for the Test, which asks "does this provider answer", not "can it
 * finish a thought". NVIDIA's models are reasoning models on a trial tier:
 * with the drafting limits (8192 tokens, 120 s) the one-word Test took 56-58 s
 * on 2026-09-29, and a slower one outruns the edge's ~100 s request limit
 * and never reports at all. A handful of tokens proves the model answers; 45 s
 * turns a stuck provider into a named timeout inside the page's wait.
 */
export const TEST_MAX_TOKENS = 16;
export const TEST_TIMEOUT_MS = 45_000;

/**
 * Who ran a Test: the usage row's `source`, and the name its log lines carry.
 * The key is written onto the provider document as `lastTestedBy`.
 */
const TEST_TRIGGERS = Object.freeze({
  admin: Object.freeze({ source: USAGE_SOURCES.adminTest, label: 'testAiProvider' }),
  probe: Object.freeze({ source: USAGE_SOURCES.aiProviderProbe, label: 'probeAiProviders' }),
});

/**
 * The call half of the Test: one short prompt to one named provider and
 * model, timed, with a usage row under `source` when it answers. Never
 * throws for the provider — a refusal or a timeout is the `ok: false`
 * outcome with the message. Writes nothing onto the provider document; the
 * two callers below decide that.
 */
async function runTestCall(
  { store, ai, now = () => new Date(), uuid = () => crypto.randomUUID(), clock = () => Date.now(), log = null },
  { providerId, model, source, label }
) {
  const startedAt = clock();
  try {
    const result = await ai.callProvider({
      provider: providerId,
      model,
      prompt: TEST_PROMPT,
      maxTokens: TEST_MAX_TOKENS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const outcome = {
      ok: true,
      status: 'connected',
      latencyMs: clock() - startedAt,
      model: result.model,
    };
    await recordAiUsage(
      { store, ai, uuid, now },
      {
        provider: providerId,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        source,
      }
    );
    return outcome;
  } catch (error) {
    log?.error?.(`${label}(${providerId}) failed:`, errorFacts(error));
    return {
      ok: false,
      status: 'error',
      latencyMs: clock() - startedAt,
      error: 'The provider call failed',
      code: error?.code || null,
    };
  }
}

/**
 * One candidate of a task's chain, tried with the Test's prompt and caps
 * (ADR 0034 §4, slice 4, #859): the Tasks tab's per-task Test walks the
 * effective chain with this until one answers. The usage row's source is
 * `ai-engine:task-test`; the provider document is NOT written, because a
 * model named in a chain that the provider refuses is the chain's fault,
 * not a verdict on the provider's key.
 *
 * @param {Parameters<typeof testProviderConnection>[0]} deps
 * @param {{ providerId: string, model?: string|null }} candidate
 */
export function testTaskCandidate(deps, { providerId, model = null }) {
  return runTestCall(deps, {
    providerId,
    model,
    source: USAGE_SOURCES.aiTaskTest,
    label: 'testAiTask',
  });
}

/**
 * The Test itself: one short call to one named provider, a usage row, and the
 * verdict written onto its `ai_providers` document. No HTTP and no auth, so
 * the Test button and the weekly probe run the same code.
 *
 * It never throws for the provider. A refusal or a timeout is the result,
 * returned as `ok: false` with the message, and written onto the document so
 * the card can show it. The two writes are best-effort: a provider that
 * answered still answered, even if recording that fact failed.
 *
 * @param {object} deps
 * @param {{ upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {{ callProvider: Function, getCostEstimate: Function }} deps.ai
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => number} [deps.clock] monotonic-ish source for latency
 * @param {{ error?: Function }} [deps.log]
 * @param {object} test
 * @param {string} test.providerId
 * @param {string|null} [test.model] null uses the provider's default for a short call
 * @param {'admin'|'probe'} [test.trigger]
 * @returns {Promise<{ok: boolean, status: 'connected'|'error', latencyMs: number,
 *   model?: string, error?: string, code?: string|null}>}
 */
export async function testProviderConnection(deps, { providerId, model = null, trigger = 'admin' }) {
  const { source, label } = TEST_TRIGGERS[trigger] || {};
  if (!source) throw new TypeError(`Unknown test trigger: ${trigger}`);
  const { store, now = () => new Date(), log = null } = deps;

  const outcome = await runTestCall(deps, { providerId, model, source, label });

  try {
    await store.patchDoc(PROVIDERS_CONTAINER, providerId, {
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      lastTested: now().toISOString(),
      lastTestError: outcome.error || null,
      lastTestedBy: trigger,
    });
  } catch (error) {
    log?.error?.(`${label}(${providerId}) could not save status:`, errorFacts(error));
  }

  return outcome;
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function, incrementIf?: Function, createDoc?: Function }} deps.store
 * @param {{ callProvider: Function, getCostEstimate: Function }} deps.ai
 * @param {Function} [deps.readCatalog]
 * @param {Function} [deps.takeDailyCap]
 * @param {number} [deps.actorDailyLimit]
 * @param {number} [deps.globalDailyLimit]
 * @param {number} [deps.maxPromptChars]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => number} [deps.clock] monotonic-ish source for latency
 */
export function createAiProxyHandlers({
  guard,
  store,
  ai,
  readCatalog = ({ store, now }) => readModelCatalog({ store, now }),
  takeDailyCap: capChecker = takeDailyCap,
  actorDailyLimit = AI_PROXY_ACTOR_DAILY_LIMIT,
  globalDailyLimit = AI_PROXY_GLOBAL_DAILY_LIMIT,
  maxPromptChars = AI_PROXY_MAX_PROMPT_CHARS,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  clock = () => Date.now(),
}) {
  const deps = {
    guard,
    store,
    ai,
    readCatalog,
    capChecker,
    actorDailyLimit,
    globalDailyLimit,
    maxPromptChars,
    now,
    uuid,
    clock,
  };
  return {
    /** POST /api/aiProxy — one call to one named provider (#944, AP-B9). */
    aiProxy: (request, context) => aiProxy(deps, request, context),

    /**
     * POST /api/testAiProvider — can we reach this provider right now?
     *
     * Writes the verdict back onto the provider document so the portal's status
     * badge survives a reload, which is what the page's `status`/`lastTested`
     * fields have always expected and nothing has ever set. The work is
     * `testProviderConnection`; this adds the role check and the HTTP shape.
     */
    testAiProvider: (request, context) => testAiProvider(deps, request, context),
  };
}

/**
 * Record what a call cost.
 *
 * The row shape lives in ai/usage.js, shared with the Listen & Learn run
 * since that became the second thing here that spends money on a model. The
 * portal's Usage tab does its arithmetic client-side over whatever rows it
 * finds — totalling `totalTokens` and `estimatedCostUsd`, grouping by
 * `provider` — so a second writer with a slightly different shape would not
 * error, it would silently total zero.
 *
 * A failure there must not fail the call: the model has already answered and
 * been paid for, and losing the record is better than losing the answer.
 */
const recordUsage = ({ store, ai, uuid, now }, record) => recordAiUsage({ store, ai, uuid, now }, record);

/** The 400 for a request without a provider or prompt, or with a prompt past the cap; null when it passes. */
function promptRefusal({ provider, prompt, systemPrompt }, maxPromptChars) {
  if (!provider) return json(400, { ok: false, error: 'provider is required' });
  if (!prompt.trim()) return json(400, { ok: false, error: 'prompt is required' });
  const tooLong = [
    [prompt, 'Prompt'],
    [systemPrompt, 'System prompt'],
  ].find(([text]) => text.length > maxPromptChars);
  if (!tooLong) return null;
  return json(400, {
    ok: false,
    error: `${tooLong[1]} exceeds maximum allowed length of ${maxPromptChars} characters`,
    code: 'PROMPT_TOO_LONG',
  });
}

/** The provider is in the catalogue: the 400 when it is not, or null. */
function providerRefusal(catalog, provider) {
  if (catalog?.providers && Object.hasOwn(catalog.providers, provider)) return null;
  return json(400, {
    ok: false,
    error: `Unknown or unsupported provider: ${provider}`,
    code: 'INVALID_PROVIDER',
  });
}

/**
 * The model the call names, checked against the provider's catalogue entry:
 * `{ targetModel }` (null for the provider's default), or `{ response }`
 * with the 400 for an empty, unknown or retired model.
 */
function catalogModel(providerEntry, provider, rawModel) {
  if (rawModel === undefined || rawModel === null) return { targetModel: null };
  const modelStr = String(rawModel).trim();
  if (!modelStr) {
    return {
      response: json(400, {
        ok: false,
        error: 'model cannot be empty when specified',
        code: 'INVALID_MODEL',
      }),
    };
  }
  if (!providerEntry.models || !Object.hasOwn(providerEntry.models, modelStr)) {
    return {
      response: json(400, {
        ok: false,
        error: `Unknown model "${modelStr}" for provider "${provider}"`,
        code: 'INVALID_MODEL',
      }),
    };
  }
  if (providerEntry.models[modelStr].status === 'retired') {
    return {
      response: json(400, {
        ok: false,
        error: `Model "${modelStr}" on ${provider} is retired in the catalogue`,
        code: 'RETIRED_MODEL',
      }),
    };
  }
  return { targetModel: modelStr };
}

/**
 * Spend ceiling: per-actor and global daily caps, taken BEFORE the provider
 * is called (#944, AP-B9). The 429 when either is spent, or null.
 */
async function spendRefusal({ store, now, capChecker, actorDailyLimit, globalDailyLimit }, user) {
  const actorId = user?.oid || user?.sub || user?.email || 'editor';
  const nowIso = new Date(now()).toISOString();
  const day = utcDay(nowIso);

  const actorCapId = `ai-proxy-actor:${actorId}:${day}`;
  const actorAllowed = await capChecker(store, {
    container: CACHE_CONTAINER,
    id: actorCapId,
    kind: 'ai-proxy-actor-cap',
    day,
    nowIso,
    limit: actorDailyLimit,
    ttlSeconds: 2 * 24 * 60 * 60,
  });
  if (!actorAllowed) {
    return json(429, {
      ok: false,
      error: `Daily AI spend ceiling reached for actor ${actorId}. Try again tomorrow UTC.`,
      code: 'AI_SPEND_LIMIT_EXCEEDED',
    });
  }

  const globalCapId = `ai-proxy-global:${day}`;
  const globalAllowed = await capChecker(store, {
    container: CACHE_CONTAINER,
    id: globalCapId,
    kind: 'ai-proxy-global-cap',
    day,
    nowIso,
    limit: globalDailyLimit,
    ttlSeconds: 2 * 24 * 60 * 60,
  });
  if (globalAllowed) return null;
  // Release the actor reservation when the global cap denies the request
  if (typeof store.incrementIf === 'function') {
    await store.incrementIf(CACHE_CONTAINER, actorCapId, {
      path: '/count',
      value: -1,
      condition: 'FROM c WHERE c.count > 0',
    });
  }
  return json(429, {
    ok: false,
    error: 'Global daily AI spend ceiling reached. Try again tomorrow UTC.',
    code: 'AI_SPEND_LIMIT_EXCEEDED',
  });
}

/**
 * Everything before the provider is called: the role, the prompt, the
 * catalogue and the spend caps. `{ request fields, targetModel }`, or
 * `{ response }` refusing.
 */
async function prepareProxyCall(deps, request) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return { response: auth.error };

  const body = await request.json().catch(() => null);
  const checked = await checkProxyBody(deps, body);
  if (checked.response) return checked;

  const refusedSpend = await spendRefusal(deps, auth.user);
  if (refusedSpend) return { response: refusedSpend };
  return checked;
}

/**
 * The body's provider, prompts and model, checked against the caps and the
 * catalogue: `{ provider, prompt, systemPrompt, body, targetModel }`, or
 * `{ response }` with the 400.
 */
async function checkProxyBody(deps, body) {
  const fields = {
    provider: String(body?.provider || '').trim(),
    prompt: String(body?.prompt || ''),
    systemPrompt: String(body?.systemPrompt || ''),
  };
  const refusedPrompt = promptRefusal(fields, deps.maxPromptChars);
  if (refusedPrompt) return { response: refusedPrompt };

  // Catalog validation: validate provider and model against the catalogue (#944, AP-B9)
  const catalog = await deps.readCatalog({ store: deps.store, now: deps.now });
  const refusedProvider = providerRefusal(catalog, fields.provider);
  if (refusedProvider) return { response: refusedProvider };
  const model = catalogModel(catalog.providers[fields.provider], fields.provider, body?.model);
  return model.response ? model : { ...fields, body, targetModel: model.targetModel };
}

/** POST /api/aiProxy — one call to one named provider (#944, AP-B9). */
async function aiProxy(deps, request, context) {
  const prepared = await prepareProxyCall(deps, request);
  if (prepared.response) return prepared.response;
  const { provider, prompt, systemPrompt, body, targetModel } = prepared;
  const { ai, clock } = deps;

  const startedAt = clock();
  try {
    const result = await ai.callProvider({
      provider,
      model: targetModel,
      prompt,
      systemPrompt,
      maxTokens: Math.min(Number(body?.maxTokens) || AI_PROXY_DEFAULT_MAX_TOKENS, AI_PROXY_DEFAULT_MAX_TOKENS),
    });
    const latencyMs = clock() - startedAt;

    await recordUsage(deps, {
      provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      source: body?.source,
    });

    return json(200, {
      ok: true,
      text: result.text,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      estimatedCostUsd: ai.getCostEstimate(
        provider,
        result.model,
        result.promptTokens,
        result.completionTokens
      ),
      latencyMs,
    });
  } catch (error) {
    // 200 with ok:false, not 5xx. The caller is a Playground that renders
    // the message; an unconfigured provider is an answer, not a fault, and
    // AI_NOT_CONFIGURED already says exactly what to do about it.
    context.error?.('aiProxy failed:', errorFacts(error));
    return json(200, {
      ok: false,
      error: 'The provider call failed',
      code: error?.code || null,
      latencyMs: clock() - startedAt,
    });
  }
}

/** POST /api/testAiProvider — the role check and the HTTP shape around testProviderConnection. */
async function testAiProvider({ guard, store, ai, readCatalog, now, uuid, clock }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const providerId = String(body?.providerId || '').trim();
  if (!providerId) return json(400, { ok: false, error: 'providerId is required' });

  const catalog = await readCatalog({ store, now });
  const refused = providerRefusal(catalog, providerId);
  if (refused) return refused;

  const outcome = await testProviderConnection(
    { store, ai, now, uuid, clock, log: context },
    { providerId, model: body?.model || null, trigger: 'admin' }
  );
  return json(200, outcome);
}
