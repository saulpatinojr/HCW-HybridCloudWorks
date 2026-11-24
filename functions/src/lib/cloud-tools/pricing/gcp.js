/**
 * GCP pricing via the Cloud Billing Catalog API.
 *
 * Ported from Site-Main `functions/cloud-tools-pricing.js:145-154, 463-743`
 * (commit 07f3123). The SKU-matching logic is transcribed unchanged — those
 * regexes and multipliers are the comparison contract.
 *
 * Two things are deliberately different.
 *
 * ===========================================================================
 * 1. CREDENTIALS — AN API KEY, WHICH IS WHAT GOOGLE DOCUMENTS
 * ===========================================================================
 * The Cloud Billing Catalog API serves the PUBLIC price list. Google's own
 * guide says so plainly: "Before you can use the Cloud Billing Catalog API,
 * you'll need to enable the Cloud Billing API and get an API key." It is not
 * user data, and it needs no user identity.
 *
 * Two earlier designs got this wrong in different directions. The source used
 * Application Default Credentials, which resolve from a GCE metadata server or
 * a well-known file — neither of which exists on Azure. The port replaced that
 * with a service-account JSON pulled from Key Vault at runtime, which worked
 * but dragged in an OAuth library, a Key Vault SDK client, a `KEY_VAULT_URI`
 * app setting, a 2.3 KB multi-line secret and a bespoke seeding script — a
 * signed-JWT token exchange, to read a public price list, on a page that shows
 * visitors comparative pricing.
 *
 * An API key is a single string. It arrives the same way every other provider
 * credential in this codebase does: an app setting that is a Key Vault
 * reference, read through `readKey`, which already treats an unresolved
 * reference as absent. No SDK, no token exchange, no special case.
 *
 * ABSENCE STILL THROWS, and that has not changed. A null here would be
 * indistinguishable from "GCP has no price for this service" and would
 * silently become a baseline row — a comparison table quietly showing stale
 * numbers is worse than one that errors.
 *
 * ===========================================================================
 * 2. FILTER BEFORE ACCUMULATING
 * ===========================================================================
 * The source did `allSkus.push(...skus)` across up to 30 pages of 5,000 SKUs —
 * accumulating up to 150,000 SKU objects. It has to accumulate rather than
 * match per page, because several services need a PAIR of SKUs (vCPU + RAM)
 * that can straddle a page boundary.
 *
 * But every branch of the matcher requires `inRegion(sku)` first, so SKUs for
 * other regions can be dropped as each page arrives. Same semantics, a small
 * fraction of the retained objects. The 30-page cap is kept.
 */

import { readKey } from '../../ai/router.js';
import { withStatus } from '../../http/error-response.js';
import {
  GCP_MESSAGING_BENCHMARK_BYTES,
  MESSAGING_BENCHMARK_SKU,
  MESSAGING_BENCHMARK_UNIT,
  NOSQL_BENCHMARK_SKU,
  NOSQL_BENCHMARK_UNIT,
  SERVERLESS_BENCHMARK_SKU,
  SERVERLESS_BENCHMARK_UNIT,
  moneyToNumber,
  normalizeUnit,
  resolveProviderRegion,
} from './shared.js';

/**
 * App setting holding the Cloud Billing API key.
 *
 * UPPER_SNAKE here, UPPER-KEBAB in the vault (`GCP-BILLING-API-KEY`) — Key
 * Vault forbids underscores, which is the whole reason for the two spellings.
 */
export const GCP_API_KEY_SETTING = 'GCP_BILLING_API_KEY';

const BILLING_API = 'https://cloudbilling.googleapis.com/v1';
const MAX_SKU_PAGES = 30;

