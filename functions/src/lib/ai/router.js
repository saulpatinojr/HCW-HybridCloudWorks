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

import { AuthoredError, codeShaped, errorCode } from '../http/error-response.js';
import {
  DEFAULT_PROVIDER_ORDER,
  createAiConfigLoader,
  isFeatureEnabled,
  resolveProviderOrder,
} from './ai-config.js';
import { MEDIA_PROVIDERS, PROVIDER_CAPABILITIES } from './provider-order.js';
// The resolver (ADR 0034 §3, #858): one pure function decides the chain
// from the selection document, the catalogue and what holds a key. The
// per-feature placement and the v1 routes it replaced are migrated into
// that document by the loader (migrate-selection.js).
import { UNDECLARED_TASK, selectChain } from './select.js';
import { defaultSelection } from './migrate-selection.js';
import { AI_TASKS, TASK_NAMES, defaultModeFor, isMediaTask, taskFor } from './tasks.js';
import { recommendedModelFor } from './provider-recommendations.js';
import { featureSource, recordAiUsage } from './usage.js';
import { COST_TABLE, DEFAULT_MODEL_TABLE, isPriced, modelRatesFor } from './model-tables.js';
// Source grounding (#433): the pure half — source checks, prompt, request
// body, response readers — is grounding.js; the call is on the router below.
// The public names are re-exported so callers and tests are unchanged.
import {
  GROUNDED_TIMEOUT_MS,
  INTERACTIONS_URL,
  buildGroundedRequest,
  failedRetrievals,
  groundedOutputText,
  groundingUnavailable,
  validateGroundingSources,
} from './grounding.js';
import { MIN_ATTEMPT_MS, providerShareMs, startBudget } from './time-budget.js';
import { createKeyVerdictReporter, recordKeyVerdict } from '../key-verdict.js';

export {
  GROUNDING_LIMITS,
  buildGroundedPrompt,
  buildGroundedRequest,
  isYouTubeVideoUrl,
  validateGroundingSources,
} from './grounding.js';

/**
 * The providers this platform implements, in default preference order.
 *
 * Set and order are deliberately the same list: there is no implemented
 * provider without a place in the order, and no place in the order for a
 * provider that is not implemented. Keeping them as one constant is what stops
 * the two drifting — `ai-config.test.js` asserts the members match.
 *
 * The order changed on 2026-08-23 (owner decision) from Anthropic-first to
 * Gemini-first; the reasoning is on DEFAULT_PROVIDER_ORDER.
 */
export const PROVIDERS = DEFAULT_PROVIDER_ORDER;

export const KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  // Not a key (header: MICROSOFT FOUNDRY): the endpoint Terraform sets. Its
  // presence is what makes the provider available; the token is fetched.
  foundry: 'FOUNDRY_ENDPOINT',
});

/**
 * Providers with no secret behind them. A 401/403 from one of these is a
 * missing role, not a bad key, so the router reports no key verdict for it:
 * there is no API-keys row to turn red, and the secret catalogue (which the
 * Terraform cross-check holds to the vault references exactly) carries no
 * entry for it. secret-catalog.test.js pins the probed set to the rest.
 */
export const KEYLESS_PROVIDERS = Object.freeze(['foundry']);

/**
 * The media providers' keys (header: THE AUDIO AND IMAGE TASKS). Kept apart
 * from KEY_ENV on purpose: KEY_ENV is the chat providers', read by
 * `availableProviders`, the weekly probe's Test and the API-keys page, and
 * none of those can call a voice or an image model. `availableMediaProviders`
 * reads this one; the resolver's `availability` is the union.
 */
export const MEDIA_KEY_ENV = Object.freeze({
  elevenlabs: 'ELEVENLABS_API_KEY',
  replicate: 'REPLICATE_API_KEY',
});

// The purpose → model table and the cost table live in model-tables.js
// (#858, so the catalogue can read them without this module); every caller
// keeps importing them from here.
export { COST_TABLE, DEFAULT_MODEL_TABLE, isPriced, modelRatesFor } from './model-tables.js';

export function getCostEstimate(provider, model, promptTokens = 0, completionTokens = 0, at = Date.now()) {
  const rates = COST_TABLE[provider] || {};
  if (!isPriced(provider, model)) return 0;
  // Image costs are supplied by the image caller, never inferred from token counts.
  const [inRate, outRate] = modelRatesFor(provider, model, at) || (provider === 'nvidia' ? rates.default : null) || [0, 0];
  return parseFloat(
    ((promptTokens / 1_000_000) * inRate + (completionTokens / 1_000_000) * outRate).toFixed(8)
  );
}

/**
 * No provider can run this call as configured. Every message is written in
 * this module and names the setting to fix, so an admin route may show it
 * (`authoredMessage`, #945); a public route keeps its own sentence.
 */
export class AiNotConfiguredError extends AuthoredError {
  /** @param {string} message - the sentence naming what is missing */
  constructor(message) {
    super(message);
    this.name = 'AiNotConfiguredError';
    this.code = 'AI_NOT_CONFIGURED';
  }
}

/**
 * An administrator switched this feature off in the portal. Distinct from
 * AiNotConfiguredError because it is a decision, not a fault: callers that
 * degrade gracefully (skip alt text, publish an ungraded draft) should catch
 * this and carry on, and nothing should page anyone about it.
 */
export class AiFeatureDisabledError extends AuthoredError {
  /** @param {string} feature - the feature switched off (authored sentence, #945) */
  constructor(feature) {
    super(`The '${feature}' AI feature is turned off in the admin portal.`);
    this.name = 'AiFeatureDisabledError';
    this.code = 'AI_FEATURE_DISABLED';
    this.feature = feature;
  }
}

