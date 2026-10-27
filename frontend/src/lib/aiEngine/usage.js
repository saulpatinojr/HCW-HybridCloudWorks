/**
 * AI Engine — usage records and their totals. Imported through
 * `@/lib/aiEngine`, which re-exports it.
 */
import { getJSON } from '@/lib/api';

/** Fetch usage records. Returns last `limitN` records ordered by timestamp desc. */
export async function getUsageRecords(limitN = 100, startAfterDate = null) {
  const params = new URLSearchParams({ limit: String(limitN) });
  if (startAfterDate) {
    const since = startAfterDate instanceof Date ? startAfterDate.toISOString() : startAfterDate;
    params.set('since', since);
  }
  const res = await getJSON(`cms/ai-usage?${params.toString()}`);
  return res.items || [];
}

/** Aggregate usage by provider. Returns { provider: { tokens, costUsd, calls } } */
export function aggregateByProvider(records) {
  return aggregateBy(records, (r) => r.provider);
}

/**
 * The same totals grouped by what SPENT the money rather than who was paid.
 *
 * `provider` answers "which vendor" — useful when several are enabled, useless
 * when one vendor serves several features. `source` is what the usage writer
 * stamps (ai/usage.js USAGE_SOURCES): admin playground calls, Listen & Learn
 * scripts, Listen & Learn audio. Audio is priced on an output rate an order of
 * magnitude above text, so a run's cost is dominated by one of these and
 * grouping by provider alone hides which.
 */
export function aggregateBySource(records) {
  return aggregateBy(records, (r) => r.source || 'admin');
}

/** Missing and unpriced costs cannot be included in a confirmed subtotal. */
export function hasKnownCost(record) {
  return (
    record?.unpriced !== true &&
    Number.isFinite(record?.estimatedCostUsd) &&
    record.estimatedCostUsd >= 0
  );
}

function aggregateBy(records, keyOf) {
  const agg = {};
  for (const r of records) {
    const key = keyOf(r);
    if (!agg[key]) agg[key] = { tokens: 0, costUsd: 0, calls: 0, estimated: 0, unpriced: 0 };
    agg[key].tokens += r.totalTokens || 0;
    if (hasKnownCost(r)) agg[key].costUsd += r.estimatedCostUsd;
    agg[key].calls += 1;
    // Rows whose token counts were derived rather than reported by the API.
    // Surfaced so a derived figure is never shown as a billed one.
    if (r.estimatedTokens) agg[key].estimated += 1;
    // Rows for a model the cost table has no rate for (ADR 0033): they cost
    // $0 here, and the page says so rather than letting zero read as free.
    if (!hasKnownCost(r)) agg[key].unpriced += 1;
  }
  return agg;
}
