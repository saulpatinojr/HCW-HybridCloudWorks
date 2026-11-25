/**
 * router.js — one door to the text models, for every AI handler (T-322 §4.4).
 *
 * Ported from Site-Main `lib/ai-model-router.js` (088f458). A key makes a
 * provider POSSIBLE: seed `GEMINI_API_KEY`, `OPENAI_API_KEY` or
 * `ANTHROPIC_API_KEY` and that provider becomes available; seed none and every
 * AI handler fails with `AI_NOT_CONFIGURED` — a plain sentence, not a stack
 * trace.
 *
 * Since 2026-08-23 a key is necessary but no longer sufficient. The admin
 * portal's AI Engine page decides which of the available providers are actually
 * used, in what order, and which parts of the site may call one at all. That
 * configuration is read by `ai-config.js`, which also carries the rules for
 * what happens when it disagrees with reality — read its header before changing
 * anything here. In short: configuration can disable and reorder, never enable;
 * an unreadable configuration changes nothing.
 *
 * Default order is Gemini, OpenAI, Anthropic, and the order now FAILS OVER: a
 * provider that cannot serve a call (rejected key, unknown model, dead endpoint)
 * hands on to the next one rather than failing the call. A bad request does not
 * fail over, because it would fail identically everywhere. `callWithFailover`
 * carries the reasoning. `CONTENTFORGE_AI_PROVIDER` still pins one outright —
 * and a pin does NOT fall through, because it is an instruction rather than a
 * preference.
 *
 * What is gone from upstream and why:
 *   - Vertex. It authenticates with Application Default Credentials — a GCP
 *     identity the Function App cannot hold. Gemini is reached through the
 *     public Gemini API with an API key instead (same model names).
 *   - Azure OpenAI. Retired with the account (Migration-Plan note).
 *   - axios. `fetch` is global on Node 24 (and has been since 18); one less dependency.
 *
 * What is kept: the purpose → model table (env-overridable per provider), JSON
 * sanitising with a repair round trip, retry on 408/429/5xx, per-call usage
 * capture with cost estimates, the Anthropic prompt-cache marker.
 *
 * ONE DOOR, TWO GEMINI ENDPOINTS (#433, 2026-09-09). Everything above goes
 * through each provider's chat endpoint — for Gemini, `models/{m}:generateContent`
 * — and fails over along the chain. `generateGroundedJsonResponse` is the one
 * exception: it grounds a generation on owner-supplied web pages and YouTube
 * videos, and Google accepts a YouTube URL ONLY through its Interactions API
 * (`/v1beta/interactions`), which is also where the `url_context` tool lives.
 * That endpoint is not new to this repository — `listen-and-learn/speech/gemini.js`
 * has rendered dialogue through it since 2026-08-24 — so it is the same door the
 * speech side uses, not a second client. What goes through it: a grounded call,
 * and nothing else. What does not: every existing call site, the JSON repair
 * round trip, `callProvider`. And a grounded call does not fail over, because
 * only Gemini can read either source and the next provider down would answer,
 * successfully, from the prompt alone. The provider chain is still resolved
 * exactly as for every other call — portal order, disabled providers, the
 * `CONTENTFORGE_AI_PROVIDER` pin — and Gemini has to be in it; if it is not,
 * the call says why and stops.
 *
 * Interactions contract, verified against https://ai.google.dev/api/interactions-api,
 * https://ai.google.dev/gemini-api/docs/url-context and
 * https://ai.google.dev/gemini-api/docs/video-understanding on 2026-09-09:
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   x-goog-api-key: <key>
 *   { model,
 *     input: [ {type:'text', text}, {type:'video', uri:'https://www.youtube.com/watch?v=…'} ],
 *     tools: [ {type:'url_context'} ],
 *     system_instruction: '<plain string>',
 *     response_format: { type:'text', mime_type:'application/json', schema? } }
 *
 *   response: { status: 'completed'|'failed'|'incomplete'|'in_progress'|
 *                       'requires_action'|'cancelled'|'budget_exceeded'|'queued',
 *               steps: [ {type:'model_output', content:[{type:'text', text}]},
 *                        {type:'url_context_result', result:[{status, url}]} ],
 *               usage: { total_input_tokens, total_output_tokens,
 *                        total_thought_tokens, total_tool_use_tokens, … },
 *               errors: [{code, message}] }
 *
 *   `generation_config` has NO `temperature` (its fields are max_output_tokens,
 *   seed, stop_sequences, thinking_level, tool_choice and the media configs),
 *   so the 0.2 the chat endpoints use cannot be set here and is not. YouTube:
 *   public videos only, at most 10 per request on 2.5+ models. url_context: at
 *   most 20 URLs per request; YouTube and paywalled pages are not readable
 *   through it, and each retrieval reports `success|error|paywall|unsafe`.
 *   `total_tool_use_tokens` is "tokens present in tool-use prompt(s)", i.e. the
 *   fetched pages, so it is counted as INPUT; thought tokens as output, as on
 *   the chat endpoint. Whether `total_output_tokens` already includes thoughts
 *   is not stated on the reference page — if it does, the output count here
 *   over-reads by that amount.
 *
 * NVIDIA API CATALOG (#701, 2026-09-25). A fourth provider, `nvidia`, on the
 * OpenAI-compatible chat endpoint at https://integrate.api.nvidia.com/v1 with
 * `NVIDIA_API_KEY` as a Bearer token. It is a trial tier — free, about 40
 * requests a minute per account, trial terms — so it differs from the other
 * three in four deliberate ways:
 *
 *   - Its place in the chain is set PER FEATURE (ai-config.js,
 *     PER_FEATURE_PROVIDERS): for owner-triggered content it is the backup,
 *     after the paid providers, unless an administrator places it first for
 *     a feature (owner decision 2026-09-29; it was first by default from
 *     2026-09-25 until then). It is never used for the anonymous public
 *     explain route, and a call with no feature never uses it.
 *   - A pacing guard keeps this instance under the account limit. A call the
 *     guard refuses is not sent and fails over at once, so a burst of batch
 *     drafts degrades to the paid providers instead of failing.
 *   - A 400/422 from it fails over. "A bad request fails identically
 *     everywhere" holds for three frontier APIs; it does not hold for a
 *     catalogue of open-weight models with their own context and parameter
 *     limits, where the next provider will very likely take the same request.
 *     A part WE refused (AI_PART_REFUSED) still does not fail over.
 *   - Its usage rows are priced at zero, so the Usage tab shows the calls and
 *     the saving rather than an invented figure.
 *
 * SYNCHRONOUS CALLS HAVE A TIME BUDGET (2026-09-29). A route that answers a
 * browser holds the request open while the model works. The request dies at
 * the client's timeout (frontend lib/api.js: 90 s for a draft, 20 s by
 * default) or at the edge's ~100 s, whichever comes first. On 2026-09-29
 * NVIDIA's reasoning models took 56-58 s to reply with one word, and an
 * NVIDIA attempt may run 120 s. With NVIDIA first for drafting, the failover
 * to a paid provider started after nobody was listening. `budgetMs` on
 * generateTextResponse and generateJsonResponse is the fix. The arithmetic is
 * in time-budget.js; the contract is here:
 *
 *   - The clock starts when the call is made. It covers the configuration
 *     read, every provider, every retry and the JSON repair round trip.
 *   - Half of the budget is the failover reserve. A provider with another
 *     behind it stops early enough to leave the reserve, unless that would
 *     leave it less than MIN_ATTEMPT_MS. Then it may use all that is left,
 *     and so may the last provider.
 *   - Each attempt's timeout is the provider's own (120 s for NVIDIA, 60 s
 *     for the rest), cut to what is left of its share. It travels as the
 *     same per-call `timeoutMs` that the portal's Test passes, not as a
 *     second mechanism.
 *   - A retry is made only if its share still holds MIN_ATTEMPT_MS after the
 *     backoff. No attempt is started once less than that is left.
 *   - When less than MIN_ATTEMPT_MS is left and providers are still untried,
 *     the call fails with AI_BUDGET_EXHAUSTED (status 504). The error names
 *     each provider tried, why it failed, and which were never reached.
 *   - Pacing, the retry and failover rules, usage capture and key verdicts
 *     are unchanged.
 *
 * No budget means no change. The background paths pass none: forge jobs,
 * the schedulers, the change feed and every queue worker. They keep the full
 * timeouts and three attempts. The grounded call and `callProvider` take no
 * budget. The synchronous routes that pass one, and the client timeouts they
 * must fit under, are pinned in sync-budgets.test.js. On the trial tier's
 * measured latency, NVIDIA will seldom finish inside a synchronous share.
 * What the budget guarantees is that it can no longer stop the provider
 * behind it from answering. Since 2026-09-29 NVIDIA is not first by
 * default, so the NVIDIA case above arises only where an administrator
 * places it first; the budget still bounds any other slow first provider.
 * The weekly probe (lib/timers/ai-provider-probe.js) is the evidence for
 * placing it first again.
 *
 * MICROSOFT FOUNDRY (#849, 2026-10-04). A fifth provider, `foundry`, on the
 * OpenAI-compatible v1 chat endpoint of a Foundry account the estate owns
 * (infra/foundry.tf): `${FOUNDRY_ENDPOINT}/openai/v1/chat/completions`, with
 * the deployment name in `model`. Owner decision that day: of a USD 75 a
 * month budget, the first call is Foundry as a PAID provider for content,
 * with the cheapest text models — gpt-5-nano ($0.05 in / $0.40 out per 1M
 * tokens) for short calls and gpt-5-mini ($0.25 / $2.00) for drafts and
 * analysis. It differs from the other four in three ways:
 *
 *   - NO KEY. The account has local authentication off; the Function App's
 *     system-assigned identity holds "Cognitive Services OpenAI User" and
 *     the router sends an Entra token for the audience the Foundry v1
 *     endpoint documents, https://ai.azure.com (FOUNDRY_TOKEN_SCOPE in the
 *     environment overrides it), fetched through @azure/identity and cached
 *     until five minutes before it expires. What makes the provider POSSIBLE is the
 *     endpoint setting, which Terraform writes from the account; KEY_ENV
 *     names it so every "has a key" check reads the same way. Locally,
 *     `FOUNDRY_API_KEY` set in functions/.env sends an api-key header
 *     instead, for a developer's own account.
 *   - PLACED PER FEATURE, like NVIDIA: 'first' for the content features the
 *     owner triggers, 'off' for the anonymous public explain route and for
 *     the Gemini-only grounded call (features-catalogue.js).
 *   - Its spend has its own Cost Management budget on the `ai` resource
 *     group (USD 75, alerts at 50/90/100 %), beside the subscription one.
 *
 * ONE RESOLVER DECIDES THE CHAIN (ADR 0034 slice 3, #858, 2026-10-05). The
 * per-feature placement and the per-task routes described above are how
 * the chain was decided until that day; they are now READ through the
 * selection document, `admin_settings/ai-routing` version 2 (selection.js:
 * the Priority list and each task's mode and chain). The config loader
 * migrates a stored v1 document, the placements and the card pins into
 * that shape in memory (migrate-selection.js), and `chainDetails` hands the
 * document, the model catalogue and what holds a key to `selectChain`
 * (select.js), which answers the ordered candidates and why each other one
 * was turned away. The locks the placement defaults carried — the trial
 * tier never on the public explain route, grounding Gemini-only — are the
 * resolver's policy locks, and no document lifts them. What stays here is
 * the router's own: the feature switch, the key check, the
 * `CONTENTFORGE_AI_PROVIDER` pin, failover, retries, budgets and usage.
 *
 * THE AUDIO AND IMAGE TASKS READ THE SAME DOCUMENT (ADR 0034 slice 5, #860).
 * Listen & Learn speech, the podcast voice, the cover art and the manual
 * images are tasks in the registry with `needs` of `tts` or `image`, and
 * ElevenLabs and Replicate are providers the resolver knows: keyed is
 * enabled for them (MEDIA_KEY_ENV; no card, no switch), they are listed in
 * `availability` beside the chat providers, and they never join the
 * Priority list or this router's chat chain — `callWithFailover` has no
 * caller for them and never sees them, because a chat task's `needs` turn
 * them away. `modelForTask` is the one door the media call sites use: the
 * task's effective chain through `chainDetails` (the feature switch, the
 * pin and the resolver all apply), and the first candidate's provider and
 * model back, with the reason and the rejected candidates. The adapters
 * keep their own voices, licences and settings; only the model moved.
 *
 * A Key Vault reference that did not resolve arrives as the literal
 * `@Microsoft.KeyVault(...)` string. That is not a key; `readKey` says so.
 */