/** An env value that is a real key: non-empty and not an unresolved Key Vault reference. */
export function readKey(env, name) {
  const raw = env?.[name];
  if (typeof raw !== 'string') return '';
  const value = raw.replace(/^\uFEFF/, '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

export function sanitizeJsonText(text = '') {
  return String(text)
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

export function parseJsonWithFallbacks(rawText = '') {
  const cleaned = sanitizeJsonText(rawText);
  try {
    return JSON.parse(cleaned || '{}');
  } catch {
    // fall through to object extraction
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    // Control characters a model leaked into a string value break JSON.parse.
    return JSON.parse(cleaned.slice(start, end + 1).replace(/[\u0000-\u0019]/g, ' '));
  }
  throw new Error('Model response did not contain parseable JSON');
}

export function isRetryableError(error) {
  const status = error?.status;
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  return /429|503|timeout|temporarily unavailable|rate/i.test(String(error?.message || ''));
}

const JSON_ONLY =
  'Return only valid JSON. Do not include markdown code fences, prose, or extra commentary.';

function recordUsage(usageOut, provider, model, promptTokens, completionTokens) {
  if (!Array.isArray(usageOut)) return;
  const inTokens = Number(promptTokens) || 0;
  const outTokens = Number(completionTokens) || 0;
  usageOut.push({
    provider,
    model,
    promptTokens: inTokens,
    completionTokens: outTokens,
    costUsd: getCostEstimate(provider, model, inTokens, outTokens),
    ...(isPriced(provider, model) ? {} : { unpriced: true }),
  });
}

/**
 * A part a converter cannot carry is refused, never dropped.
 *
 * Until #433 each converter returned null for a shape it did not recognise and
 * filtered it out, so a `fileData` part reached the model as nothing and the
 * model answered — confidently — without it. Nothing errored and nothing
 * logged. The refusal is a 400 on purpose: `isRetryableError` will not retry
 * it and `isProviderUnusable` will not fail over from it, because the next
 * provider would refuse the same part (or, worse, be the one that drops it).
 * The wording avoids every token those two predicates match on.
 */
function refusePart(provider, part, expected) {
  const shape =
    part && typeof part === 'object' ? `{${Object.keys(part).join(', ')}}` : String(typeof part);
  const err = new Error(
    `Cannot send a prompt part to ${provider}: expected ${expected}, got ${shape}. Nothing was sent.`
  );
  err.status = 400;
  err.code = 'AI_PART_REFUSED';
  return err;
}

/** Multimodal parts → OpenAI content blocks. */
function toOpenAiContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
      };
    }
    throw refusePart(
      'openai',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/**
 * Parts → one plain string, for a text-only provider. Only text parts are
 * possible here — `chainForParts` keeps anything else away — so any other
 * shape is refused rather than dropped, as everywhere else.
 */
function toPlainText(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return prompt;
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text;
      throw refusePart('nvidia', part, '{text}');
    })
    .join('\n\n');
}

