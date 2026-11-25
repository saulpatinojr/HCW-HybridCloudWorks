/**
 * AWS pricing via the Price List **Query** API.
 *
 * ===========================================================================
 * WHY THIS REPLACED THE BULK OFFER FILE
 * ===========================================================================
 * The previous implementation fetched a whole regional offer document and
 * `JSON.parse`d it in one shot, then linearly scanned every product to find
 * one. Measured 2026-08-05 via Content-Length:
 *
 *     AmazonEC2 / us-east-1 / index.json   480,073,725 bytes  (458 MiB)
 *     AmazonRDS / us-east-1                 26,931,078 bytes  (25.7 MiB)
 *     every other offer used                       < 1.5 MiB
 *
 * 458 MiB of JSON expands several-fold in V8. That single document is the
 * entire reason the refresh functions were pinned at 4 GiB, and it is why they
 * OOM'd twice — at 1 GiB (1480 MiB used) and again at 2 GiB (2058 MiB used),
 * "~30s in, inside a single service". The code needed TWO objects out of
 * roughly 400,000.
 *
 * This was the wrong mechanism, not a badly tuned one. AWS's own guidance is to
 * use the Query API to "quickly find products and prices that you need when
 * you're developing applications that have limited resources, such as
 * front-end environments", and to use the Bulk API only to "consume large
 * amounts of product and pricing information ... such as processing in bulk".
 *
 * A GetProducts call returns ~1 KB. The 4 GiB requirement disappears with it.
 *
 * ===========================================================================
 * SHAPE NOTE — the one thing that is genuinely different
 * ===========================================================================
 * A PriceList entry carries the same `product.attributes` as a bulk product,
 * so the selection criteria port unchanged. The TERMS DO NOT:
 *
 *     bulk   terms.OnDemand[SKU][SKU.TERMCODE].priceDimensions
 *     query  terms.OnDemand[SKU.TERMCODE].priceDimensions      <- one level up
 *
 * `firstOnDemandDimension` below is the query-shape reader. Do not substitute
 * the bulk helper for it.
 */

import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

import {
  MESSAGING_BENCHMARK_SKU,
  MESSAGING_BENCHMARK_UNIT,
  NOSQL_BENCHMARK_SKU,
  NOSQL_BENCHMARK_UNIT,
  SERVERLESS_BENCHMARK_SKU,
  SERVERLESS_BENCHMARK_UNIT,
  normalizeUnit,
} from './shared.js';

/**
 * The Query API is hosted in a handful of regions and the endpoint is
 * unrelated to the region being priced — that is selected by the `regionCode`
 * filter. Using `regionCode` rather than the human `location` label also
 * removes the old three-region cap, which silently returned null for anything
 * outside us-east-1 / us-west-2 / eu-west-1.
 */
const PRICING_API_REGION = 'us-east-1';

/**
 * Read the first OnDemand price dimension from a PriceList entry.
 *
 * @param {object|string} entry  PriceList element; the SDK has historically
 *   returned these as JSON strings, and in some versions as objects, so both
 *   are accepted.
 * @param {{ firstNonZero?: boolean }} [options]
 *   `firstNonZero` skips $0 dimensions — SQS prices its free tier as a $0
 *   dimension that sorts first, and taking it would report SQS as free.
 * @returns {{ usd: number, unit: string, sku: string }|null}
 */
export function firstOnDemandDimension(entry, options = {}) {
  const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
  if (!parsed) return null;

  const terms = parsed.terms?.OnDemand;
  if (!terms) return null;

  const [firstTerm] = Object.values(terms);
  const dimensions = Object.values(firstTerm?.priceDimensions || {});
  if (!dimensions.length) return null;

  const dimension = options.firstNonZero
    ? dimensions.find((d) => Number(d.pricePerUnit?.USD || 0) > 0) || dimensions[0]
    : dimensions[0];

  return {
    usd: Number(dimension.pricePerUnit?.USD || 0),
    unit: normalizeUnit(dimension.unit),
    sku: parsed.product?.sku ?? null,
    attributes: parsed.product?.attributes ?? {},
  };
}

/** `{field: value}` → the API's filter array. */
function toTermMatchFilters(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value: String(Value) }));
}