import { errorFacts } from '../http/error-response.js';
import { createAiConfigLoader } from './ai-config.js';
import { MEDIA_PROVIDERS, PROVIDER_CAPABILITIES } from './provider-order.js';
// The resolver (ADR 0034 §3, #858): one pure function decides the chain
// from the selection document, the catalogue and what holds a key. The
// per-feature placement and the v1 routes it replaced are migrated into
// that document by the loader (migrate-selection.js).
import { selectChain } from './select.js';
import { defaultSelection } from './migrate-selection.js';
import {
  AI_TASKS,
  TASK_NAMES,
  defaultModeFor,
  isMediaTask,
  taskFor,
} from './tasks.js';
import { recommendedModelFor } from './provider-recommendations.js';
import { MIN_ATTEMPT_MS, startBudget } from './time-budget.js';
import { createKeyVerdictReporter, recordKeyVerdict } from '../key-verdict.js';
import {
  KEYLESS_PROVIDERS,
  KEY_ENV,
  PROVIDERS,
  AiNotConfiguredError,
  getCostEstimate,
  parseJsonWithFallbacks,
  readKey,
  sanitizeJsonText,
} from './router-base.js';
import {
  TEXT_ONLY_PROVIDERS,
  createFoundryTokenProvider,
  createRequestPacer,
  defaultGetToken,
  foundryTokenScope,
  hasNonTextParts,
  isProviderUnusable,
  nvidiaRpm,
  shareEndFor,
  withRetry,
} from './router-transport.js';
import {
  activeProvider,
  availabilityOf,
  chainDetails,
  chainOrThrow,
  keyedMediaProviders,
  keyedProviders,
  providerChain,
} from './router-chain.js';
import {
  CALLERS,
  modelFor,
  openAiCompatibleTable,
  providerTimeoutMs,
} from './router-callers.js';
import { recordCallUsage, generateGroundedJson } from './router-grounded.js';