/** Multimodal parts → Anthropic content blocks. */
function toAnthropicContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    throw refusePart(
      'anthropic',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/** Multimodal parts → Gemini parts (already the native shape). */
function toGeminiParts(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { text: part.text };
    if (part?.inlineData?.mimeType && part?.inlineData?.data) {
      return {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    // A URL the model should fetch is not a part on this endpoint at all — it
    // is a grounded call; see generateGroundedJsonResponse.
    throw refusePart('gemini', part, '{text} or {inlineData:{mimeType,data}}');
  });
}

// ---------------------------------------------------------------------------
// NVIDIA API Catalog (#701).

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * The Entra audience the Foundry v1 endpoint accepts. Microsoft's pages name
 * two: the keyless-authentication guide for Foundry resources on the
 * /openai/v1 path says tokens must carry `https://ai.azure.com/.default`,
 * while older Azure OpenAI pages say `https://cognitiveservices.azure.com`.
 * This is the documented one for the resource kind foundry.tf creates;
 * FOUNDRY_TOKEN_SCOPE in the environment overrides it, so a 401 on the other
 * audience is an app setting away rather than a deploy.
 */
export const FOUNDRY_TOKEN_SCOPE = 'https://ai.azure.com/.default';

/** The audience to request: the environment's override, else FOUNDRY_TOKEN_SCOPE. */
export const foundryTokenScope = (env) => readKey(env, 'FOUNDRY_TOKEN_SCOPE') || FOUNDRY_TOKEN_SCOPE;

/** The account's base URL for the OpenAI v1 surface, from FOUNDRY_ENDPOINT without a trailing slash. */
export function foundryBaseUrl(env) {
  return readKey(env, KEY_ENV.foundry).replace(/\/+$/, '');
}

/**
 * An Entra token for Foundry, fetched through @azure/identity and reused
 * until five minutes before it expires (#849). `getToken(scope)` is the
 * credential's own shape, `{ token, expiresOnTimestamp }`, so a test hands
 * in a stub and production hands in DefaultAzureCredential: the Function
 * App's system-assigned identity there, `az login` on a workstation.
 */
export function createFoundryTokenProvider({
  getToken,
  now = () => Date.now(),
  scope = FOUNDRY_TOKEN_SCOPE,
}) {
  const EARLY_MS = 5 * 60_000;
  let cached = null;
  return async () => {
    if (cached && cached.expiresOnTimestamp - now() > EARLY_MS) return cached.token;
    cached = await getToken(scope);
    return cached.token;
  };
}

/**
 * Production's token source: @azure/identity, imported only when Foundry is
 * first called. The specifier is a variable with `@vite-ignore` because the
 * frontend's contract tests import this module through Vite, which would
 * otherwise try to resolve a package only the Function App installs.
 */
export async function defaultGetToken(scope) {
  const identity = '@azure/identity';
  const { DefaultAzureCredential } = await import(/* @vite-ignore */ identity);
  return new DefaultAzureCredential().getToken(scope);
}

/**
 * Requests per rolling minute this instance will send to NVIDIA.
 *
 * The account limit is about 40 RPM (issue #701, checked 2026-09-25). 36 leaves
 * headroom for the admin portal's Test button and for clock skew between our
 * window and theirs. `NVIDIA_REQUESTS_PER_MINUTE` overrides it — lower, or
 * higher once NVIDIA raises the account's limit.
 *
 * The guard is per Function App INSTANCE. Two instances can together exceed
 * the account limit; when they do, NVIDIA answers 429, the router retries and
 * then fails over, which is the same degradation by a longer road.
 */
export const NVIDIA_DEFAULT_RPM = 36;

/** Reasoning models think before they answer; 60 s was sized for chat. */
const NVIDIA_TIMEOUT_MS = 120_000;

/**
 * A draft is long. Without it some NIM endpoints apply a small default and
 * truncate mid-article; a model whose cap is lower answers 400, which fails
 * over (see the header).
 */
const NVIDIA_MAX_TOKENS = 8192;

/**
 * A sliding-window pacing guard: at most `limit` grants in any `windowMs`.
 *
 * Sliding rather than a refilling bucket so the bound is exact — a full bucket
 * plus a minute of refill can pass nearly twice the limit inside one rolling
 * minute, which is precisely what an RPM limit counts. `take()` never waits: a
 * refusal is immediate, so the caller fails over instead of holding a request
 * open for up to a minute.
 */
export function createRequestPacer({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const grants = [];
  const prune = (t) => {
    while (grants.length && t - grants[0] >= windowMs) grants.shift();
  };
  return {
    take() {
      const t = now();
      prune(t);
      if (grants.length >= limit) return false;
      grants.push(t);
      return true;
    },
    /** Grants inside the current window; for tests and diagnostics. */
    used() {
      prune(now());
      return grants.length;
    },
  };
}

function nvidiaRpm(env) {
  const n = Number.parseInt(String(env?.NVIDIA_REQUESTS_PER_MINUTE ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : NVIDIA_DEFAULT_RPM;
}

function pacedError(limit) {
  const err = new Error(
    `nvidia pacing guard: ${limit} requests in the last minute already sent from this instance; not sent.`
  );
  // 429 so it reads as what it is everywhere else; AI_PACED so withRetry does
  // not sleep and try again against a window that is still full.
  err.status = 429;
  err.code = 'AI_PACED';
  return err;
}

/** Providers that take text only, and are left out of a call carrying other parts. */
const TEXT_ONLY_PROVIDERS = Object.freeze(['nvidia']);

function hasNonTextParts(parts) {
  return Array.isArray(parts) && parts.some((part) => typeof part?.text !== 'string');
}

/** Some reasoning models inline their thinking; the answer is what follows it. */
function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

/**
 * One chat attempt's timeout for a provider whose table row sets none: every
 * provider but NVIDIA. A budgeted call cuts it shorter, never longer.
 */
const CHAT_TIMEOUT_MS = 60_000;

async function postJson(fetchImpl, url, { headers, body, timeoutMs = CHAT_TIMEOUT_MS, signal: parentSignal }) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;
  if (signal.aborted) {
    clearTimeout(timer);
    const err = new Error(signal.reason?.message || 'aborted');
    err.status = 408;
    throw err;
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 300);
      const err = new Error(`${response.status} ${detail}`);
      err.status = response.status;
      throw err;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError' && !parentSignal?.aborted) {
      const err = new Error(`timeout after ${timeoutMs} ms`);
      err.status = 408;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this error mean the PROVIDER is unusable, or that the REQUEST is bad?
 *
 * The distinction decides whether trying the next provider is worth anything.
 * A rejected key, a missing model or a dead endpoint is specific to one
 * provider and the next one will very likely work. A malformed request will
 * be malformed for all three, and walking the whole chain to prove it just
 * spends money and time on the same failure.
 */
function isProviderUnusable(error, provider = null) {
  const status = Number(error?.status);
  // NVIDIA only: its models differ in context length and accepted
  // parameters, so its 400 is not evidence the request is bad everywhere
  // (header). A part we refused ourselves is, and stays put.
  if (provider === 'nvidia' && [400, 422].includes(status) && error?.code !== 'AI_PART_REFUSED') {
    return true;
  }
  // 401/403 rejected key, 404 unknown model or endpoint.
  if ([401, 403, 404].includes(status)) return true;
  // Anything retryable that survived its retries: the provider is not coming
  // back within this call.
  if (isRetryableError(error)) return true;
  return /model|not found|unsupported|deprecated|quota|billing|credit/i.test(
    String(error?.message || '')
  );
}

/**
 * How a budgeted call ends when too little time is left to try the next
 * provider.
 *
 * It names each provider that was tried with its reason, and each that was
 * never reached. "Timed out" on its own would hide which provider spent the
 * time, and that is the one thing the owner needs in order to act. Status
 * 504 and code AI_BUDGET_EXHAUSTED let a handler map it to an HTTP status.
 * Nothing retries it: it is thrown outside withRetry, and after failover.
 */
function budgetExhausted(budget, attempts, untried) {
  const seconds = Math.round(budget.totalMs / 1000);
  const notTried = untried.map((entry) => entry.provider).join(', ');
  // Each reason is a code, never the provider's own message, so the sentence
  // stays this module's and an admin route may show it whole (#945).
  const tried = attempts
    .map(({ provider, error }) => `${provider} (${attemptReason(error)})`)
    .join('; ');
  return new AiBudgetExhaustedError(
    tried
      ? `This AI call's ${seconds} s budget ran out after ${tried}. Not tried: ${notTried}.`
      : `This AI call's ${seconds} s budget left too little time to try any provider (${notTried}).`,
    attempts.length ? attempts.at(-1).error : undefined
  );
}

/**
 * Why one attempt ended, content-free: "timed out" for the router's own
 * timeout, otherwise the error's code or HTTP status.
 *
 * @param {unknown} error - what the attempt threw
 * @returns {string}
 */
function attemptReason(error) {
  return error?.status === 408 && !error?.code ? 'timed out' : errorCode(error);
}

/**
 * The AI call's time budget is spent. Status 504, code AI_BUDGET_EXHAUSTED;
 * the sentence names the providers and their reasons as codes (authored).
 */
export class AiBudgetExhaustedError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence
   * @param {unknown} [cause] - the last attempt's error, for the log
   */
  constructor(message, cause) {
    super(message, { code: 'AI_BUDGET_EXHAUSTED', status: 504, cause });
  }
}

/**
 * When this provider's share of the budget ends, or the AI_BUDGET_EXHAUSTED
 * error when too little is left to start it at all.
 */
function shareEndFor(now, budget, { chain, index, attempts }) {
  const startedAt = now();
  const shareMs = providerShareMs({
    remainingMs: budget.deadline - startedAt,
    reserveMs: budget.reserveMs,
    hasNext: index < chain.length - 1,
  });
  if (shareMs === 0) throw budgetExhausted(budget, attempts, chain.slice(index));
  return startedAt + shareMs;
}

/**
 * Retry a retryable failure with backoff. `sleep` and `now` are the router's
 * clock, passed in so a test can run the backoff without waiting it out.
 *
 * Two exceptions, both about not waiting for nothing: a pacing refusal
 * (AI_PACED) is never retried — the window is still full two seconds later
 * — and NVIDIA's timeout is not either, because two more 120 s attempts
 * would hold an owner's job for six minutes before failing over.
 *
 * Inside a budget, `shareEnd` is when this provider's share runs out. A
 * retry is made only if the share still holds MIN_ATTEMPT_MS after the
 * backoff. The check is repeated once the wait is over, in case the wait
 * ran long. Otherwise the error goes straight to the failover, which is
 * worth more than a retry that cannot finish.
 */
async function withRetry(
  { sleep, now },
  operation,
  { maxAttempts = 3, provider = null, shareEnd = null } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error?.code === 'AI_PACED') break;
      if (provider === 'nvidia' && Number(error?.status) === 408) break;
      if (attempt >= maxAttempts || !isRetryableError(error)) break;
      const backoffMs = 2 ** attempt * 1000;
      if (shareEnd !== null && shareEnd - now() - backoffMs < MIN_ATTEMPT_MS) break;
      await sleep(backoffMs);
      if (shareEnd !== null && shareEnd - now() < MIN_ATTEMPT_MS) break;
    }
  }
  throw lastError;
}

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

