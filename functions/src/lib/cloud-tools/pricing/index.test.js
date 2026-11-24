import { describe, expect, it, vi } from 'vitest';

import { fetchLivePricing } from './index.js';
import { AZURE_SERVICE_FILTERS } from './azure.js';
import {
  BASELINE_COSTS,
  KNOWN_UNIT_MISMATCHES,
  PROVIDERS,
  baselineFor,
  fallbackBaselineFor,
} from './baseline.js';

const ROW_KEYS = [
  'currency',
  'model',
  'pricePerUnit',
  'provider',
  'providerRegion',
  'region',
  'serviceId',
  'sku',
  'source',
  'unit',
  'updatedAt',
];

const silent = { warn: vi.fn(), info: vi.fn() };
const triple = (over = {}) => ({ sku: 'S', unit: 'hour', pricePerUnit: 1.5, ...over });

/** All three loaders resolve unless overridden. */
const loaders = (over = {}) => ({
  aws: async () => triple({ sku: 'aws-sku' }),
  azure: async () => triple({ sku: 'azure-sku' }),
  gcp: async () => triple({ sku: 'gcp-sku' }),
  ...over,
});

const baseline = BASELINE_COSTS['compute-vm'];

describe('row composition', () => {
  it('emits the eleven-key row for every provider, in order', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders(),
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.provider)).toEqual(['aws', 'azure', 'gcp']);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
  });

  it('gives a live row and a fallback row an identical shape', async () => {
    // The reason the row is composed in one place: in the source each provider
    // built its own copy, so this was true only by coincidence.
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders({ azure: async () => null }),
    });

    const [live, fallback] = [rows[0], rows[1]];
    expect(live.model).toBe('retail');
    expect(fallback.model).toBe('baseline-fallback');
    expect(Object.keys(live).sort()).toEqual(Object.keys(fallback).sort());
  });

  it('maps the provider region per provider', async () => {
    const rows = await fetchLivePricing('compute-vm', 'eastus', baseline, {
      logger: silent,
      loaders: loaders(),
    });
    expect(rows.map((r) => r.providerRegion)).toEqual(['us-east-1', 'eastus', 'us-central1']);
  });

  it('rounds to six decimal places', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders({ aws: async () => triple({ pricePerUnit: 0.19212345678 }) }),
    });
    expect(rows[0].pricePerUnit).toBe(0.192123);
  });

  it('defaults currency to USD but lets a provider override it', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders({ azure: async () => triple({ currency: 'EUR' }) }),
    });
    expect(rows[0].currency).toBe('USD');
    expect(rows[1].currency).toBe('EUR');
  });

  it('stamps every row in one call with the same updatedAt', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders(),
    });
    expect(new Set(rows.map((r) => r.updatedAt)).size).toBe(1);
  });

  it('tags the source per provider', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: silent,
      loaders: loaders(),
    });
    expect(rows.map((r) => r.source)).toEqual([
      'aws-price-list-query-api',
      'azure-retail-prices-api',
      'gcp-cloud-billing-catalog-api',
    ]);
  });
});

describe('provider isolation', () => {
  it('one provider throwing does not affect the other two', async () => {
    // The single most important behaviour in this module.
    const logger = { warn: vi.fn() };
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger,
      loaders: loaders({
        azure: async () => {
          throw new Error('azure exploded');
        },
      }),
    });

    expect(rows).toHaveLength(3);
    expect(rows[0].model).toBe('retail');
    expect(rows[1].model).toBe('baseline-fallback');
    expect(rows[2].model).toBe('retail');
  });

  it('survives all three failing', async () => {
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger: { warn: vi.fn() },
      loaders: loaders({
        aws: async () => {
          throw new Error('a');
        },
        azure: async () => {
          throw new Error('b');
        },
        gcp: async () => {
          throw new Error('c');
        },
      }),
    });
    expect(rows.map((r) => r.model)).toEqual(Array(3).fill('baseline-fallback'));
  });

  it('drops the provider entirely when there is no baseline to fall back to', async () => {
    const rows = await fetchLivePricing('unknown-service', 'us-east-1', null, {
      logger: { warn: vi.fn() },
      loaders: loaders({ aws: async () => null, azure: async () => null, gcp: async () => null }),
    });
    expect(rows).toEqual([]);
  });
});

