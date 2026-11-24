/**
 * Azure pricing via the public Retail Prices API.
 *
 * Ported from Site-Main `functions/cloud-tools-pricing.js:29-143, 426-461`
 * (commit 07f3123). Unauthenticated, so no credential handling.
 *
 * Returns a price triple `{sku, unit, pricePerUnit, currency}` rather than the
 * full eleven-key row the source built here. The row is composed once in
 * `index.js` — in the source each of the three providers built its own copy,
 * so the output contract existed in triplicate and was enforced by nothing.
 *
 * ===========================================================================
 * THE PAGINATION BUG THIS FIXES
 * ===========================================================================
 * The source read `json.Items` and never followed `NextPageLink` (`:438`).
 *
 * That is not theoretical. The `storage-object` filter is
 *   serviceName eq 'Storage' and armRegionName eq '{region}' and priceType eq 'Consumption'
 * — every Storage meter in the region. Checked live: it returns `Count: 1000`
 * WITH a `NextPageLink`, while `selectItem` is hunting for one row matching
 * Blob Storage + Hot + Data Stored. If that row is not in the first 1000 the
 * function returns null, the column silently falls back to baseline, and
 * nothing is logged — because a null is "no match", not an error.
 *
 * Paging is bounded. An unbounded follow would reintroduce exactly the failure
 * this whole change exists to remove: an unbounded read against a remote
 * document whose size we do not control.
 */

import { withStatus } from '../../http/error-response.js';
import {
  MESSAGING_BENCHMARK_SKU,
  MESSAGING_BENCHMARK_UNIT,
  NOSQL_BENCHMARK_UNIT,
  SERVERLESS_BENCHMARK_SKU,
  SERVERLESS_BENCHMARK_UNIT,
  normalizeUnit,
  resolveProviderRegion,
} from './shared.js';

const RETAIL_PRICES_URL = 'https://prices.azure.com/api/retail/prices';

/**
 * NOTE: this is a PREVIEW api-version, carried over from the source. Pinning a
 * preview version is a latent break — Microsoft can retire it. Flagged rather
 * than changed, because moving to a stable version alters which fields come
 * back and needs its own verification against live responses.
 */
const API_VERSION = '2023-01-01-preview';

/**
 * Maximum pages to follow. At 1000 items per page this is 10,000 rows, well
 * past any filter here, and it turns a runaway filter into a bounded null
 * rather than a hung function.
 */
const MAX_PAGES = 10;

/** Per-service OData filter, row selector, and output shaping. */
export const AZURE_SERVICE_FILTERS = {
  'compute-vm': {
    filter: (region) =>
      `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and armSkuName eq 'Standard_D4as_v5' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          item.skuName === 'Standard_D4as_v5' &&
          !/Spot|Low Priority/i.test(item.skuName || '') &&
          !/Windows/i.test(item.productName || '') &&
          !/Cloud Services/i.test(item.productName || '')
      ),
    unit: 'hour',
  },

  'compute-serverless': {
    filter: (region) =>
      `serviceName eq 'Functions' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) => {
      const request = items.find(
        (item) =>
          /On Demand Total Executions/i.test(item.meterName || '') &&
          !/Always Ready/i.test(item.productName || '')
      );
      const duration = items.find(
        (item) =>
          /On Demand Execution Time/i.test(item.meterName || '') &&
          !/Always Ready/i.test(item.productName || '')
      );
      if (!request || !duration) return null;
      return { request, duration };
    },
    unit: SERVERLESS_BENCHMARK_UNIT,
    // Note the 100000 multiplier, NOT the 1_000_000 the AWS path uses for the
    // same benchmark — Azure meters executions per 10. Carried over verbatim.
    transformPrice: (selection) =>
      Number(
        (
          Number(selection.request.unitPrice) * 100000 +
          Number(selection.duration.unitPrice) * 400000
        ).toFixed(6)
      ),
    transformSku: () => SERVERLESS_BENCHMARK_SKU,
  },

  'storage-object': {
    filter: (region) =>
      `serviceName eq 'Storage' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          /Blob Storage|General Block Blob v2/i.test(item.productName || '') &&
          /Hot/i.test(item.skuName || '') &&
          /Data Stored/i.test(item.meterName || '')
      ),
    unit: 'GB-month',
  },

  'database-relational': {
    filter: (region) =>
      `serviceName eq 'SQL Database' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          /General Purpose/i.test(item.productName || '') &&
          item.armSkuName === 'SQLDB_GP_Compute_Gen5_2' &&
          item.meterName === 'vCore'
      ),
    unit: 'hour',
    transformSku: () => 'Azure SQL GP Gen5 2 vCore benchmark',
  },

  'database-nosql': {
    filter: (region) =>
      `serviceName eq 'Azure Cosmos DB' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          /serverless/i.test(item.skuName || '') &&
          /1M RUs/i.test(item.meterName || '') &&
          Number(item.unitPrice) > 0
      ) || items.find((item) => /1M RUs/i.test(item.meterName || '') && Number(item.unitPrice) > 0),
    unit: NOSQL_BENCHMARK_UNIT,
    transformSku: () => '1M RUs serverless benchmark',
  },

  'containers-kubernetes': {
    filter: (region) =>
      `serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find((item) => /Standard Uptime SLA/i.test(item.meterName || '')) ||
      items.find((item) => /Automatic General Purpose/i.test(item.meterName || '')),
    unit: 'hour',
  },

  'integration-messaging': {
    filter: (region) =>
      `serviceName eq 'Service Bus' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          /Standard Messaging Operations/i.test(item.meterName || '') && Number(item.unitPrice) > 0
      ) ||
      items.find(
        (item) =>
          /Basic Messaging Operations/i.test(item.meterName || '') && Number(item.unitPrice) > 0
      ),
    unit: MESSAGING_BENCHMARK_UNIT,
    transformSku: () => MESSAGING_BENCHMARK_SKU,
  },

  'edge-cdn': {
    filter: (region) =>
      `serviceName eq 'Bandwidth' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
    selectItem: (items) =>
      items.find(
        (item) =>
          /Bandwidth - Routing Preference: Internet/i.test(item.productName || '') &&
          /Data Transfer Out/i.test(item.meterName || '') &&
          Number(item.unitPrice) > 0
      ),
    unit: 'GB egress',
  },
};

