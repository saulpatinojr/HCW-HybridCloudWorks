/**
 * The scheduled pricing refresh — the writer of `tool_service_cache` (#613).
 *
 * This is the job the freshness RCA in freshness.js was waiting for: that
 * module reports staleness and explicitly refuses to refresh on the request
 * path, so something has to. This is it. One document per region option, the
 * whole catalog in each, rewritten wholesale every run: the document is the
 * unit of freshness, so a half-updated document is not a state that exists.
 *
 * Two shapes of caution, both deliberate:
 *
 *   - **Services are fetched one at a time**, not fanned out. Each
 *     `fetchLivePricing` call already runs its three providers in parallel;
 *     three regions by eight services on top of that is 72 concurrent calls
 *     against two APIs that rate-limit (AWS GetProducts, Azure Retail
 *     Prices) and one that pages 5,000 SKUs at a time. Sequential is slower
 *     by a minute and never throttled. The job's timeout is sized for it.
 *   - **A region failing does not stop the others.** The failure is logged,
 *     recorded in the summary, and the loop continues, so an Azure outage in
 *     one region cannot leave every region's document a day older than it
 *     needs to be. Inside a region the library already isolates providers;
 *     this is the same rule one level up.
 *
 * The baseline handed to the library is `fallbackBaselineFor`, not
 * `baselineFor`: the two unit-mismatched services get null and a live miss
 * for them is an absent row (owner decision 2026-09-15, baseline.js header).
 *
 * After the cache document, and only after it, each region also gets a
 * history snapshot and a price-change document (history.js, #613 Phase 3).
 * Those are second-class on purpose: a failure there is logged and recorded
 * in `summary.failed` as `history: …`, and the region still counts as
 * refreshed, because the page's prices were already written and a feed of
 * changes is not worth a day of stale prices.
 */

import { fetchLivePricing as liveFetch, clearPricingCaches } from './pricing/index.js';
import { BASELINE_COSTS, PROVIDERS, fallbackBaselineFor } from './pricing/baseline.js';
import { REGION_OPTIONS, SERVICE_LABELS, pricingDocId, regionOption } from './pricing/regions.js';
import { DEFAULT_CACHE_TTL_MINUTES } from './freshness.js';
import { recordedFailure } from '../http/error-response.js';
import {
  CACHE_CONTAINER,
  HISTORY_CONTAINER,
  buildHistoryDoc,
  computePriceChanges,
} from './history.js';

export { CACHE_CONTAINER, HISTORY_CONTAINER };
export const REFRESH_JOB_TYPE = 'refresh-tool-pricing';

/**
 * Validate a `{ regions? }` job payload against the region options.
 *
 * Absent or empty means every region. Anything else must be an array of
 * known ids: a typo is refused rather than silently refreshing nothing, for
 * the same reason `enabled_timers` validates its names — a run that reports
 * success over an empty list is the expensive kind of wrong.
 *
 * @param {unknown} payload
 * @returns {{ regions: string[] }}
 */
export function parseRefreshPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload.regions : undefined;
  if (raw === undefined || raw === null) return { regions: REGION_OPTIONS.map((r) => r.id) };
  if (!Array.isArray(raw)) throw new Error('payload.regions must be an array of region ids');
  if (raw.length === 0) return { regions: REGION_OPTIONS.map((r) => r.id) };
  const unknown = raw.filter((id) => !regionOption(id));
  if (unknown.length) {
    throw new Error(
      `unknown region(s): ${unknown.map(String).join(', ')} — allowed: ${REGION_OPTIONS.map((r) => r.id).join(', ')}`
    );
  }
  return { regions: [...new Set(raw)] };
}

/**
 * Count the cells one service's rows fill, and the cells they leave empty.
 * `unavailable` is a provider with no row at all — a live miss on a service
 * that has no fallback, which after the 2026-09-15 decision is a state the
 * page is expected to render.
 */