// Source grounding (#433): the pure half — source checks, prompt, request
// body, response readers — is grounding.js; the call is on the router below.
// The public names are re-exported so callers and tests are unchanged.
export {
  GROUNDING_LIMITS,
  buildGroundedPrompt,
  buildGroundedRequest,
  isYouTubeVideoUrl,
  validateGroundingSources,
} from './grounding.js';
export {
  KEYLESS_PROVIDERS,
  KEY_ENV,
  MEDIA_KEY_ENV,
  PROVIDERS,
  AiFeatureDisabledError,
  AiNotConfiguredError,
  getCostEstimate,
  isRetryableError,
  parseJsonWithFallbacks,
  readKey,
  sanitizeJsonText,
} from './router-base.js';
export {
  AiBudgetExhaustedError,
  FOUNDRY_TOKEN_SCOPE,
  NVIDIA_BASE_URL,
  NVIDIA_DEFAULT_RPM,
  createFoundryTokenProvider,
  createRequestPacer,
  defaultGetToken,
  foundryBaseUrl,
  foundryTokenScope,
} from './router-transport.js';
export { GroundingIncompleteError } from './router-grounded.js';
export {
  COST_TABLE,
  DEFAULT_MODEL_TABLE,
  isPriced,
  modelRatesFor,
} from './model-tables.js';

