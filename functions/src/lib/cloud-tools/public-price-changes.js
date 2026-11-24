/**
 * GET /api/public/cloud-tools/price-changes — the anonymous read of the
 * price-change feed (#613 Phase 3). The comparison page's changes card and
 * nothing else read it.
 *
 * Same shape and the same two rules as public-pricing.js: one point read of
 * `price-changes:<region>`, the document the refresh wrote from the history
 * snapshots (history.js); never a provider call and never a history query on
 * the request path; and "nothing computed yet" is a 200 with empty windows,
 * cached briefly, not an error — before the second day of history exists
 * there is nothing to diff, and the page renders that state.
 *
 * What goes over the wire is a projection — region, asOf, windows,
 * sampleDays — rather than the stored document minus its id, so a Cosmos
 * system field or a future internal field cannot leak by omission.
 */

import {
  CHANGE_WINDOWS,
  CACHE_CONTAINER,
  emptyPriceChanges,
  priceChangesDocId,
} from './history.js';
import { DEFAULT_REGION, regionOption } from './pricing/regions.js';
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

/** One window as served: every field present, items an array, whatever was stored. */
function projectWindow(stored) {
  return {
    since: stored?.since ?? null,
    sampleDay: stored?.sampleDay ?? null,
    items: Array.isArray(stored?.items) ? stored.items : [],
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function }} deps.store
 */
export function createPublicPriceChangesHandlers({ store }) {
  return {
    /** GET /api/public/cloud-tools/price-changes?region= */
    async getPriceChanges(request, context) {
      try {
        const requested = String(request.query?.get?.('region') ?? '').trim();
        const region = requested || DEFAULT_REGION;
        if (!regionOption(region)) return json(400, { error: 'Unknown region' });

        const id = priceChangesDocId(region);
        const doc = await store.readDoc(CACHE_CONTAINER, id, id);
        if (!doc) {
          return json(
            200,
            { success: true, changes: emptyPriceChanges(region) },
            MISS_CACHE_SECONDS
          );
        }

        return json(
          200,
          {
            success: true,
            changes: {
              region,
              asOf: doc.asOf ?? null,
              windows: Object.fromEntries(
                Object.keys(CHANGE_WINDOWS).map((name) => [
                  name,
                  projectWindow(doc.windows?.[name]),
                ])
              ),
              sampleDays: Number.isInteger(doc.sampleDays) ? doc.sampleDays : 0,
            },
          },
          HIT_CACHE_SECONDS
        );
      } catch (error) {
        context.error('publicGetCloudToolsPriceChanges failed:', errorFacts(error));
        return json(500, { error: 'Failed to get price changes' });
      }
    },
  };
}
