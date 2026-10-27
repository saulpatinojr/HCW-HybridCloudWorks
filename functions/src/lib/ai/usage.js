/**
 * One writer for `ai_usage`, the container the portal's Usage tab reads.
 *
 * Extracted from ai/proxy.js when Listen & Learn became the second thing that
 * spends money on a model. The reason it is shared rather than copied: that
 * page does its arithmetic client-side over whatever rows it finds, totalling
 * `totalTokens` and `estimatedCostUsd` and grouping by `provider`. A second
 * writer with a slightly different shape does not error — it silently totals
 * zero and the spend it represents simply does not appear.
 *
 * A failure here must never fail the call that produced it. The model has
 * already answered and already been paid for; losing the record is strictly
 * better than losing the work.
 */

import { isPriced as modelIsPriced } from './model-tables.js';

export const USAGE_CONTAINER = 'ai_usage';

/**
 * `source` says which part of the site spent the money. The Usage tab groups by
 * it, so these are effectively a public enum — add a value here rather than
 * inventing one at a call site, or the breakdown grows a row nobody recognises.
 */
export const USAGE_SOURCES = Object.freeze({
  admin: 'admin',
  listenAndLearnScript: 'listen-and-learn:script',
  // A source-grounded episode's script (#433): Gemini reading the owner's
  // pages and videos, billed as input. Its own row so the cost of grounding
  // on sources is attributable apart from the guide-grounded scripts; the
  // audio half is the same row as every other episode's.
  listenAndLearnSourceScript: 'listen-and-learn:source-script',
  listenAndLearnAudio: 'listen-and-learn:audio',
  // The podcast's own pipeline (#432): a transcript scripted from a published
  // article (#435) and the audio read from it. Its own rows, not Listen &
  // Learn's, so the cost of each product is attributable on its own.
  podcastScript: 'podcast:script',
  podcastAudio: 'podcast:audio',
  // The ElevenLabs live check on the Audio tab (#432, 2026-09-26): a fixed
  // two-turn sample of under 300 characters. Its own row so a check never
  // reads as episode spend.
  podcastSample: 'podcast:sample',
  // The AI Engine's Test button (#180): a one-word prompt capped at 16
  // tokens. The slug predates this table (proxy.js wrote it inline), and
  // stored rows carry it, so it is registered as it was written.
  adminTest: 'admin_test',
  // The same Test, run by the weekly probeAiProviders timer against every
  // provider with a key (#701, 2026-09-29). Its own row so the check's
  // spend, a fraction of a cent a week, is not read as someone testing.
  aiProviderProbe: 'ai-engine:probe',
  // The Tasks tab's per-task Test (ADR 0034 slice 4, #859): the same
  // one-word prompt and caps, sent down a task's effective chain until one
  // candidate answers. Its own row so a check of the routing never reads as
  // the task's own spend.
  aiTaskTest: 'ai-engine:task-test',
  // Replicate image generation (2026-10-05): one row per output image,
  // priced per image (CONTENTFORGE_IMAGE_COST_USD) rather than per token,
  // because Replicate bills on its own account where no Azure budget can
  // see it. Covers the change feed writes and images made by hand on the
  // Images pages are two rows, so each product's spend is attributable.
  imageCover: 'images:cover',
  imageManual: 'images:manual',
  // A router call whose call site named no feature (ADR 0033). The call-sites
  // test keeps this from happening in production code; the row exists so a
  // call that somehow slips through is still visible rather than unrecorded.
  aiUnspecified: 'ai:unspecified',
});

/**
 * The `source` the router stamps on the row it writes for every call
 * (router.js recordCallUsage): `ai:<feature>`, the feature being the one the
 * call site declared. The Usage tab turns the prefix into the feature's
 * catalogue label, so no new USAGE_SOURCES entry is needed per feature.
 */
export const FEATURE_SOURCE_PREFIX = 'ai:';

/**
 * Since ADR 0034 slice 5 (#860) the audio and image rows carry this too:
 * `ai:listenAndLearnSpeech`, `ai:podcastVoice`, `ai:coverArt`,
 * `ai:manualImages` — so the Usage tab groups them by task beside the text
 * tasks — and their old slug (USAGE_SOURCES.podcastAudio and friends)
 * travels as `product`. The sample row (podcast:sample) and the Test rows
 * keep their own sources: a check is not the task's spend.
 */
export function featureSource(feature) {
  const name = String(feature || '').trim();
  return name ? `${FEATURE_SOURCE_PREFIX}${name}` : USAGE_SOURCES.aiUnspecified;
}