const keyedProviders = (ctx) => PROVIDERS.filter((p) => readKey(ctx.env, KEY_ENV[p]));

/** The media providers holding a key: enabled by that alone (header: THE AUDIO AND IMAGE TASKS). */
const keyedMediaProviders = (ctx) =>
  MEDIA_PROVIDERS.filter((p) => readKey(ctx.env, MEDIA_KEY_ENV[p]));

/**
 * What the resolver may choose from: the chat providers holding a key and
 * those switched on, each list joined by the keyed media providers, which
 * have no switch.
 */
function availabilityOf(ctx, docs) {
  const keyed = keyedProviders(ctx);
  const { order: enabled, disabled } = resolveProviderOrder(docs, keyed);
  const media = keyedMediaProviders(ctx);
  return { keyed: [...keyed, ...media], enabled: [...enabled, ...media], disabled };
}

const pinnedProvider = (ctx) =>
  String(ctx.env.CONTENTFORGE_AI_PROVIDER || '')
    .toLowerCase()
    .trim();

/**
 * The provider chosen from KEYS ALONE, ignoring anything stored in the portal.
 *
 * Kept synchronous and kept env-only on purpose: callers use it to label and
 * to log, and an await there would ripple through four modules for no gain.
 * It is NOT the provider a call will use once an administrator has reordered
 * or disabled something — for that, read `usageOut` after the call, which
 * records what actually ran. `firstProvider` is the real selection.
 */
function activeProvider(ctx) {
  const available = keyedProviders(ctx);
  const pinned = pinnedProvider(ctx);
  if (pinned) {
    if (available.includes(pinned)) return pinned;
    ctx.log.warn?.(
      `[ai-router] CONTENTFORGE_AI_PROVIDER=${pinned} but its key is not present; falling back to ${available[0] || 'none'}`
    );
  }
  return available[0] || null;
}

/**
 * The ordered list of providers a call may use, best first.
 *
 * Returns every eligible provider rather than only the winner, because
 * "order of preference" has to mean preference — see `callWithFailover`.
 *
 * @param {string|null} feature A key of AI_FEATURES, or null to skip the gate.
 * @returns {Promise<Array<{provider: string, model: string|null}>>}
 */
async function providerChain(ctx, feature = null) {
  return chainOrThrow(await chainDetails(ctx, feature), feature);
}