/**
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {{ warn?: Function }} [deps.log]
 */
export function createAiRouter({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
  store = null,
  configTtlMs = 60_000,
  onKeyVerdict = null,
  now = () => Date.now(),
  getToken = defaultGetToken,
} = {}) {
  const ctx = createRouterContext({
    env,
    fetchImpl,
    sleep,
    log,
    store,
    configTtlMs,
    onKeyVerdict,
    now,
    getToken,
  });
  return {
    availableProviders: () => keyedProviders(ctx),
    availableMediaProviders: () => keyedMediaProviders(ctx),
    getActiveAiProvider: () => activeProvider(ctx),
    resolveProvider: (feature) => firstProvider(ctx, feature),
    resolveProviderChain: (feature) => providerChain(ctx, feature),
    defaultModelFor: (provider, purpose) => modelFor(ctx, provider, purpose),
    generateTextResponse: (params) => generateText(ctx, params),
    generateJsonResponse: (params) => generateJson(ctx, params),
    generateGroundedJsonResponse: (params) => generateGroundedJson(ctx, params),
    callProvider: (params) => callNamedProvider(ctx, params),
    modelForTask: (params) => taskModel(ctx, params),
    getCostEstimate,
    invalidateConfig: ctx.config.invalidate,
    resolveEffectiveSelection: () => effectiveSelection(ctx),
  };
}

/**
 * The router's context: every dependency the functions below share, built
 * once per router (#843, 2026-10-04).
 *
 * Until then those functions were closures inside `createAiRouter`, one
 * 780-line factory with 24 return statements and a complexity of 137 that
 * qlty flagged on every PR touching this file. The move is mechanical: each
 * function takes `ctx` as its first argument where it used to capture a
 * variable, and the factory is reduced to building `ctx` and binding the
 * public surface to it. Key handling (`readKey`, `KEY_ENV`), the
 * `CONTENTFORGE_AI_PROVIDER` pin, per-feature placement and routing,
 * failover order, retry and time budgets are unchanged; router.test.js,
 * sync-budgets.test.js, nvidia-provider.test.js and
 * probe-ai-providers.test.js hold that.
 *
 * The internal names differ from the public ones on purpose. The foot of
 * this file declares `export const { defaultModelFor, … } = defaultRouter`,
 * and a module-level `function defaultModelFor` beside that binding would be
 * a duplicate declaration. So `modelFor(ctx, …)` is bound as
 * `defaultModelFor`, `generateText(ctx, …)` as `generateTextResponse`, and
 * so on; the factory above is the table.
 */
