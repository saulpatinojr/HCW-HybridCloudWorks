/**
 * The public reads and the one public POST behind the cloud tools pages:
 * cached prices, price changes and the AI explanations. Split out of
 * publicApi.js, which re-exports everything here.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';
import { fetchPublicJSON, publicGet } from './publicApiGet';

/**
 * GET public/cloud-tools/pricing?region= — the cached price comparison for one
 * region (#613, Phase 1): `{ region, regions, refreshedAt, ttlMinutes,
 * ageMinutes, stale, counts, services }`, where each service carries one row
 * per provider that answered and a provider missing from `rows` is
 * "unavailable". Read by /tools/comparison and by the Integrations Hub's
 * "Cloud pricing cache" card.
 *
 * Throws on failure like `fetchPublicSnapshot`, so the page can show the
 * server's sentence — an unknown region is a 400 with one. A cache that has
 * never been filled is NOT a failure: the server answers 200 with
 * `refreshedAt: null` and no services, and the page renders that as its own
 * state. Returns null only when the route itself is missing (404).
 *
 * `fresh` is the same escape hatch `fetchPublicSnapshot` has, and it exists
 * for the same reason: the route answers with `Cache-Control: max-age=900`,
 * so after "Refresh now" the card would otherwise read the browser's copy
 * from before the refresh for up to fifteen minutes. The throwaway query
 * value defeats that cache and this module's; the route ignores it.
 *
 * @param {string} [region]
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function fetchCloudPricing(region = 'us-east-1', { fresh = false } = {}) {
  const params = new URLSearchParams({ region: String(region || 'us-east-1') });
  if (fresh) params.set('fresh', String(Date.now()));
  const path = `public/cloud-tools/pricing?${params}`;
  const body = fresh ? await fetchPublicJSON(path) : await publicGet(path);
  if (!body) return null;
  if (!body.pricing || typeof body.pricing !== 'object') {
    throw new Error('Pricing response carried no pricing object');
  }
  return body.pricing;
}

/**
 * GET public/cloud-tools/price-changes?region= — what moved in the cached
 * prices of one region over the last week and month (#613, Phase 3):
 * `{ region, asOf, windows: { '7d': { since, sampleDay, items }, '30d': {…} },
 * sampleDays }`, each item `{ serviceId, label, provider, unit, sku, from,
 * to, deltaPct }` sorted by the size of the move. Until the daily refresh has
 * written more than one sample there is no history: the server answers 200
 * with `asOf: null` and empty windows, and the page renders that as its own
 * state. Returns null only when the route itself is missing (404); throws
 * with the server's sentence otherwise, as `fetchCloudPricing` does.
 *
 * @param {string} [region]
 * @returns {Promise<object|null>}
 */
export async function fetchPriceChanges(region = 'us-east-1') {
  const params = new URLSearchParams({ region: String(region || 'us-east-1') });
  const body = await publicGet(`public/cloud-tools/price-changes?${params}`);
  if (!body) return null;
  if (!body.changes || typeof body.changes !== 'object') {
    throw new Error('Price-changes response carried no changes object');
  }
  return body.changes;
}

/**
 * POST public/cloud-tools/explain — two paragraphs from the AI provider about
 * a scenario's numbers (#613, Phase 3). The body is the computed comparison
 * the page already shows: `{ region, scenarioId, scenarioLabel, extras,
 * egressGb, results: [{ provider, total, base, segments, unavailable }] }`;
 * the server caps it at 8 KB and answers `{ text, generatedAt, cached }`.
 *
 * Never cached here and never deduplicated: it is a POST the reader asked for
 * by pressing a button, and the server owns both the per-client quota (429,
 * five an hour) and the "paused" and "unavailable" states (503). The thrown
 * Error carries `status` and the response's `code`, and
 * pages/tools/explain/ExplainControl.jsx picks the visitor's sentence from
 * those; the server's own text is never shown.
 *
 * @param {object} body
 * @returns {Promise<{ text: string, generatedAt: string, cached: boolean }>}
 */
export async function requestPricingExplanation(body) {
  return postExplanation(body);
}

/**
 * POST public/cloud-tools/explain with `kind: "landing-zone"` — two
 * paragraphs about one component of a landing zone build (#670, Phase 4 of
 * #657). The body is what the server's `kinds/landingZone.js` validates:
 * `{ kind, componentId, selected, options, teaches }`, built by
 * pages/tools/landingZone/LzExplainButton.jsx from the page's own state and
 * catalogue text. Same route, same quota, same responses and the same error
 * mapping as `requestPricingExplanation`; the `kind` in the body is what
 * tells the two apart.
 *
 * @param {object} body
 * @returns {Promise<{ text: string, generatedAt: string, cached: boolean }>}
 */
export async function requestLandingZoneExplanation(body) {
  return postExplanation(body);
}

/** The one call both explanation kinds make; the body carries the kind. */
async function postExplanation(body) {
  const base = requireFunctionsBase('public/cloud-tools/explain');
  const res = await fetch(`${base}/public/cloud-tools/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Explanation request failed with HTTP ${res.status}`);
    error.status = res.status;
    error.code = typeof data.code === 'string' ? data.code : null;
    throw error;
  }
  if (!data.explanation || typeof data.explanation.text !== 'string') {
    throw new Error('Explanation response carried no text');
  }
  return data.explanation;
}