/**
 * Fetch every page for a filter, stopping as soon as `selectItem` matches.
 *
 * Re-running the selector per page rather than accumulating all items is
 * deliberate: it stops at the first hit, so the common case costs one request
 * and holds one page in memory.
 *
 * @returns {Promise<{ item: object|null, pages: number, truncated: boolean }>}
 */
export async function findAcrossPages(filter, selectItem, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const first = new URL(RETAIL_PRICES_URL);
  first.searchParams.set('api-version', API_VERSION);
  first.searchParams.set('$filter', filter);

  let url = first.toString();
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const response = await doFetch(url);
    if (!response.ok) throw withStatus(new Error(`Azure retail prices returned ${response.status}`), response.status);

    const json = await response.json();
    pages += 1;

    const items = Array.isArray(json.Items) ? json.Items : [];
    const match = selectItem(items);
    if (match) return { item: match, pages, truncated: false };

    url = json.NextPageLink || null;
  }

  // Ran out of pages, or hit the cap with more available.
  return { item: null, pages, truncated: Boolean(url) };
}

/**
 * Resolve one service's Azure price.
 *
 * @param {string} serviceId
 * @param {string} requestedRegion
 * @param {{ fetch?: typeof globalThis.fetch }} [deps]
 * @returns {Promise<{sku: string, unit: string, pricePerUnit: number, currency: string}|null>}
 */
export async function fetchAzurePrice(serviceId, requestedRegion, deps = {}) {
  const config = AZURE_SERVICE_FILTERS[serviceId];
  if (!config) return null;

  const providerRegion = resolveProviderRegion(requestedRegion, 'azure');
  const { item, truncated } = await findAcrossPages(
    config.filter(providerRegion),
    config.selectItem,
    deps
  );

  if (!item) {
    if (truncated) {
      // Distinguishable from an ordinary miss: the filter is too broad and the
      // answer may well have been on page 11. Surfacing it as an error means it
      // gets logged rather than silently becoming a baseline row.
      throw new Error(
        `Azure retail prices: no match for ${serviceId} within ${MAX_PAGES} pages — filter too broad`
      );
    }
    return null;
  }

  // `selectItem` may return a composite (compute-serverless returns
  // {request, duration}), in which case transformPrice owns the arithmetic and
  // there is no single unitPrice to read.
  const pricePerUnit = config.transformPrice
    ? config.transformPrice(item)
    : Number(item.unitPrice);

  return {
    sku:
      (config.transformSku ? config.transformSku(item) : null) ||
      item.skuName ||
      item.productName ||
      'Azure retail SKU',
    unit: config.unit || normalizeUnit(item.unitOfMeasure),
    pricePerUnit: Number(pricePerUnit.toFixed(6)),
    // The only provider that can return a non-USD currency.
    currency: item.currencyCode || 'USD',
  };
}
