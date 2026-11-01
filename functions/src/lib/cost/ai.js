/**
 * cost/ai.js — what the site's AI has cost this month (ADR 0039), from the
 * three places that know:
 *
 *   - `ai_usage`, the ledger every model call writes a row to (ai/usage.js):
 *     an ESTIMATE from the cost table, never a provider invoice. Read for the
 *     month so far and for last month, grouped by provider and by what spent
 *     it (`source`).
 *   - ElevenLabs, which says how many credits the plan has left
 *     (listen-and-learn/speech/elevenlabs-account.js readSubscription).
 *   - The app's own image budget for Replicate (CONTENTFORGE_IMAGE_* in
 *     infra/functionapp.tf, enforced in triggers/ai-cover.js).
 *
 * Microsoft Foundry is billed by Azure and has its own resource-group budget,
 * so its card points at the Azure scope that carries it rather than reading
 * anything twice. Google, Anthropic, OpenAI and NVIDIA expose no balance to an
 * ordinary API key, so their cards show the ledger's estimate and say so.
 *
 * Every read here degrades on its own: ElevenLabs failing leaves the ledger
 * figures standing, and the card says what could not be read.
 */
import { USAGE_CONTAINER } from '../ai/usage.js';
import { storedFailure } from '../http/error-response.js';
import { readKey, KEYLESS_PROVIDERS } from '../ai/router.js';
import { IMAGE_PROVIDER } from '../triggers/ai-cover.js';
import { readSubscription } from '../listen-and-learn/speech/elevenlabs-account.js';
import { money, monthOf, percent, previousMonthOf } from './model.js';