function createRouterContext({
  env,
  fetchImpl,
  sleep,
  log,
  store,
  configTtlMs,
  onKeyVerdict,
  now,
  getToken,
}) {
  // With no store the loader reports "no configuration", and every path below
  // falls back to exactly the environment-only behaviour this router had before
  // the portal's settings were wired up. That is what keeps unit tests — and
  // any caller that does not hand over a Cosmos client — working unchanged.
  const config = createAiConfigLoader({ store, ttlMs: configTtlMs, log, env });

  // One guard per router, so the process-wide router paces every call site in
  // this instance together. See NVIDIA_DEFAULT_RPM for the multi-instance note.
  const nvidiaLimit = nvidiaRpm(env);
  const nvidiaPacer = createRequestPacer({ limit: nvidiaLimit, now });

  /**
   * Tell the API-keys page whether a provider accepted its credential.
   *
   * `lib/key-verdict.js` is the single writer of the red light for a key that
   * resolved but is not working; this is one of the reporters that feed it,
   * beside the Publer timer client (`timers/publer-sync.js`) and the Publer
   * REST proxy (`integrations/rest-proxy.js`). `secrets-health.js` cannot see
   * that state by design — "only the upstream service can say it is wrong" —
   * and each reporter is an upstream service saying so.
   *
   * The two rules that keep it off the hot path (failures always, successes
   * once per reporter per setting until a failure) and the invariant that a
   * status page which cannot record a verdict never fails the AI call it was
   * observing live in key-verdict.js, not here. Reported under the SETTING
   * name: the recorder maps a setting to its vault secret through the
   * catalogue, and a provider name would map to nothing.
   */
  const reportVerdict = createKeyVerdictReporter({
    onKeyVerdict,
    log,
    source: 'ai-router',
  });

  const ctx = {
    env,
    fetchImpl,
    log,
    store,
    now,
    // The router's clock, handed to withRetry so a test can drive the backoff.
    clock: { sleep, now },
    config,
    nvidiaLimit,
    nvidiaPacer,
    reportKeyVerdict: (provider, verdict) =>
      KEYLESS_PROVIDERS.includes(provider)
        ? Promise.resolve()
        : reportVerdict(KEY_ENV[provider], verdict),
    foundryToken: createFoundryTokenProvider({ getToken, now, scope: foundryTokenScope(env) }),
  };
  ctx.openAiCompatible = openAiCompatibleTable(ctx);
  return ctx;
}

/** The purposes `modelFor` serves, in the order the page lists them. */
const PURPOSES = Object.freeze(['draft', 'analysis', 'multimodal', 'general']);

/**
 * The resolver's answer for every task, over the configuration the router
 * reads (ADR 0034 §4, slice 4, #859): what the Tasks tab shows as each
 * task's effective model, so the page can never disagree with production.
 * The browser cannot import the resolver, so this runs it here, on the SAME
 * loader `chainDetails` uses, with the cache dropped first — a save that
 * landed a moment ago is what the answer reflects, not the 60 s cache.
 *
 * Per task: the registry entry (label, modality, needs, public, recommended),
 * the document's entry, and the resolver's `{ mode, chain, rejected, flags }`
 * — the feature switch is NOT applied, because the tab shows what a call
 * WOULD get, and a switched-off task still has an answer. Per Priority row:
 * what a null model resolves to — the provider's default per purpose
 * (`modelFor`, environment overrides included) and the modality
 * recommendation a null step is judged on (select.js header, NULL MODEL).
 *
 * @returns {Promise<{ tasks: Record<string, object>, priority: Array<object>,
 *   availability: { keyed: string[], enabled: string[], disabled: string[] },
 *   updatedAt: string|null }>}
 */
async function effectiveSelection(ctx) {
  ctx.config.invalidate();
  const { providers: docs, selection: loaded, catalog } = await ctx.config.load();
  const selection = loaded || defaultSelection();
  const { keyed, enabled, disabled } = availabilityOf(ctx, docs);
  const availability = { keyed, enabled };

  const tasks = {};
  for (const task of TASK_NAMES) {
    const def = AI_TASKS[task];
    const { mode, chain, rejected, flags } = selectChain({ task, selection, catalog, availability });
    tasks[task] = {
      label: def.label,
      description: def.description,
      route: def.route,
      modality: def.modality,
      needs: [...def.needs],
      public: def.public,
      recommended: def.recommended,
      planned: def.planned === true,
      media: isMediaTask(def),
      // The product rule, when the task has one (tasks.js `only`): the page
      // offers a chain only those providers.
      only: Array.isArray(def.only) ? [...def.only] : null,
      entry: selection.tasks?.[task] || { mode: defaultModeFor(def) },
      mode,
      chain,
      rejected,
      flags,
    };
  }

  const priority = (selection.global?.priority || []).map(({ provider, model }) => ({
    provider,
    model,
    keyed: keyed.includes(provider),
    enabled: enabled.includes(provider),
    defaults: Object.fromEntries(PURPOSES.map((p) => [p, modelFor(ctx, provider, p)])),
    modality: {
      text: recommendedModelFor(provider, 'text')?.model || null,
      vision: recommendedModelFor(provider, 'vision')?.model || null,
    },
  }));

  return {
    tasks,
    priority,
    // The media providers are keyed-is-enabled and the page has no card for
    // them; `media` names them and `capabilities` says what each provider
    // can carry, so the chain editor offers a task only the providers that
    // can serve it (ADR 0034 slice 5, #860).
    availability: {
      keyed,
      enabled,
      disabled,
      media: [...MEDIA_PROVIDERS],
      capabilities: PROVIDER_CAPABILITIES,
    },
    updatedAt: selection.updatedAt ?? null,
  };
}