/**
 * One GetProducts call.
 *
 * Returns null — not a throw — when nothing matches, matching the module's
 * convention that null means "no match" while a throw means "the lookup
 * failed". Both fall back to baseline upstream, but only one indicates a fault.
 *
 * @param {PricingClient} client
 * @param {string} serviceCode        e.g. 'AmazonEC2'. Required by the API.
 * @param {Record<string,string>} fields
 * @param {{ firstNonZero?: boolean, maxResults?: number, refine?: (d: object) => boolean }} [options]
 */
export async function getAwsPrice(client, serviceCode, fields, options = {}) {
  const response = await client.send(
    new GetProductsCommand({
      ServiceCode: serviceCode,
      Filters: toTermMatchFilters(fields),
      FormatVersion: 'aws_v1',
      // 1 unless a caller needs to post-filter locally; the API caps at 100.
      MaxResults: options.maxResults ?? 1,
    })
  );

  const entries = response.PriceList ?? [];
  for (const entry of entries) {
    const dimension = firstOnDemandDimension(entry, options);
    if (!dimension) continue;
    if (options.refine && !options.refine(dimension)) continue;
    return dimension;
  }

  return null;
}

/** A lookup whose only per-region field is `regionCode`. */
const inRegion = (fields) => (region) => ({ regionCode: region, ...fields });

/**
 * A service priced from two meters, each looked up by its fields and scaled
 * by its quantity in the benchmark: `pricePerUnit` is
 * first.usd * firstQuantity + second.usd * secondQuantity.
 */
const twoMeterService = ({ serviceCode, sku, unit, meters }) => {
  const [[first, firstFields, firstQuantity], [second, secondFields, secondQuantity]] = meters;
  return {
    serviceCode,
    lookups: { [first]: inRegion(firstFields), [second]: inRegion(secondFields) },
    price: (found) => ({
      sku,
      unit,
      pricePerUnit: found[first].usd * firstQuantity + found[second].usd * secondQuantity,
    }),
  };
};

/**
 * Per-service lookup definitions.
 *
 * Each `lookups` entry becomes one GetProducts call; `price` composes the
 * result. The filter fields are exactly the attributes the previous selectors
 * tested, and the `sku`/`unit` labels and arithmetic are carried over verbatim
 * — those strings and numbers are the wire contract the frontend renders.
 */