/** Cloud Billing display names per catalog service. */
export const GCP_SERVICE_NAMES = {
  'compute-vm': 'Compute Engine',
  'compute-serverless': 'Cloud Run Functions',
  'storage-object': 'Cloud Storage',
  'database-relational': 'Cloud SQL',
  'database-nosql': 'Cloud Firestore',
  'containers-kubernetes': 'Kubernetes Engine',
  'integration-messaging': 'Cloud Pub/Sub',
  'edge-cdn': 'Cloud CDN',
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The Cloud Billing API key.
 *
 * `readKey` returns '' for an unresolved `@Microsoft.KeyVault(...)` reference
 * as well as for an absent setting, so an unseeded secret and a broken vault
 * grant reach this the same way — and both are faults, not "no price".
 */
export function getGcpApiKey(deps = {}) {
  const env = deps.env ?? process.env;
  const key = deps.apiKey ?? readKey(env, GCP_API_KEY_SETTING);
  if (!key) {
    throw new Error(
      `GCP pricing credential unavailable: app setting ${GCP_API_KEY_SETTING} is unset or its ` +
        'Key Vault reference did not resolve'
    );
  }
  return key;
}

let cachedGoogleServices = null;

async function getGoogleServices(apiKey, deps = {}) {
  if (cachedGoogleServices) return cachedGoogleServices;

  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = new URL(`${BILLING_API}/services`);
  url.searchParams.set('pageSize', '5000');
  url.searchParams.set('key', apiKey);
  const response = await doFetch(url);
  if (!response.ok) throw withStatus(new Error(`Google services list returned ${response.status}`), response.status);

  const json = await response.json();
  cachedGoogleServices = Array.isArray(json.services) ? json.services : [];
  return cachedGoogleServices;
}

/** Drop memoised GCP state. Called by clearPricingCaches, and by tests. */
export function resetGoogleCaches() {
  cachedGoogleServices = null;
}

// ---------------------------------------------------------------------------
// SKU matching — transcribed from the source
// ---------------------------------------------------------------------------

/**
 * Price from a tiered rate structure.
 * `firstNonZero` skips free tiers, which GCP expresses as a $0 first tier.
 */
export function getGoogleTieredRatePrice(pricingExpression, options = {}) {
  const rates = Array.isArray(pricingExpression?.tieredRates) ? pricingExpression.tieredRates : [];
  if (!rates.length) return 0;

  if (options.firstNonZero) {
    const nonZero = rates.find((rate) => moneyToNumber(rate?.unitPrice) > 0);
    if (nonZero) return moneyToNumber(nonZero.unitPrice);
  }
  return moneyToNumber(rates[0]?.unitPrice);
}

/** Is this SKU offered in the region we are pricing? */
export function inRegion(sku, providerRegion) {
  return (
    Array.isArray(sku.serviceRegions) &&
    (sku.serviceRegions.includes(providerRegion) || sku.serviceRegions.includes('global'))
  );
}

const rate = (sku) =>
  getGoogleTieredRatePrice(sku.pricingInfo?.[0]?.pricingExpression, { firstNonZero: true });

/**
 * @param {string} serviceId
 * @param {object[]} skus  already filtered to the region
 * @param {string} providerRegion
 * @returns {{sku: string, unit: string, pricePerUnit: number}|null}
 */
export function findGoogleSkuMatch(serviceId, skus, providerRegion) {
  const here = (sku) => inRegion(sku, providerRegion);
  const onDemand = (sku) => sku.category?.usageType === 'OnDemand';
  const describes = (re) => (sku) => re.test(sku.description || '');

  if (serviceId === 'compute-vm') {
    const core = skus.find((s) => here(s) && onDemand(s) && /^E2 Instance Core running in /i.test(s.description || ''));
    const memory = skus.find((s) => here(s) && onDemand(s) && /^E2 Instance Ram running in /i.test(s.description || ''));
    if (!core || !memory) return null;
    return {
      sku: 'E2-derived 4 vCPU / 16 GiB',
      unit: 'hour',
      pricePerUnit: 4 * rate(core) + 16 * rate(memory),
    };
  }

  if (serviceId === 'compute-serverless') {
    const cpu = skus.find(
      (s) => here(s) && onDemand(s) && /Cloud Run functions CPU \(Request-based billing\)/i.test(s.description || '')
    );
    const memory = skus.find(
      (s) => here(s) && onDemand(s) && /Cloud Run functions Memory \(Request-based billing\)/i.test(s.description || '')
    );
    if (!cpu || !memory) return null;
    return {
      sku: SERVERLESS_BENCHMARK_SKU,
      unit: SERVERLESS_BENCHMARK_UNIT,
      pricePerUnit: 200000 * rate(cpu) + 400000 * rate(memory),
    };
  }

  if (serviceId === 'storage-object') {
    const sku = skus.find(
      (s) =>
        here(s) &&
        /Standard Storage/i.test(s.description || '') &&
        /(Dual-region|Regional|Iowa|Belgium|Oregon)/i.test(s.description || '')
    );
    if (!sku) return null;
    return { sku: sku.description, unit: 'GB-month', pricePerUnit: rate(sku) };
  }

  if (serviceId === 'database-relational') {
    const cpu = skus.find((s) => here(s) && onDemand(s) && /Cloud SQL .* Regional - vCPU/i.test(s.description || ''));
    const memory = skus.find((s) => here(s) && onDemand(s) && /Cloud SQL .* Regional - RAM/i.test(s.description || ''));
    if (!cpu || !memory) return null;
    return {
      sku: 'Cloud SQL regional 2 vCPU / 8 GiB derived',
      unit: 'hour',
      pricePerUnit: 2 * rate(cpu) + 8 * rate(memory),
    };
  }

  if (serviceId === 'database-nosql') {
    const isCount = (s) => s.pricingInfo?.[0]?.pricingExpression?.usageUnit === 'count';
    const readSku = skus.find((s) => here(s) && /Cloud Firestore Read Ops/i.test(s.description || '') && isCount(s));
    const writeSku = skus.find((s) => here(s) && /Cloud Firestore Entity Writes/i.test(s.description || '') && isCount(s));
    if (!readSku || !writeSku) return null;
    return {
      sku: NOSQL_BENCHMARK_SKU,
      unit: NOSQL_BENCHMARK_UNIT,
      pricePerUnit: rate(readSku) * 500_000 + rate(writeSku) * 500_000,
    };
  }

  if (serviceId === 'containers-kubernetes') {
    const cpu = skus.find((s) => here(s) && onDemand(s) && /Autopilot Balanced Pod mCPU Requests/i.test(s.description || ''));
    const memory = skus.find((s) => here(s) && onDemand(s) && /Autopilot Balanced Pod Memory Requests/i.test(s.description || ''));
    if (!cpu || !memory) return null;
    return {
      sku: 'Autopilot balanced pod requests',
      unit: 'hour',
      // 4000 mCPU, i.e. 4 vCPU expressed in the milli-CPU meter.
      pricePerUnit: 4000 * rate(cpu) + 16 * rate(memory),
    };
  }

  if (serviceId === 'integration-messaging') {
    const sku = skus.find((s) => here(s) && describes(/Message Delivery Basic/i)(s));
    if (!sku) return null;
    const expression = sku.pricingInfo?.[0]?.pricingExpression;
    const unitPrice = getGoogleTieredRatePrice(expression, { firstNonZero: true });
    const usageUnit = normalizeUnit(expression?.usageUnit);
    return {
      sku: MESSAGING_BENCHMARK_SKU,
      unit: MESSAGING_BENCHMARK_UNIT,
      // Pub/Sub meters by volume, not by operation, so the benchmark converts.
      pricePerUnit:
        usageUnit === 'TB' ? unitPrice * (GCP_MESSAGING_BENCHMARK_BYTES / 1024 ** 4) : unitPrice,
    };
  }

  if (serviceId === 'edge-cdn') {
    const sku = skus.find(
      (s) => here(s) && /Networking Cloud CDN Traffic Cache Data Transfer/i.test(s.description || '')
    );
    if (!sku) return null;
    return {
      sku: sku.description,
      unit: 'GB egress',
      // Note: tieredRates[0] directly, NOT firstNonZero. Carried over as-is.
      pricePerUnit: moneyToNumber(sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Resolve one service's GCP price.
 *
 * @returns {Promise<{sku: string, unit: string, pricePerUnit: number}|null>}
 */
export async function fetchGcpPrice(serviceId, requestedRegion, deps = {}) {
  const serviceName = GCP_SERVICE_NAMES[serviceId];
  if (!serviceName) return null;

  const providerRegion = resolveProviderRegion(requestedRegion, 'gcp');
  const doFetch = deps.fetch ?? globalThis.fetch;

  const apiKey = getGcpApiKey(deps);
  const services = await getGoogleServices(apiKey, deps);
  const service = services.find((item) => item.displayName === serviceName);
  if (!service?.name) return null;

  // Accumulates across pages because several services need a PAIR of SKUs
  // (vCPU + RAM) that can straddle a page boundary — but only region-relevant
  // SKUs are retained, since every matcher branch requires inRegion first.
  const candidates = [];
  let pageToken = '';

  for (let page = 0; page < MAX_SKU_PAGES; page += 1) {
    const url = new URL(`${BILLING_API}/${service.name}/skus`);
    url.searchParams.set('pageSize', '5000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('key', apiKey);

    const response = await doFetch(url);
    if (!response.ok) throw withStatus(new Error(`Google SKUs returned ${response.status}`), response.status);

    const json = await response.json();
    const skus = Array.isArray(json.skus) ? json.skus : [];
    for (const sku of skus) {
      if (inRegion(sku, providerRegion)) candidates.push(sku);
    }

    const match = findGoogleSkuMatch(serviceId, candidates, providerRegion);
    if (match) {
      return {
        sku: match.sku,
        unit: match.unit,
        pricePerUnit: Number(match.pricePerUnit.toFixed(6)),
      };
    }

    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }

  return null;
}