/** The chain of a resolved `chainDetails`, or the AiNotConfiguredError sentence an empty one earns. */
function chainOrThrow({ chain, disabled, excluded, uncapable, retired, noModel, modality }, feature) {

  if (chain.length === 0) {
    const name = feature ? `'${feature}'` : 'this call';
    // A media task with a product rule (tasks.js `only`): the sentence names
    // the providers that may serve it and the key each needs, not the chat
    // keys and a placement that no longer exists (ADR 0034 slice 5).
    const only = feature ? taskFor(feature)?.only : null;
    if (Array.isArray(only) && disabled.length === 0) {
      const keys = only.map((p) => MEDIA_KEY_ENV[p] || KEY_ENV[p]).filter(Boolean);
      throw new AiNotConfiguredError(
        `${name} is served by ${only.join(' or ')} only, and ${only.length === 1 ? 'it holds' : 'none of them holds'} a usable key or model. Seed ${keys.join(' or ')} in Key Vault (Required-Inputs §4.6), or pick a model under AI Engine → Tasks${uncapable.length || retired.length ? ` (${[...uncapable, ...retired].map((r) => `${r.provider}: ${r.why}`).join('; ')})` : ''}.`
      );
    }
    if (excluded.length > 0 && disabled.length === 0) {
      throw new AiNotConfiguredError(
        `The only configured AI provider (${excluded.join(', ')}) is not used for ${feature ? `'${feature}'` : 'calls that name no feature'}. Seed GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY (Required-Inputs §4.6), or change its placement under AI Engine → Where AI is used where that is allowed.`
      );
    }
    // ADR 0034 §6: a task no configured provider can serve fails naming why
    // — the capability no model carries, a retired model, no model for the
    // modality — not with a 500 or "not configured".
    if (uncapable.length > 0 && disabled.length === 0) {
      const capabilities = [...new Set(uncapable.flatMap((r) => r.missing))];
      throw new AiNotConfiguredError(
        `No eligible model carries ${capabilities.map((c) => `'${c}'`).join(', ')} for ${name}: ${uncapable.map((r) => `${r.provider} (${r.why})`).join('; ')}. Enable a provider whose models carry it under AI Engine → AI Services, or name one in the task's chain.`
      );
    }
    if (retired.length > 0 && disabled.length === 0) {
      throw new AiNotConfiguredError(
        `Every eligible model for ${name} is retired in the catalogue (${retired.map((r) => `${r.model} on ${r.provider}`).join(', ')}); pick another under AI Engine → Tasks.`
      );
    }
    if (noModel.length > 0 && disabled.length === 0) {
      throw new AiNotConfiguredError(
        `No provider offers a model for ${name} (${modality}): ${noModel.map((r) => r.provider).join(', ')}. Name one in the task's chain under AI Engine → Tasks, or enable a provider that recommends one.`
      );
    }
    throw new AiNotConfiguredError(
      disabled.length > 0
        ? `Every configured AI provider is disabled in the admin portal (${disabled.join(', ')}). Re-enable one under AI Engine → AI Services.`
        : 'No AI provider is configured. Seed GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in Key Vault (Required-Inputs §4.6) and the matching provider turns on.'
    );
  }

  return chain;
}

/** Rejections a provider earned for the task's sake, not for want of a key or a switch. */
const NOT_USED_CODES = Object.freeze(['excluded', 'policy']);
/** Rejections for want of a model: no capability, retired, or none for the modality. */
const NO_MODEL_CODES = Object.freeze(['capability', 'retired', 'no-model']);

/**
 * The chain and how it was arrived at — the selection behind
 * `providerChain`, kept separate so the grounded path can apply the SAME
 * selection and then say precisely why Gemini is not in it. The empty chain
 * is left to the callers, who have different sentences for it.
 *
 * The decision is the resolver's (select.js, ADR 0034 §3): the selection
 * document (a v1 routing document is migrated in memory by the loader; no
 * document at all is the code defaults), the catalogue, and what holds a
 * key and is switched on. What stays here is the router's own: the feature
 * switch, the key check, and the `CONTENTFORGE_AI_PROVIDER` pin, which is
 * an instruction rather than a preference — it selects one provider from
 * the resolved chain and does NOT fall through to the others, and it cannot
 * add a provider the resolver turned away.
 *
 * @returns {Promise<{chain: Array<{provider: string, model: string|null, selection: string}>,
 *                    disabled: string[], excluded: string[], uncapable: Array<object>,
 *                    retired: Array<object>, noModel: Array<object>, modality: string,
 *                    rejected: Array<object>, flags: string[], pinned: string}>}
 */