function countRows(rows) {
  let live = 0;
  let baseline = 0;
  for (const row of rows) {
    if (row.model === 'retail') live += 1;
    else baseline += 1;
  }
  return { live, baseline, unavailable: PROVIDERS.length - rows.length };
}

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function, readDoc: Function }} deps.store - `readDoc`
 *   is the history lookup's; the cache write needs only `upsertDoc`
 * @param {typeof liveFetch} [deps.fetchLivePricing] - test seam
 * @param {() => void} [deps.clearCaches] - test seam; defaults to the library's
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 */
export function createPricingRefresh({
  store,
  fetchLivePricing = liveFetch,
  clearCaches = clearPricingCaches,
  now = () => new Date(),
  log = {},
  signal: defaultSignal,
}) {
  /** Build and write one region's document. */
  async function refreshRegion(regionId, { signal: callSignal } = {}) {
    const activeSignal = callSignal || defaultSignal;
    const region = regionOption(regionId);
    if (!region) throw new Error(`unknown region ${regionId}`);

    const services = [];
    const counts = { live: 0, baseline: 0, unavailable: 0 };

    for (const [serviceId, catalog] of Object.entries(BASELINE_COSTS)) {
      if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
      const rows = await fetchLivePricing(serviceId, region.id, fallbackBaselineFor(serviceId), {
        logger: log,
        signal: activeSignal,
      });
      const c = countRows(rows);
      counts.live += c.live;
      counts.baseline += c.baseline;
      counts.unavailable += c.unavailable;
      services.push({
        serviceId,
        label: SERVICE_LABELS[serviceId],
        // The unit the rows are actually in. For a service with rows that is
        // the benchmark unit every provider converged on; with none, the
        // catalog's, which is the only unit left to name.
        unit: rows[0]?.unit ?? catalog.unit,
        sku: rows[0]?.sku ?? catalog.sku,
        rows,
      });
    }

    const refreshedAt = now().toISOString();
    const doc = {
      id: pricingDocId(region.id),
      region: region.id,
      refreshedAt,
      ttlMinutes: DEFAULT_CACHE_TTL_MINUTES,
      services,
      counts,
    };
    await store.upsertDoc(CACHE_CONTAINER, doc);
    return { region: region.id, counts, refreshedAt, services };
  }

  /**
   * The day's snapshot and the change document for one region, from the
   * services the cache write just stored. Throws on any failure; the caller
   * decides that a throw here is a warning, not a failed region.
   *
   * @returns {Promise<{ '7d': number, '30d': number, sampleDays: number }>}
   *   item counts per window, for the log line and the job summary
   */
  async function recordHistory({ region, refreshedAt, services }) {
    const snapshot = buildHistoryDoc({ region, refreshedAt, services });
    await store.upsertDoc(HISTORY_CONTAINER, snapshot);
    const changes = await computePriceChanges({
      store,
      region,
      cells: snapshot.cells,
      refreshedAt,
    });
    await store.upsertDoc(CACHE_CONTAINER, changes);
    return {
      ...Object.fromEntries(
        Object.entries(changes.windows).map(([name, w]) => [name, w.items.length])
      ),
      sampleDays: changes.sampleDays,
    };
  }

  return {
    refreshRegion,

    /**
     * @param {{ regions?: string[] }} [options] - defaults to every option
     * @returns {Promise<{ regions: {region: string, counts: object, refreshedAt: string,
     *   changes: object|null}[], failed: {region: string, error: string}[], durationMs: number }>}
     *   `failed` carries a region that wrote no cache document (`error`), or
     *   one that did but could not record history (`error: 'history: …'`);
     *   the latter is ALSO in `regions`, with `changes: null`.
     */
    async run({ regions, signal: runSignal } = {}) {
      const activeSignal = runSignal || defaultSignal;
      const started = now().getTime();
      const ids = parseRefreshPayload({ regions }).regions;
      // A stale GCP service list must not outlive one run (pricing/index.js
      // clearPricingCaches).
      clearCaches();

      const done = [];
      const failed = [];
      for (const regionId of ids) {
        if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
        let summary;
        try {
          summary = await refreshRegion(regionId, { signal: activeSignal });
        } catch (error) {
          // The job result is served to the admin page by getJob, so it
          // holds a sentence with the code and the log line's reference; the
          // line itself is content-free (#945).
          failed.push({
            region: regionId,
            error: recordedFailure(log, 'The region could not be refreshed.', error),
          });
          continue;
        }
        const { services, ...result } = summary;
        let changes = null;
        try {
          changes = await recordHistory({
            region: regionId,
            refreshedAt: result.refreshedAt,
            services,
          });
          log.log?.(
            `[refresh-tool-pricing] ${regionId}: live ${result.counts.live}, baseline ${result.counts.baseline}, unavailable ${result.counts.unavailable}; changes 7d ${changes['7d']}, 30d ${changes['30d']} (${changes.sampleDays} comparison days)`
          );
        } catch (error) {
          // The cache document is written and the page is served; what is
          // missing is today's snapshot and the change feed. Say so, count
          // it, and keep going.
          failed.push({
            region: regionId,
            error: recordedFailure(log, "The region's price history could not be written.", error),
          });
        }
        done.push({ ...result, changes });
      }
      return { regions: done, failed, durationMs: now().getTime() - started };
    },
  };
}