export const AWS_SERVICE_LOOKUPS = {
  'compute-vm': {
    serviceCode: 'AmazonEC2',
    lookups: {
      instance: inRegion({
        instanceType: 'm6i.xlarge',
        operatingSystem: 'Linux',
        tenancy: 'Shared',
        preInstalledSw: 'NA',
        capacitystatus: 'Used',
      }),
    },
    price: ({ instance }) => ({
      sku: 'm6i.xlarge Linux shared',
      unit: 'hour',
      pricePerUnit: instance.usd,
    }),
  },

  // 1M requests plus 400,000 GB-seconds.
  'compute-serverless': twoMeterService({
    serviceCode: 'AWSLambda',
    sku: SERVERLESS_BENCHMARK_SKU,
    unit: SERVERLESS_BENCHMARK_UNIT,
    meters: [
      ['request', { group: 'AWS-Lambda-Requests', usagetype: 'Request' }, 1_000_000],
      ['duration', { group: 'AWS-Lambda-Duration', usagetype: 'Lambda-GB-Second' }, 400_000],
    ],
  }),

  'storage-object': {
    serviceCode: 'AmazonS3',
    lookups: {
      storage: inRegion({
        storageClass: 'General Purpose',
        volumeType: 'Standard',
        usagetype: 'TimedStorage-ByteHrs',
      }),
    },
    price: ({ storage }) => ({
      sku: 'S3 Standard general purpose storage',
      unit: 'GB-month',
      pricePerUnit: storage.usd,
    }),
  },

  'database-relational': {
    serviceCode: 'AmazonRDS',
    lookups: {
      instance: inRegion({
        instanceType: 'db.t3.large',
        databaseEngine: 'MySQL',
        licenseModel: 'No license required',
        deploymentOption: 'Single-AZ',
      }),
    },
    price: ({ instance }) => ({
      sku: 'db.t3.large MySQL Single-AZ',
      unit: 'hour',
      pricePerUnit: instance.usd,
    }),
  },

  // 500,000 reads plus 500,000 writes.
  'database-nosql': twoMeterService({
    serviceCode: 'AmazonDynamoDB',
    sku: NOSQL_BENCHMARK_SKU,
    unit: NOSQL_BENCHMARK_UNIT,
    meters: [
      ['read', { groupDescription: 'DynamoDB PayPerRequest Read Request Units', operation: 'PayPerRequestThroughput' }, 500_000],
      ['write', { groupDescription: 'DynamoDB PayPerRequest Write Request Units', operation: 'PayPerRequestThroughput' }, 500_000],
    ],
  }),

  'containers-kubernetes': {
    serviceCode: 'AmazonEKS',
    lookups: {
      // The usagetype carries a region prefix — US-EAST-1 becomes USEAST1 —
      // which the source constructed by hand. Tried exactly first; the
      // `fallback` below covers regions whose prefix does not follow that rule
      // (several do not, which is why the original had a fallback at all).
      cluster: (region) => ({
        regionCode: region,
        usagetype: `${region.toUpperCase().replace(/-/g, '')}-AmazonEKS-Hours:perCluster`,
        operation: 'CreateOperation',
      }),
    },
    fallback: {
      cluster: (region) => ({
        query: { regionCode: region, operation: 'CreateOperation' },
        // The API cannot express "endswith", so widen the query and filter
        // locally. 100 is the API's maximum page size; EKS has few products.
        maxResults: 100,
        refine: (d) => String(d.attributes?.usagetype || '').endsWith('AmazonEKS-Hours:perCluster'),
      }),
    },
    price: ({ cluster }) => ({
      sku: 'Amazon EKS cluster usage',
      unit: 'hour',
      pricePerUnit: cluster.usd,
    }),
  },

  'integration-messaging': {
    serviceCode: 'AWSQueueService',
    lookups: {
      requests: inRegion({
        group: 'SQS-APIRequest-Tier1',
        queueType: 'Standard',
      }),
    },
    // SQS prices its free tier as a $0 dimension that sorts first.
    dimensionOptions: { firstNonZero: true },
    price: ({ requests }) => ({
      sku: MESSAGING_BENCHMARK_SKU,
      unit: MESSAGING_BENCHMARK_UNIT,
      pricePerUnit: requests.usd * 1_000_000,
    }),
  },

  'edge-cdn': {
    serviceCode: 'AmazonCloudFront',
    // Global — deliberately no regionCode filter. CloudFront's offer document
    // is priced by from/to location, not by region.
    lookups: {
      transfer: () => ({
        transferType: 'CloudFront Outbound',
        fromLocation: 'United States',
        toLocation: 'External',
      }),
    },
    price: ({ transfer }) => ({
      sku: 'United States edge outbound first-tier transfer',
      unit: 'GB egress',
      pricePerUnit: transfer.usd,
    }),
  },
};

let cachedClient = null;

/** Lazily construct the SDK client. Credentials come from the environment. */
export function getPricingClient() {
  if (!cachedClient) cachedClient = new PricingClient({ region: PRICING_API_REGION });
  return cachedClient;
}

/** Reset the memoised client. Tests only. */
export function resetPricingClient() {
  cachedClient = null;
}

/**
 * Resolve one service's AWS price.
 *
 * @param {string} serviceId
 * @param {string} providerRegion  already mapped through resolveProviderRegion
 * @param {{ client?: PricingClient }} [deps]
 * @returns {Promise<{sku: string, unit: string, pricePerUnit: number}|null>}
 */
export async function fetchAwsPrice(serviceId, providerRegion, deps = {}) {
  const config = AWS_SERVICE_LOOKUPS[serviceId];
  if (!config) return null;

  const client = deps.client ?? getPricingClient();
  const results = {};

  for (const [name, buildFilters] of Object.entries(config.lookups)) {
    let dimension = await getAwsPrice(
      client,
      config.serviceCode,
      buildFilters(providerRegion),
      config.dimensionOptions ?? {}
    );

    if (!dimension && config.fallback?.[name]) {
      const { query, maxResults, refine } = config.fallback[name](providerRegion);
      dimension = await getAwsPrice(client, config.serviceCode, query, {
        ...(config.dimensionOptions ?? {}),
        maxResults,
        refine,
      });
    }

    // Every lookup a service declares is required; a partial result would
    // silently under-price a composed benchmark.
    if (!dimension) return null;
    results[name] = dimension;
  }

  return config.price(results);
}