async function chainDetails(ctx, feature = null) {
  const { providers: docs, features, selection, catalog } = await ctx.config.load();

  if (feature && !isFeatureEnabled(features, feature)) {
    throw new AiFeatureDisabledError(feature);
  }

  const { keyed, enabled, disabled } = availabilityOf(ctx, docs);
  const selected = selectChain({
    task: feature,
    selection: selection || defaultSelection(),
    catalog,
    availability: { keyed, enabled },
  });
  for (const flag of selected.flags) {
    ctx.log.warn?.(`[ai-router] '${feature || 'no feature'}': ${flag}`);
  }
  // A custom chain step that cannot serve is logged, as a skipped v1 route
  // was: the administrator named it and should see why it did not answer.
  const skipped = selected.rejected.filter((r) => r.selection === 'custom');
  if (skipped.length) {
    ctx.log.warn?.(
      `[ai-router] '${feature}' routes to ${skipped.map((r) => r.provider).join(', ')} but ${
        skipped.length === 1 ? 'it is' : 'they are'
      } not available (${skipped.map((r) => r.why).join('; ')}); serving from ${
        selected.chain[0]?.provider || 'none'
      }`
    );
  }
  // Providers that hold a key and are on, but may not serve this task; and
  // those that may but have no model that carries what it needs. Each is
  // the subject of a different sentence in providerChain.
  const excluded = selected.rejected
    .filter((r) => NOT_USED_CODES.includes(r.code))
    .map((r) => r.provider);
  // The capability sentence is for rejections that name a missing one; a
  // retired model and a provider with no model for the modality each have
  // their own (providerChain).
  const uncapable = selected.rejected.filter((r) => r.code === 'capability' && r.missing?.length);
  const retired = selected.rejected.filter((r) => r.code === 'retired');
  const noModel = selected.rejected.filter((r) => r.code === 'no-model');
  const withoutModel = selected.rejected.filter((r) => NO_MODEL_CODES.includes(r.code));

  const pinned = pinnedProvider(ctx);
  let { chain } = selected;
  if (pinned) {
    if (chain.some((entry) => entry.provider === pinned)) {
      chain = chain.filter((entry) => entry.provider === pinned);
    } else {
      let why = 'its key is not present';
      if (disabled.includes(pinned)) why = 'it is disabled in the admin portal';
      else if (excluded.includes(pinned)) why = `it is not used for '${feature || 'no feature'}'`;
      else if (withoutModel.some((r) => r.provider === pinned)) {
        why = `no model of its carries what '${feature || 'no feature'}' needs`;
      }
      ctx.log.warn?.(
        `[ai-router] CONTENTFORGE_AI_PROVIDER=${pinned} but ${why}; falling back to ${chain[0]?.provider || 'none'}`
      );
    }
  }

  return {
    // A null model is the provider's default for the call's purpose
    // (callWith → modelFor), as the select.js header explains; the model it
    // was judged on and the reason travel for `modelForTask` and the page.
    chain: chain.map(({ provider, model, selection: source, modalityModel, why }) => ({
      provider,
      model,
      selection: source,
      modalityModel: modalityModel ?? null,
      why,
    })),
    disabled,
    excluded,
    uncapable,
    retired,
    noModel,
    modality: (feature && taskFor(feature)?.modality) || UNDECLARED_TASK.modality,
    rejected: selected.rejected,
    flags: selected.flags,
    pinned,
  };
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
 * Every call that reaches a model is recorded in `ai_usage` HERE, once
 * (ADR 0033: "every call site records usage"). Until this, five of fourteen
 * call sites wrote a row and the rest spent invisibly. The row's `source`
 * is the feature (`ai:<feature>`), and its id travels back on the caller's
 * `usageOut` entry as `recordedRowId`, so a caller that re-records the same
 * entry with a more specific source (Listen & Learn, the podcast) UPSERTS
 * the same row instead of adding a second one. With no store (unit tests)
 * nothing is written and the entries still reach the caller.
 */
async function recordCallUsage(ctx, entries, feature) {
  const { store } = ctx;
  if (!store?.upsertDoc) return entries;
  const recorded = [];
  for (const entry of entries) {
    const row = await recordAiUsage(
      { store, ai: { getCostEstimate, isPriced } },
      { ...entry, source: featureSource(feature) }
    );
    recorded.push(row ? { ...entry, recordedRowId: row.id } : entry);
  }
  return recorded;
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
    `[ai-router] ${provider} could not serve this call (${error?.message || error}); trying the next provider`
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

function modelFor(ctx, provider, purpose = 'general') {
  const entry = DEFAULT_MODEL_TABLE[provider];
  if (!entry) return DEFAULT_MODEL_TABLE.gemini.general[1];
  const [envVar, fallback] = entry[purpose] || entry.general;
  return ctx.env[envVar] || fallback;
}

const logUsage = (ctx, provider, usage, model, purpose) => {
  if (ctx.env.CONTENTFORGE_LOG_TOKEN_USAGE === 'true') {
    ctx.log.warn?.(`[ai-model] ${provider} token usage`, {
      ...usage,
      model,
      purpose,
    });
  }
};

async function callAnthropic(
  ctx,
  { prompt, parts, model, purpose, expectJson, systemPrompt, usageOut, timeoutMs, signal }
) {
  const apiKey = readKey(ctx.env, KEY_ENV.anthropic);
  const selectedModel = model || modelFor(ctx, 'anthropic', purpose);
  // A static system prompt is marked for the prompt cache; the JSON-only
  // instruction trails it uncached so the cache boundary stays on the
  // expensive context.
  let system;
  if (systemPrompt) {
    system = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];
    if (expectJson) system.push({ type: 'text', text: JSON_ONLY });
  } else if (expectJson) {
    system = JSON_ONLY;
  }
  const data = await postJson(ctx.fetchImpl, 'https://api.anthropic.com/v1/messages', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: {
      model: selectedModel,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: 'user', content: toAnthropicContent(parts, prompt) }],
      ...(system !== undefined ? { system } : {}),
    },
    // Undefined keeps postJson's CHAT_TIMEOUT_MS.
    timeoutMs,
    signal,
  });
  const usage = data?.usage || {};
  recordUsage(usageOut, 'anthropic', selectedModel, usage.input_tokens, usage.output_tokens);
  logUsage(ctx, 'anthropic', usage, selectedModel, purpose);
  return (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * The OpenAI chat-completions request path, shared by every provider that
 * speaks it. OpenAI and NVIDIA differ only in the rows of this table.
 *
 * NVIDIA's differences, each for a reason: plain-string user content and
 * the JSON rule as an instruction rather than `response_format`, because
 * neither array content nor `json_object` is accepted by every model on the
 * catalogue and an unaccepted field is a 400; an explicit `max_tokens`; a
 * longer timeout; `<think>` stripped from the answer; and a `temperature`,
 * which the GPT-5 rows leave out because those models refuse any value but
 * the default. Built per router because the pacing guard is the router's.
 *
 * Foundry's one difference is `auth`: a row without it sends the provider's
 * key as the bearer; Foundry sends an Entra token, or the api-key header a
 * developer set locally (header: MICROSOFT FOUNDRY). The URL is read when
 * the table is built, so a router built without FOUNDRY_ENDPOINT carries a
 * row it can never be routed to — availability is KEY_ENV's job.
 */
function openAiCompatibleTable(ctx) {
  return {
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      jsonAsResponseFormat: true,
      content: toOpenAiContent,
    },
    foundry: {
      url: `${foundryBaseUrl(ctx.env)}/openai/v1/chat/completions`,
      jsonAsResponseFormat: true,
      content: toOpenAiContent,
      auth: async () => {
        const local = readKey(ctx.env, 'FOUNDRY_API_KEY');
        if (local) return { 'api-key': local };
        return { Authorization: `Bearer ${await ctx.foundryToken()}` };
      },
    },
    nvidia: {
      url: `${NVIDIA_BASE_URL}/chat/completions`,
      jsonAsResponseFormat: false,
      content: toPlainText,
      temperature: 0.2,
      maxTokens: NVIDIA_MAX_TOKENS,
      timeoutMs: NVIDIA_TIMEOUT_MS,
      clean: stripThinking,
      pace: () => {
        if (!ctx.nvidiaPacer.take()) throw pacedError(ctx.nvidiaLimit);
      },
    },
  };
}

