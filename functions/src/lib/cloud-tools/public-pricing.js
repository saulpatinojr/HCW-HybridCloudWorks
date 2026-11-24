/**
 * GET /api/public/cloud-tools/pricing — the anonymous read of the pricing
 * cache (#613). The comparison page's only data source.
 *
 * Lives here rather than in lib/public-reads.js because that module keeps a
 * documented no-imports rule — the anonymous read path must not be breakable
 * by a change on a writer's side — and this handler needs three things from
 * the pricing library: the region options, the freshness arithmetic, and the
 * cell count. Copying them would be a fourth statement of the region list.
 * The registration still sits with its siblings in functions/public-reads.js.
 *
 * Two rules, both inherited:
 *
 *   1. **Never call a provider from here.** freshness.js explains why: this
 *      route is anonymous and takes `region` from the query string, so a
 *      refresh-on-miss would let any caller drive live pricing-API traffic by
 *      naming a region. Staleness is REPORTED — `stale`, `ageMinutes` — and
 *      the scheduled refresh is what keeps it from being true.
 *   2. **"Not refreshed yet" is a 200, not an error.** Before the first run
 *      the document does not exist. The page must render that state — no
 *      prices, every cell unavailable, `refreshedAt: null` — rather than an
 *      error, because from the visitor's side it is not one. It is cached
 *      briefly, for the reason the curated-image miss is: a long TTL on
 *      "nothing yet" turns the first refresh into a fifteen-minute wait.
 */

import { cacheFreshness } from './freshness.js';
// From history.js, not refresh.js: the container name is the same constant
// (refresh.js re-exports it), and this path does not load the three provider
// SDKs behind the refresh on a public read's cold start.
import { CACHE_CONTAINER } from './history.js';
import {
  COMPARISON_CELLS,
  DEFAULT_REGION,
  pricingDocId,
  publicRegionOptions,
  regionOption,
} from './pricing/regions.js';
import { errorFacts } from '../http/error-response.js';

const HIT_CACHE_SECONDS = 900;
const MISS_CACHE_SECONDS = 60;

const json = (status, body, cacheSeconds = 0) => ({
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(cacheSeconds > 0 ? { 'Cache-Control': `public, max-age=${cacheSeconds}` } : {}),
  },
  body: JSON.stringify(body),
});

/**
 * @param {object} deps
 * @param {{ readDoc: Function }} deps.store
 * @param {() => number} [deps.now] - epoch ms, for the freshness arithmetic
 */
export function createPublicPricingHandlers({ store, now = () => Date.now() }) {
  return {
    /** GET /api/public/cloud-tools/pricing?region= */
    async getPricing(request, context) {
      try {
        const requested = String(request.query?.get?.('region') ?? '').trim();
        const region = requested || DEFAULT_REGION;
        if (!regionOption(region)) return json(400, { error: 'Unknown region' });

        const id = pricingDocId(region);
        const doc = await store.readDoc(CACHE_CONTAINER, id, id);
        const regions = publicRegionOptions();

        if (!doc) {
          return json(
            200,
            {
              success: true,
              pricing: {
                region,
                regions,
                refreshedAt: null,
                ttlMinutes: cacheFreshness(undefined, now()).ttlMinutes,
                ageMinutes: null,
                stale: true,
                counts: { live: 0, baseline: 0, unavailable: COMPARISON_CELLS },
                services: [],
              },
            },
            MISS_CACHE_SECONDS
          );
        }

        const { ttlMinutes, ageMinutes, stale } = cacheFreshness(doc, now());
        return json(
          200,
          {
            success: true,
            pricing: {
              region,
              regions,
              refreshedAt: doc.refreshedAt ?? null,
              ttlMinutes,
              ageMinutes,
              stale,
              counts: doc.counts ?? { live: 0, baseline: 0, unavailable: COMPARISON_CELLS },
              services: Array.isArray(doc.services) ? doc.services : [],
            },
          },
          HIT_CACHE_SECONDS
        );
      } catch (error) {
        context.error('publicGetCloudToolsPricing failed:', errorFacts(error));
        return json(500, { error: 'Failed to get pricing' });
      }
    },
  };
}
