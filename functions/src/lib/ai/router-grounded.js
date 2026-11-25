/**
 * router-grounded.js — the grounded generation of the AI router (router.js):
 * a JSON answer grounded on pages and YouTube through the Gemini
 * Interactions API, its usage row, and the check that every source was
 * actually read; and recordCallUsage, the one place every model call is
 * recorded in `ai_usage`, which the grounded path and router.js share.
 */
import { AuthoredError, codeShaped } from '../http/error-response.js';
import { featureSource, recordAiUsage } from './usage.js';
import { isPriced } from './model-tables.js';
import {
  GROUNDED_TIMEOUT_MS,
  INTERACTIONS_URL,
  buildGroundedRequest,
  failedRetrievals,
  groundedOutputText,
  groundingUnavailable,
  validateGroundingSources,
} from './grounding.js';
import { KEY_ENV } from './router-base.js';
import {
  AiNotConfiguredError,
  getCostEstimate,
  parseJsonWithFallbacks,
  readKey,
} from './router-base.js';
import { postJson, withRetry } from './router-transport.js';
import { chainDetails, keyedProviders } from './router-chain.js';
import { recordUsage } from './router-callers.js';
import { logUsage, modelFor } from './router-callers.js';

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
export async function recordCallUsage(ctx, entries, feature) {
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
export async function generateGroundedJson(
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