async function callOpenAiCompatible(ctx, provider, args) {
  const { purpose, usageOut, timeoutMs, signal } = args;
  const spec = ctx.openAiCompatible[provider];
  const selectedModel = args.model || modelFor(ctx, provider, purpose);
  const body = openAiCompatibleBody(spec, selectedModel, args);
  const headers = spec.auth
    ? await spec.auth()
    : { Authorization: `Bearer ${readKey(ctx.env, KEY_ENV[provider])}` };
  // Last, after every refusal that could still happen locally: a request
  // that is never sent must not spend a slot in the window.
  spec.pace?.();
  const data = await postJson(ctx.fetchImpl, spec.url, {
    headers,
    body,
    ...timeoutArg(timeoutMs ?? spec.timeoutMs),
    signal,
  });
  const usage = data?.usage || {};
  recordUsage(usageOut, provider, selectedModel, usage.prompt_tokens, usage.completion_tokens);
  logUsage(ctx, provider, usage, selectedModel, purpose);
  const text = data?.choices?.[0]?.message?.content || '';
  return spec.clean ? spec.clean(text) : text;
}

/**
 * One chat-completions request body. The system turn carries the JSON rule
 * where the table row cannot send `response_format`; `max_tokens` goes only
 * where the row sends it at all (OpenAI's reasoning models refuse the
 * field), and a caller's cap (the portal's Test) wins over the row's.
 */
function openAiCompatibleBody(spec, model, { prompt, parts, expectJson, systemPrompt, maxTokens }) {
  const messages = [];
  const system =
    expectJson && !spec.jsonAsResponseFormat
      ? [systemPrompt, JSON_ONLY].filter(Boolean).join('\n\n')
      : systemPrompt;
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: spec.content(parts, prompt) });
  return {
    model,
    messages,
    // Only where the row sets one. The GPT-5 family on OpenAI and Foundry
    // accepts the default temperature alone and answers 400 to any other
    // value ("Only the default (1) value is supported", measured 2026-10-04
    // on the Foundry card's Test); NVIDIA's catalogue models take it.
    ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    ...(spec.maxTokens ? { max_tokens: maxTokens ?? spec.maxTokens } : {}),
    ...(expectJson && spec.jsonAsResponseFormat
      ? { response_format: { type: 'json_object' } }
      : {}),
  };
}

/** `{ timeoutMs }` when a limit is set; nothing otherwise, so postJson keeps CHAT_TIMEOUT_MS. */
const timeoutArg = (timeoutMs) => (timeoutMs ? { timeoutMs } : {});

/**
 * A provider's own attempt timeout: its table row's (NVIDIA's 120 s), else
 * CHAT_TIMEOUT_MS. A budgeted call cuts it to the provider's share.
 */
const providerTimeoutMs = (ctx, provider) =>
  ctx.openAiCompatible[provider]?.timeoutMs ?? CHAT_TIMEOUT_MS;