/**
 * Write one usage row.
 *
 * @param {object} deps
 * @param {{ upsertDoc: Function }} deps.store
 * @param {{ getCostEstimate: Function }} deps.ai
 * @param {() => string} [deps.uuid]
 * @param {() => Date} [deps.now]
 * @param {object} record
 * @param {string} record.provider
 * @param {string} record.model
 * @param {number} record.promptTokens
 * @param {number} record.completionTokens
 * @param {string} [record.source]
 * @param {number} [record.costUsd] a cost the caller already computed
 * @param {boolean} [record.estimatedTokens] true when the counts are derived
 *   rather than reported by the API
 * @param {string} [record.recordedRowId] the id of the row the router already
 *   wrote for this call (router.js recordCallUsage). The write then REPLACES
 *   that row — same id, this caller's `source` — so a call recorded by the
 *   router and again by its caller is one row, not two (ADR 0033).
 * @param {boolean} [record.unpriced] true when the cost table has no rate
 *   for the model; the row then costs 0 and says so, instead of a default
 *   rate posing as a figure
 * @param {string} [record.selection] how the resolver chose the candidate
 *   that served (ADR 0034 §3): `explicit`, `recommended`, `custom` or
 *   `global`; absent on rows from before the resolver and on callers that
 *   name a provider themselves
 * @param {string} [record.product] the more specific slug a media row
 *   carried as its `source` before ADR 0034 slice 5 (#860) — `podcast:audio`,
 *   `listen-and-learn:audio`, `images:cover`, `images:manual` — kept beside
 *   the task source so the audio pages and the ElevenLabs card can still
 *   find their own rows while the Usage tab groups by task
 * @returns {Promise<object|null>} the row written, or null if the write failed
 */
export async function recordAiUsage(
  { store, ai, uuid = () => crypto.randomUUID(), now = () => new Date() },
  {
    provider,
    model,
    promptTokens = 0,
    completionTokens = 0,
    source,
    costUsd,
    estimatedTokens,
    recordedRowId,
    unpriced,
    selection,
    product,
  }
) {
  // Everything is inside the try, including building the row. Pricing it calls
  // into the cost table, and an earlier version did that outside — so a caller
  // that passed an `ai` without `getCostEstimate` threw a TypeError that
  // propagated out and failed the episode whose cost it was trying to record.
  // Bookkeeping must not be able to destroy the work it is bookkeeping.
  try {
    const inTokens = Number(promptTokens) || 0;
    const outTokens = Number(completionTokens) || 0;
    const explicitCost = Number.isFinite(costUsd) && costUsd >= 0;
    const isUnpriced = unpriced === true ||
      (!explicitCost && !(ai?.isPriced || modelIsPriced)(provider, model));

    const row = {
      id: typeof recordedRowId === 'string' && recordedRowId ? recordedRowId : uuid(),
      provider,
      model,
      promptTokens: inTokens,
      completionTokens: outTokens,
      totalTokens: inTokens + outTokens,
      estimatedCostUsd: isUnpriced
        ? 0
        : explicitCost
          ? costUsd
          : ai.getCostEstimate(provider, model, inTokens, outTokens),
      source: source || USAGE_SOURCES.admin,
      // Only ever true, never false: an absent flag reads as "reported", which
      // is what every historical row is.
      ...(estimatedTokens ? { estimatedTokens: true } : {}),
      ...(isUnpriced ? { unpriced: true } : {}),
      ...(typeof selection === 'string' && selection ? { selection } : {}),
      ...(typeof product === 'string' && product ? { product } : {}),
      timestamp: now().toISOString(),
    };

    await store.upsertDoc(USAGE_CONTAINER, row);
    return row;
  } catch {
    // Intentionally swallowed — see the module header.
    return null;
  }
}

/**
 * Write several rows, returning what was actually written.
 *
 * Sequential rather than parallel: these are small writes on a path that has
 * just spent minutes on model calls, and a burst against one container is the
 * reliable way to meet a 429 on the cheapest part of the run.
 */
export async function recordAiUsageBatch(deps, records = []) {
  const written = [];
  for (const record of records) {
    const row = await recordAiUsage(deps, record);
    if (row) written.push(row);
  }
  return written;
}

/** Total estimated spend across rows, for reporting a run's cost back. */
export function totalCostUsd(rows = []) {
  return parseFloat(rows.reduce((sum, r) => sum + (r?.estimatedCostUsd || 0), 0).toFixed(6));
}

/**
 * One provider's spend and row count since the first of the current month
 * (UTC), from `ai_usage`. The image budget reads it before every generation
 * (triggers/ai-cover.js). A read that fails is the caller's to treat as
 * "unknown" rather than "zero" or "blocked"; this function only throws.
 *
 * @returns {Promise<{since: string, count: number, costUsd: number}>}
 */
export async function monthToDateUsage({ store, now = () => new Date() }, provider) {
  const start = new Date(now());
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const since = start.toISOString();
  const rows = await store.queryDocs(
    USAGE_CONTAINER,
    'SELECT c.estimatedCostUsd FROM c WHERE c.provider = @provider AND c.timestamp >= @since',
    [
      { name: '@provider', value: provider },
      { name: '@since', value: since },
    ]
  );
  return { since, count: rows.length, costUsd: totalCostUsd(rows) };
}
