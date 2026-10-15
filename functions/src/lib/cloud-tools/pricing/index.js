/**
 * Live pricing orchestrator.
 *
 * Ported from Site-Main `functions/cloud-tools-pricing.js:949-1002`
 * (commit 07f3123), with one structural change.
 *
 * In the source each provider built its own copy of the eleven-key output row
 * — AWS at `:874-886`, Azure at `:444-460`, GCP at `:722-734`. The wire
 * contract therefore existed in triplicate and was enforced by nothing; the
 * three could drift apart and only a reader comparing them would notice.
 *
 * Here every provider returns a price triple `{sku, unit, pricePerUnit}` plus
 * an optional `currency`, and the row is composed once, below. A live row and
 * a fallback row are then the same shape by construction rather than by
 * coincidence.
 */

import { PRICING_SOURCE, resolveProviderRegion } from './shared.js';
import { PROVIDERS } from './baseline.js';
import { fetchAwsPrice } from './aws.js';
import { fetchAzurePrice } from './azure.js';
import { fetchGcpPrice, resetGoogleCaches } from './gcp.js';

/** @typedef {{sku: string, unit: string, pricePerUnit: number, currency?: string}} PriceTriple */

const LOADERS = {
  aws: fetchAwsPrice,
  azure: fetchAzurePrice,
  gcp: fetchGcpPrice,
};

/**
 * Compose the wire row. The ONE place this shape is defined.
 *
 * @returns {{provider,serviceId,region,providerRegion,sku,model,pricePerUnit,unit,currency,updatedAt,source: string}}
 */
function composeRow({ provider, serviceId, region, triple, model, source, updatedAt }) {
  return {
    provider,
    serviceId,
    region,
    providerRegion: resolveProviderRegion(region, provider),
    sku: triple.sku,
    model,
    pricePerUnit: Number(Number(triple.pricePerUnit || 0).toFixed(6)),
    unit: triple.unit,
    // Azure is the only provider that can return something other than USD.
    currency: triple.currency || 'USD',
    updatedAt,
    source,
  };
}

/**
 * Fetch live prices for one service across all three providers.
 *
 * Each provider is isolated in its own try/catch inside `Promise.all`, so one
 * provider failing never fails the others — the single most important
 * behaviour in this module, carried over unchanged.
 *
 * @param {string} serviceId
 * @param {string} requestedRegion
 * @param {{unit: string, sku: string, aws: number, azure: number, gcp: number}|null} baseline
 * @param {{ logger?: {warn: Function, info?: Function}, loaders?: object, deps?: object }} [options]
 * @returns {Promise<object[]>} 0-3 rows, in [aws, azure, gcp] order
 */
export async function fetchLivePricing(serviceId, requestedRegion, baseline, options = {}) {
  const log = options.logger ?? console;
  const loaders = { ...LOADERS, ...(options.loaders ?? {}) };
  const updatedAt = new Date().toISOString();

  const rows = await Promise.all(
    PROVIDERS.map(async (provider) => {
      let triple = null;

      try {
        triple = await loaders[provider](serviceId, requestedRegion, {
          ...(options.deps ?? {}),
          signal: options.signal,
        });
      } catch (error) {
        log.warn('[cloud-tools-pricing] live price fetch FAILED', {
          provider,
          serviceId,
          region: requestedRegion,
          message: error.message,
        });
        triple = null;
      }

      if (triple) {
        return composeRow({
          provider,
          serviceId,
          region: requestedRegion,
          triple,
          model: 'retail',
          source: PRICING_SOURCE[provider],
          updatedAt,
        });
      }

      // The source logged a thrown error but said nothing about a successful
      // null, so "the selector matched nothing" was indistinguishable in the
      // logs from "we never tried". Both now leave a trace, and they say
      // different things.
      if (!options.suppressMissLog) {
        log.warn('[cloud-tools-pricing] live price NOT FOUND, using baseline', {
          provider,
          serviceId,
          region: requestedRegion,
        });
      }

      if (!baseline) return null;

      return composeRow({
        provider,
        serviceId,
        region: requestedRegion,
        triple: {
          sku: baseline.sku,
          unit: baseline.unit,
          pricePerUnit: Number(baseline[provider] || 0),
        },
        model: 'baseline-fallback',
        source: PRICING_SOURCE.baseline,
        updatedAt,
      });
    })
  );

  return rows.filter(Boolean);
}

/**
 * Release memoised provider state.
 *
 * Historical note: this used to be load-bearing. It cleared a cache of AWS bulk
 * offer documents, and a full eight-service sweep OOM'd a 2 GiB function
 * without it. That cache is gone — the Query API returns about a kilobyte, so
 * there is nothing to accumulate — and only the GCP service list remains.
 * Kept because that list is still memoised process-wide and a long-running
 * sweep should not pin a stale catalog.
 */
export function clearPricingCaches() {
  resetGoogleCaches();
}

export {
  BASELINE_COSTS,
  baselineFor,
  fallbackBaselineFor,
  PROVIDERS,
  KNOWN_UNIT_MISMATCHES,
} from './baseline.js';