async function callGemini(
  ctx,
  { prompt, parts, model, purpose, expectJson, systemPrompt, usageOut, timeoutMs, signal }
) {
  const apiKey = readKey(ctx.env, KEY_ENV.gemini);
  const selectedModel = model || modelFor(ctx, 'gemini', purpose);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
  const data = await postJson(ctx.fetchImpl, url, {
    headers: { 'x-goog-api-key': apiKey },
    body: {
      contents: [{ role: 'user', parts: toGeminiParts(parts, prompt) }],
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      generationConfig: {
        temperature: 0.2,
        ...(expectJson ? { responseMimeType: 'application/json' } : {}),
      },
    },
    // Undefined keeps postJson's CHAT_TIMEOUT_MS.
    timeoutMs,
    signal,
  });
  const usage = data?.usageMetadata || {};
  // Reasoning tokens bill at the output rate — count them as output.
  const outTokens =
    (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0);
  recordUsage(usageOut, 'gemini', selectedModel, usage.promptTokenCount, outTokens);
  logUsage(ctx, 'gemini', usage, selectedModel, purpose);
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p?.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

const CALLERS = {
  anthropic: callAnthropic,
  openai: (ctx, args) => callOpenAiCompatible(ctx, 'openai', args),
  gemini: callGemini,
  nvidia: (ctx, args) => callOpenAiCompatible(ctx, 'nvidia', args),
  foundry: (ctx, args) => callOpenAiCompatible(ctx, 'foundry', args),
};

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
 * Ground a JSON generation on owner-supplied pages and YouTube videos.
 *
 * Gemini only, through the Interactions endpoint — the header says why. The
 * chain is resolved exactly as for every other call, and then Gemini has to
 * be in it; anything else is `AiNotConfiguredError` with the reason, before
 * a byte is sent. There is no failover and no JSON repair round trip: both
 * would go through the generic chain, which is precisely what this entry
 * point exists to avoid, and JSON mode on this endpoint returns JSON or
 * reports a status other than `completed`.
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {Array<{kind: 'page'|'video', url: string}>} params.sources
 * @param {string} [params.systemPrompt]
 * @param {string} [params.purpose]       Model table purpose; `analysis` by default.
 * @param {string|null} [params.model]    Explicit model; wins over the portal pin.
 * @param {Array|null} [params.usageOut]  Receives one usage row, provider `gemini`.
 * @param {string|null} [params.feature]  A key of AI_FEATURES.
 * @param {AbortSignal} [params.signal]
 */
async function generateGroundedJson(
  ctx,
  {
    prompt = '',
    sources = [],
    systemPrompt = '',
    purpose = 'analysis',
    model = null,
    usageOut = null,
    feature = null,
    signal = null,
  } = {}
) {
  // Validation first: a bad list must not cost a configuration read, and a
  // good list must not be sent when the provider cannot take it.
  const { pages, videos } = validateGroundingSources(sources);

  const { chain, disabled, pinned } = await chainDetails(ctx, feature);
  const gemini = chain.find((entry) => entry.provider === 'gemini');
  if (!gemini) {
    throw new AiNotConfiguredError(
      groundingUnavailable({ available: keyedProviders(ctx), disabled, pinned })
    );
  }

  const selectedModel = model || gemini.model || modelFor(ctx, 'gemini', purpose);
  const selection = model ? 'explicit' : gemini.selection;
  const body = buildGroundedRequest({
    model: selectedModel,
    prompt,
    pages,
    videos,
    systemPrompt,
  });

  const data = await groundedInteraction(ctx, body, { signal });

  // Usage before the status check, so a failed-but-billed interaction is
  // still on the spend page.
  const usage = data?.usage || {};
  const recorded = await recordCallUsage(
    ctx,
    groundedUsageRow(selectedModel, usage).map((row) => ({ ...row, selection })),
    feature
  );
  if (Array.isArray(usageOut)) usageOut.push(...recorded);
  logUsage(ctx, 'gemini', usage, selectedModel, purpose);

  assertGroundedComplete(data);
  return parseJsonWithFallbacks(groundedOutputText(data));
}

/**
 * The usage row of a grounded call. Tool-use tokens are the fetched pages —
 * prompt side; thought tokens bill as output, as on the chat endpoint.
 */
function groundedUsageRow(model, usage) {
  const collected = [];
  recordUsage(
    collected,
    'gemini',
    model,
    (Number(usage.total_input_tokens) || 0) + (Number(usage.total_tool_use_tokens) || 0),
    (Number(usage.total_output_tokens) || 0) + (Number(usage.total_thought_tokens) || 0)
  );
  return collected;
}

/**
 * A grounded generation that was not used, in this module's sentence: the
 * interaction's status, or the sources that could not be read (the URLs the
 * owner chose and Gemini's retrieval status code). Authored (#945), so the
 * episode and the job store it as written; Gemini's own error messages are
 * never part of it.
 */
export class GroundingIncompleteError extends AuthoredError {}

/**
 * A grounded generation is used only when the interaction completed and
 * every source was read; otherwise it would be grounded on less than it
 * claims, and the error says which.
 *
 * @param {object} data - the interaction Gemini answered
 * @returns {void}
 */
function assertGroundedComplete(data) {
  const status = data?.status;
  if (status !== 'completed') {
    const named = codeShaped(status) || 'none';
    // Gemini's error codes, never its messages, which can quote the source.
    const codes = (Array.isArray(data?.errors) ? data.errors : [])
      .map((entry) => codeShaped(entry?.code))
      .filter(Boolean);
    const note = codes.length ? ` (error code ${codes.join(', ')})` : '';
    throw new GroundingIncompleteError(
      `Gemini reported status '${named}' for the grounded call, not 'completed'${note}.`,
      { code: 'AI_GROUNDING_INCOMPLETE' }
    );
  }
  const unread = failedRetrievals(data);
  if (unread.length) {
    throw new GroundingIncompleteError(
      `Gemini could not read ${unread.length === 1 ? 'a source' : `${unread.length} sources`} — ${unread.join(', ')}. The generation was not used, because it would be grounded on less than it claims.`,
      { code: 'AI_GROUNDING_INCOMPLETE' }
    );
  }
}

/**
 * The grounded call itself, with the key verdict it reports. Same rule as
 * callWithFailover: 401/403 only, and then the call fails here — there is
 * nothing to hand on to.
 */
async function groundedInteraction(ctx, body, { signal } = {}) {
  let data;
  try {
    data = await withRetry(ctx.clock, () =>
      postJson(ctx.fetchImpl, INTERACTIONS_URL, {
        headers: { 'x-goog-api-key': readKey(ctx.env, KEY_ENV.gemini) },
        body,
        timeoutMs: GROUNDED_TIMEOUT_MS,
        signal,
      })
    );
  } catch (error) {
    const status = Number(error?.status);
    if ([401, 403].includes(status)) await ctx.reportKeyVerdict('gemini', { ok: false, status });
    throw error;
  }
  await ctx.reportKeyVerdict('gemini', { ok: true });
  return data;
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