describe('logging distinguishes a miss from a failure', () => {
  it('logs FAILED with the error code, never its message, when a provider throws', async () => {
    const logger = { warn: vi.fn() };
    await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger,
      loaders: loaders({
        aws: async () => {
          throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
        },
      }),
    });

    const failed = logger.warn.mock.calls.find(([msg]) => msg.includes('FAILED'));
    expect(failed[1]).toMatchObject({ provider: 'aws', code: 'ETIMEDOUT' });
    expect(JSON.stringify(failed)).not.toContain('boom');
  });

  it('logs NOT FOUND when a provider returns null', async () => {
    // The source logged nothing here, so a null was indistinguishable from
    // never having attempted the lookup.
    const logger = { warn: vi.fn() };
    await fetchLivePricing('compute-vm', 'us-east-1', baseline, {
      logger,
      loaders: loaders({ gcp: async () => null }),
    });

    const missed = logger.warn.mock.calls.find(([msg]) => msg.includes('NOT FOUND'));
    expect(missed[1]).toMatchObject({ provider: 'gcp', serviceId: 'compute-vm' });
  });

  it('says nothing when every provider resolves', async () => {
    const logger = { warn: vi.fn() };
    await fetchLivePricing('compute-vm', 'us-east-1', baseline, { logger, loaders: loaders() });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('baseline catalog', () => {
  it('covers all eight services for all three providers', () => {
    expect(Object.keys(BASELINE_COSTS)).toHaveLength(8);
    for (const [id, row] of Object.entries(BASELINE_COSTS)) {
      expect(row.unit, id).toBeTruthy();
      expect(row.sku, id).toBeTruthy();
      for (const p of PROVIDERS) expect(typeof row[p], `${id}.${p}`).toBe('number');
    }
  });

  it('states edge-cdn in the unit the live paths emit', () => {
    // Was 'TB egress' at 85/81/78. Identical prices, restated so a mixed
    // live/fallback row does not render 0.085 beside 81.
    expect(BASELINE_COSTS['edge-cdn']).toMatchObject({
      unit: 'GB egress',
      aws: 0.085,
      azure: 0.081,
      gcp: 0.078,
    });
    expect(AZURE_SERVICE_FILTERS['edge-cdn'].unit).toBe('GB egress');
  });

  it('has exactly the two known baseline/live unit mismatches, and no more', () => {
    // A mismatch means a mixed row compares different meters. These two are not
    // convertible — they are different benchmarks, so fixing them needs a
    // catalog decision rather than arithmetic. This test exists to stop a THIRD
    // appearing unnoticed.
    const actual = Object.entries(AZURE_SERVICE_FILTERS)
      .filter(([id, config]) => BASELINE_COSTS[id].unit !== config.unit)
      .map(([id]) => id);

    expect(new Set(actual)).toEqual(KNOWN_UNIT_MISMATCHES);
    expect(actual.sort()).toEqual(['compute-serverless', 'database-nosql']);
  });

  it('offers no fallback for the two mismatched services (owner decision 2026-09-15)', () => {
    // A live miss for these is an absent row, never a number in the wrong
    // unit beside a live one. The catalog entry itself is untouched.
    for (const id of KNOWN_UNIT_MISMATCHES) {
      expect(fallbackBaselineFor(id), id).toBeNull();
      expect(baselineFor(id), id).not.toBeNull();
    }
    for (const id of Object.keys(BASELINE_COSTS)) {
      if (KNOWN_UNIT_MISMATCHES.has(id)) continue;
      expect(fallbackBaselineFor(id), id).toBe(BASELINE_COSTS[id]);
    }
    expect(fallbackBaselineFor('unknown-service')).toBeNull();
  });

  it('a mismatched service with no live price yields no row at all', async () => {
    // The decision, end to end: the refresh passes fallbackBaselineFor, so a
    // miss on compute-serverless drops the provider rather than rendering
    // 2.65 per million invocations beside a normalized-workload figure.
    const rows = await fetchLivePricing(
      'compute-serverless',
      'us-east-1',
      fallbackBaselineFor('compute-serverless'),
      { logger: silent, loaders: loaders({ azure: async () => null }) }
    );
    expect(rows.map((r) => r.provider)).toEqual(['aws', 'gcp']);
    expect(rows.every((r) => r.model === 'retail')).toBe(true);
  });
});