/**
 * Try each provider in order until one answers.
 *
 * WHY THIS EXISTS. The portal calls its list an "order of preference" and the
 * page says the next provider down is used if the first cannot serve. Until
 * this, that was only true of key presence and the enabled switch — an actual
 * FAILURE from the first provider failed the whole call. That gap became
 * dangerous the moment the default order changed to Gemini first (2026-08-23):
 * the Gemini model ids were ported from upstream's Vertex table, and if one of
 * them is not a valid public Generative Language API model, every AI feature
 * that worked through Anthropic the day before would return 404 and stop.
 *
 * A provider that fails is logged at warn with the reason, because silently
 * spending Anthropic money to paper over a broken Gemini configuration is its
 * own kind of failure. `usageOut` records the provider that actually served.
 *
 * With a `budget` (header: SYNCHRONOUS CALLS HAVE A TIME BUDGET), each
 * provider gets a share of what is left, and every attempt's `timeoutMs` is
 * cut to that share. When too little is left to try the next provider, the
 * call ends with AI_BUDGET_EXHAUSTED rather than sending an attempt that
 * cannot finish. Without one, nothing here differs from before budgets.
 */
async function callWithFailover(
  ctx,
  { chain, explicitModel, budget = null, feature = null, usageOut = null, ...args }
) {
  const attempts = [];
  // Collected here, recorded once the call has an answer, then handed to
  // the caller's array with the row ids attached (recordCallUsage).
  const collected = [];

  for (const [index, { provider, model: configuredModel, selection }] of chain.entries()) {
    const shareEnd = budget ? shareEndFor(ctx.now, budget, { chain, index, attempts }) : null;
    // An explicit model from the call site wins; then the resolver's choice
    // (the chain's or the document's); then the purpose table.
    const model = explicitModel || configuredModel;
    try {
      const result = await withRetry(
        ctx.clock,
        () =>
          callWith(ctx, provider, attemptArgs(ctx, provider, { args, collected, model, shareEnd })),
        { provider, shareEnd }
      );
      await ctx.reportKeyVerdict(provider, { ok: true });
      // How the candidate was chosen (ADR 0034 §3), on the row the Usage
      // tab reads: `explicit` for a call-site model, else the chain's.
      const source = explicitModel ? 'explicit' : selection;
      if (source) for (const entry of collected) entry.selection ??= source;
      const recorded = await recordCallUsage(ctx, collected, feature);
      if (Array.isArray(usageOut)) usageOut.push(...recorded);
      return result;
    } catch (error) {
      attempts.push({ provider, error });
      await failOverOrThrow(ctx, provider, error, chain);
    }
  }

  // Unreachable: the loop either returns or throws on its last iteration.
  throw attempts.at(-1)?.error || new AiNotConfiguredError('No AI provider was tried');
}

/**
 * One attempt's arguments. Under a budget, the provider's own timeout is
 * cut to what is left of its share; withRetry starts no attempt once less
 * than MIN_ATTEMPT_MS is left.
 */
function attemptArgs(ctx, provider, { args, collected, model, shareEnd }) {
  const timeout =
    shareEnd === null
      ? {}
      : { timeoutMs: Math.min(providerTimeoutMs(ctx, provider), shareEnd - ctx.now()) };
  return { ...args, usageOut: collected, model, ...timeout };
}

/**
 * After a provider failed: report a bad credential, then either hand the
 * call to the next provider (a warning, so silently spending the next
 * provider's money is visible) or rethrow when there is none or the
 * failure is not the provider's.
 */
