/**
 * router-callers.js — one caller per provider API for the AI router
 * (router.js): Anthropic, the OpenAI-compatible family and Gemini, each
 * turning a call into its request and its answer into text and usage.
 */
import { DEFAULT_MODEL_TABLE, isPriced } from './model-tables.js';
import { KEY_ENV } from './router-base.js';
import { JSON_ONLY, getCostEstimate, readKey } from './router-base.js';
import {
  CHAT_TIMEOUT_MS,
  NVIDIA_BASE_URL,
  NVIDIA_MAX_TOKENS,
  NVIDIA_TIMEOUT_MS,
  foundryBaseUrl,
  pacedError,
  postJson,
  stripThinking,
} from './router-transport.js';
import {
  toAnthropicContent,
  toGeminiParts,
  toOpenAiContent,
  toPlainText,
} from './router-parts.js';

export function recordUsage(usageOut, provider, model, promptTokens, completionTokens) {
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

export function modelFor(ctx, provider, purpose = 'general') {
  const entry = DEFAULT_MODEL_TABLE[provider];
  if (!entry) return DEFAULT_MODEL_TABLE.gemini.general[1];
  const [envVar, fallback] = entry[purpose] || entry.general;
  return ctx.env[envVar] || fallback;
}

export const logUsage = (ctx, provider, usage, model, purpose) => {
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
export function openAiCompatibleTable(ctx) {
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
export const providerTimeoutMs = (ctx, provider) =>
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

export const CALLERS = {
  anthropic: callAnthropic,
  openai: (ctx, args) => callOpenAiCompatible(ctx, 'openai', args),
  gemini: callGemini,
  nvidia: (ctx, args) => callOpenAiCompatible(ctx, 'nvidia', args),
  foundry: (ctx, args) => callOpenAiCompatible(ctx, 'foundry', args),
};