/** The provider cards, in the order the page shows them. */
export const PROVIDER_CARDS = Object.freeze([
  { id: 'foundry', label: 'Microsoft Foundry (Azure)', kind: 'azure-budget', scopeId: 'foundry' },
  { id: 'elevenlabs', label: 'ElevenLabs', kind: 'credits', setting: 'ELEVENLABS_API_KEY' },
  { id: 'replicate', label: 'Replicate (images)', kind: 'budget', setting: 'REPLICATE_API_KEY' },
  { id: 'gemini', label: 'Google Gemini', kind: 'ledger', setting: 'GEMINI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', kind: 'ledger', setting: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', kind: 'ledger', setting: 'OPENAI_API_KEY' },
  { id: 'nvidia', label: 'NVIDIA API', kind: 'free', setting: 'NVIDIA_API_KEY' },
]);

export const LEDGER_NOTE = 'This provider exposes no balance to the site; the figure is the site’s own estimate from its usage ledger.';
export const FOUNDRY_NOTE = 'Billed by Azure. Its resource-group budget is on the Azure tab.';
export const FREE_NOTE = 'Free, rate-limited tier: it bills nothing.';
export const IMAGE_COUNT_DEFAULT = 200;

/** First instant of `month` (YYYY-MM) and of the month after, as ISO. */
export function monthBounds(month) {
  const [y, m] = String(month).split('-').map(Number);
  return {
    since: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    until: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}

const hasKnownCost = (row) => row?.unpriced !== true && Number.isFinite(Number(row?.estimatedCostUsd));

/**
 * The ledger's rows for a month, totalled and grouped. Pure over the rows.
 *
 * @returns {{ costUsd: number, calls: number, unpricedCalls: number, tokens: number, byProvider: object[], bySource: object[] }}
 */
export function aggregateUsage(rows) {
  const byProvider = new Map();
  const bySource = new Map();
  let costUsd = 0;
  let unpricedCalls = 0;
  let tokens = 0;
  const add = (map, key) => {
    if (!map.has(key)) map.set(key, { costUsd: 0, calls: 0, tokens: 0, unpricedCalls: 0 });
    return map.get(key);
  };
  for (const row of rows || []) {
    const priced = hasKnownCost(row);
    const cost = priced ? Number(row.estimatedCostUsd) : 0;
    const rowTokens = Number(row?.totalTokens) || 0;
    costUsd += cost;
    tokens += rowTokens;
    if (!priced) unpricedCalls += 1;
    for (const [map, key] of [
      [byProvider, String(row?.provider || 'unknown')],
      [bySource, String(row?.source || 'ai:unspecified')],
    ]) {
      const bucket = add(map, key);
      bucket.costUsd += cost;
      bucket.calls += 1;
      bucket.tokens += rowTokens;
      if (!priced) bucket.unpricedCalls += 1;
    }
  }
  const present = (map, key) =>
    [...map.entries()]
      .map(([name, bucket]) => ({ [key]: name, ...bucket, costUsd: money(bucket.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a[key].localeCompare(b[key]));
  return {
    costUsd: money(costUsd),
    calls: (rows || []).length,
    unpricedCalls,
    tokens,
    byProvider: present(byProvider, 'provider'),
    bySource: present(bySource, 'source'),
  };
}

/** The fields one month's aggregation needs; the row's text fields never leave the store. */
const USAGE_QUERY =
  'SELECT c.provider, c.source, c.estimatedCostUsd, c.unpriced, c.totalTokens FROM c WHERE c.timestamp >= @since AND c.timestamp < @until';

async function readMonth(store, month) {
  const { since, until } = monthBounds(month);
  return store.queryDocs(USAGE_CONTAINER, USAGE_QUERY, [
    { name: '@since', value: since },
    { name: '@until', value: until },
  ]);
}

/** The image budget as the generators read it (triggers/ai-cover.js), from the environment. */
export function imageBudgetFrom(env) {
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const cost = Number(env?.CONTENTFORGE_IMAGE_COST_USD);
  return {
    unitCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    budget: positive(env?.CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD, 10),
    maxImages: positive(env?.CONTENTFORGE_IMAGE_MONTHLY_MAX, IMAGE_COUNT_DEFAULT),
  };
}

/**
 * The ElevenLabs card's figures, or `{ error }` when the account could not be
 * read. Reads nothing when the key is not configured.
 */
export async function readCredits({ env, fetchImpl, now }) {
  const key = readKey(env, 'ELEVENLABS_API_KEY');
  if (!key) return { configured: false, error: null };
  try {
    const sub = await readSubscription({ key, fetchImpl, now: () => now().getTime(), useCache: false });
    return {
      configured: true,
      plan: sub.tier,
      planStatus: sub.status,
      used: sub.creditsUsed,
      limit: sub.creditLimit,
      left: sub.creditsLeft,
      percentLeft: percent(sub.creditsLeft, sub.creditLimit),
      resetAt: sub.resetAt,
      error: null,
    };
  } catch (error) {
    // readSubscription's sentences are authored (elevenlabs-account.js, #945), so the door keeps them.
    return { configured: true, error: storedFailure(error, 'Could not read the ElevenLabs subscription.') };
  }
}

/**
 * The AI section of the snapshot.
 *
 * @param {object} deps
 * @param {{ queryDocs: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 * @param {() => Date} [deps.now]
 * @param {Function} [deps.readCreditsImpl] test seam
 * @param {number|null} [deps.budgetUsd] the page's AI budget setting
 * @returns {Promise<{ ai: object, sources: object[] }>}
 */
export async function readAiCosts({
  store,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  readCreditsImpl = readCredits,
  budgetUsd = null,
}) {
  const at = now();
  const month = monthOf(at);
  const sources = [];
  let monthToDate = aggregateUsage([]);
  let previousMonth = null;
  try {
    const [thisMonth, lastMonth] = await Promise.all([
      readMonth(store, month),
      readMonth(store, previousMonthOf(month)),
    ]);
    monthToDate = aggregateUsage(thisMonth);
    const last = aggregateUsage(lastMonth);
    previousMonth = { costUsd: last.costUsd, calls: last.calls };
    sources.push({ id: 'ai-ledger', ok: true, error: null, readAt: at.toISOString() });
  } catch (error) {
    sources.push({
      id: 'ai-ledger',
      ok: false,
      error: `The AI usage ledger could not be read (${error?.code ?? 'error'}).`,
      readAt: at.toISOString(),
    });
  }

  const credits = await readCreditsImpl({ env, fetchImpl, now });
  sources.push({
    id: 'elevenlabs',
    ok: credits.error === null,
    error: credits.error,
    readAt: at.toISOString(),
    ...(credits.configured ? {} : { skipped: 'ELEVENLABS_API_KEY is not configured' }),
  });

  const image = imageBudgetFrom(env);
  const byProvider = new Map(monthToDate.byProvider.map((row) => [row.provider, row]));
  const ledgerRow = (id) => byProvider.get(id) ?? { costUsd: 0, calls: 0, tokens: 0, unpricedCalls: 0 };

  const providers = PROVIDER_CARDS.map((card) => {
    const row = ledgerRow(card.id);
    const configured = card.setting ? readKey(env, card.setting) !== '' : KEYLESS_PROVIDERS.includes(card.id);
    const base = {
      id: card.id,
      label: card.label,
      kind: card.kind,
      configured,
      monthToDate: row.costUsd,
      calls: row.calls,
    };
    switch (card.kind) {
      case 'azure-budget':
        // Figures come from the Azure scope with this id (snapshot.js fills them in).
        return { ...base, scopeId: card.scopeId, budget: null, forecast: null, note: FOUNDRY_NOTE };
      case 'credits':
        return {
          ...base,
          plan: credits.plan ?? null,
          planStatus: credits.planStatus ?? null,
          used: credits.used ?? null,
          limit: credits.limit ?? null,
          left: credits.left ?? null,
          percentLeft: credits.percentLeft ?? null,
          resetAt: credits.resetAt ?? null,
          error: credits.error,
        };
      case 'budget':
        return {
          ...base,
          budget: image.budget,
          images: ledgerRow(IMAGE_PROVIDER).calls,
          maxImages: image.maxImages,
          unitCostUsd: image.unitCostUsd,
          percentUsed: percent(row.costUsd, image.budget),
        };
      case 'free':
        return { ...base, note: FREE_NOTE };
      default:
        return { ...base, note: LEDGER_NOTE };
    }
  });

  return {
    ai: { monthToDate, previousMonth, budgetUsd, providers },
    sources,
  };
}