async function failOverOrThrow(ctx, provider, error, chain) {
  const status = Number(error?.status);
  // 401/403 ONLY. A 404 means the model id is wrong and a 429 means the
  // account is busy — neither says the credential is bad, and reporting
  // them would turn the light red for something no rotation can fix.
  if ([401, 403].includes(status)) await ctx.reportKeyVerdict(provider, { ok: false, status });
  const last = chain[chain.length - 1].provider === provider;
  if (last || !isProviderUnusable(error, provider)) throw error;
  ctx.log.warn?.(
    `[ai-router] ${provider} could not serve this call (${errorFacts(error)}); trying the next provider`
  );
}

/**
 * The single best provider, for callers that only need to name one.
 *
 * @param {string|null} feature A key of AI_FEATURES, or null to skip the gate.
 * @returns {Promise<{provider: string, model: string|null}>}
 */
async function firstProvider(ctx, feature = null) {
  return (await providerChain(ctx, feature))[0];
}

/**
 * The model a media task will use (header: THE AUDIO AND IMAGE TASKS): the
 * first candidate of the task's effective chain, exactly as `providerChain`
 * resolves it — the feature switch (AiFeatureDisabledError), the key check,
 * the `CONTENTFORGE_AI_PROVIDER` pin, the policy locks and the task's
 * `needs` all apply, and an empty chain throws the same AiNotConfiguredError
 * sentence a text call would see. A candidate with no named model (a custom
 * step naming the provider alone) answers the model it was judged on, the
 * provider's recommendation for the task's modality
 * (provider-recommendations.js), because a voice has no purpose table to
 * fall back on. The rejected candidates and the flags travel back so a
 * call site can log why the chain is what it is.
 *
 * Call sites name their task here as text sites name their feature, and
 * ai-call-sites.test.js reads the source for both.
 *
 * @param {{ task: string }} params
 * @returns {Promise<{ task: string, provider: string, model: string|null,
 *   selection: string, why: string, rejected: Array<object>, flags: string[] }>}
 */
async function taskModel(ctx, { task }) {
  const name = String(task || '').trim();
  if (!taskFor(name)) throw new AiNotConfiguredError(`Unknown AI task: ${name || '(none)'}`);
  const details = await chainDetails(ctx, name);
  // The same empty-chain sentences as every other call (providerChain).
  const first = chainOrThrow(details, name)[0];
  return {
    task: name,
    provider: first.provider,
    model: first.model || first.modalityModel || null,
    selection: first.selection,
    why: first.why || '',
    rejected: details.rejected,
    flags: details.flags,
  };
}

/**
 * The chain a call carrying these parts can use. A text-only provider is
 * left out of a call with an image in it — sending it would be a refusal,
 * and a refusal does not fail over. An empty result says so rather than
 * reporting "not configured".
 */
function chainForParts(chain, parts) {
  if (!hasNonTextParts(parts)) return chain;
  const usable = chain.filter(({ provider }) => !TEXT_ONLY_PROVIDERS.includes(provider));
  if (usable.length === 0) {
    throw new AiNotConfiguredError(
      `This call carries non-text parts and the only provider in its chain (${chain
        .map((c) => c.provider)
        .join(', ')}) takes text only.`
    );
  }
  return usable;
}

function callWith(ctx, provider, args) {
  const caller = CALLERS[provider];
  if (!caller) throw new AiNotConfiguredError(`Unknown AI provider: ${provider}`);
  return caller(ctx, args);
}

/**
 * A call's budget, started now: before the configuration read, which is
 * part of the call's time. No `budgetMs` is no budget (header).
 */
const budgetFor = (ctx, budgetMs) =>
  budgetMs === null || budgetMs === undefined ? null : startBudget(budgetMs, ctx.now());

/** Resolve the chain and call it: the shared body of both generate calls. */
async function generate(ctx, { feature, parts, model, budget, ...args }) {
  const chain = chainForParts(await providerChain(ctx, feature), parts);
  return callWithFailover(ctx, {
    chain,
    explicitModel: model,
    parts,
    budget,
    feature,
    ...args,
  });
}

/**
 * @param {object} [params]
 * @param {number} [params.budgetMs] Synchronous callers only: the time this
 *   call may take, from now, failover included (header: SYNCHRONOUS CALLS
 *   HAVE A TIME BUDGET). Omitted, the call runs as it always has.
 */
async function generateText(
  ctx,
  {
    prompt = '',
    parts = null,
    model = null,
    purpose = 'general',
    systemPrompt = '',
    usageOut = null,
    feature = null,
    budgetMs = null,
    signal = null,
  } = {}
) {
  return generate(ctx, {
    feature,
    parts,
    model,
    budget: budgetFor(ctx, budgetMs),
    prompt,
    purpose,
    expectJson: false,
    systemPrompt,
    usageOut,
    signal,
  });
}

/** As generateText, parsed as JSON, with one repair round trip. */
async function generateJson(
  ctx,
  {
    prompt = '',
    parts = null,
    model = null,
    purpose = 'general',
    systemPrompt = '',
    usageOut = null,
    feature = null,
    budgetMs = null,
    signal = null,
  } = {}
) {
  const budget = budgetFor(ctx, budgetMs);
  const text = await generate(ctx, {
    feature,
    parts,
    model,
    budget,
    prompt,
    purpose,
    expectJson: true,
    systemPrompt,
    usageOut,
    signal,
  });
  try {
    return parseJsonWithFallbacks(text);
  } catch (parseError) {
    if (signal?.aborted) throw signal.reason || parseError;
    // One repair round trip, then the original parse error wins. Inside a
    // budget the repair shares the same deadline. It is skipped when it
    // could not have a whole attempt, because the parse error says more
    // than "out of time" would.
    if (budget && budget.deadline - ctx.now() < MIN_ATTEMPT_MS) throw parseError;
    const repaired = await generate(ctx, {
      prompt: `The following should be JSON but is malformed. Repair it and return ONLY valid JSON with no markdown fences, no explanation, and no extra keys.\n\n${sanitizeJsonText(text).slice(0, 30000)}`,
      parts: null,
      model,
      purpose,
      expectJson: false,
      systemPrompt:
        'You repair malformed JSON. Return only strict RFC 8259 JSON. Do not add commentary.',
      usageOut,
      // The repair belongs to the call that is already permitted; re-checking
      // under the same cached settings keeps the two halves consistent.
      feature,
      budget,
      signal,
    });
    try {
      return parseJsonWithFallbacks(repaired);
    } catch {
      throw parseError;
    }
  }
}

/**
 * One call to one named provider, with no failover (the portal's Test and
 * Playground, and the weekly probe that runs the Test): the aiProxy /
 * testAiProvider shape, an explicit provider, text back with token counts.
 * `maxTokens` is an optional per-call cap for providers whose table row
 * sends one (NVIDIA). `timeoutMs` is an optional per-call limit that every
 * provider honours; a budgeted call passes the same argument. The Test
 * passes small values of both, so a reasoning model proves it answers in
 * seconds instead of thinking past the edge's request limit (#701,
 * 2026-09-29: 56-58 s).
 */
async function callNamedProvider(
  ctx,
  { provider, model, prompt, systemPrompt = '', maxTokens, timeoutMs, signal }
) {
  if (!PROVIDERS.includes(provider))
    throw new AiNotConfiguredError(`Unknown AI provider: ${provider}`);
  if (!readKey(ctx.env, KEY_ENV[provider])) {
    throw new AiNotConfiguredError(
      `${provider} is not configured: ${KEY_ENV[provider]} is not set`
    );
  }
  const usageOut = [];
  const text = await callWith(ctx, provider, {
    prompt,
    parts: null,
    model,
    purpose: 'general',
    expectJson: false,
    systemPrompt,
    usageOut,
    maxTokens,
    timeoutMs,
    signal,
  });
  const usage = usageOut[0] || {};
  return {
    text,
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    model: usage.model || model,
  };
}

/**
 * Process-wide instance for production call sites.
 *
 * The Cosmos client is imported lazily, and for two reasons. It keeps the cost
 * off the cold-start path of every function that merely imports `readKey` from
 * here (six modules do, and none of them touch a model). And it keeps this
 * module importable in tests and in tooling without a Cosmos connection string
 * — the store is only constructed when an AI call is actually made.
 */
const defaultRouter = createAiRouter({
  store: {
    queryDocs: async (...args) => (await import('../cosmos-client.js')).queryDocs(...args),
    readDoc: async (...args) => (await import('../cosmos-client.js')).readDoc(...args),
    // The usage row every call writes (recordCallUsage). Lazy for the same
    // reason as the two reads.
    upsertDoc: async (...args) => (await import('../cosmos-client.js')).upsertDoc(...args),
  },
  // The same process-wide writer the Publer timer and proxy use, so the two
  // reporters cannot disagree about what a rejected credential is. It imports
  // Cosmos lazily for the same reason the store does: nothing on the
  // cold-start path of the six modules that import only `readKey` from here.
  onKeyVerdict: recordKeyVerdict,
});

export const {
  availableProviders,
  availableMediaProviders,
  modelForTask,
  getActiveAiProvider,
  resolveProvider,
  defaultModelFor,
  generateTextResponse,
  generateJsonResponse,
  generateGroundedJsonResponse,
  callProvider,
  invalidateConfig,
  resolveEffectiveSelection,
} = defaultRouter;
