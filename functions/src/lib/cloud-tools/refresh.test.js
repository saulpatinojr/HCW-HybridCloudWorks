import { describe, expect, it, vi } from 'vitest';

import {
  CACHE_CONTAINER,
  HISTORY_CONTAINER,
  REFRESH_JOB_TYPE,
  createPricingRefresh,
  parseRefreshPayload,
} from './refresh.js';
import { BASELINE_COSTS, KNOWN_UNIT_MISMATCHES, PROVIDERS } from './pricing/baseline.js';
import { REGION_OPTIONS, SERVICE_LABELS } from './pricing/regions.js';
import { DEFAULT_CACHE_TTL_MINUTES } from './freshness.js';

const NOW = new Date('2026-09-15T02:00:00.000Z');
const SERVICE_IDS = Object.keys(BASELINE_COSTS);

const memStore = (seed = []) => {
  const docs = new Map();
  for (const [container, doc] of seed) docs.set(`${container}/${doc.id}`, doc);
  return {
    docs,
    upsertDoc: vi.fn(async (container, doc) => {
      docs.set(`${container}/${doc.id}`, doc);
      return doc;
    }),
    readDoc: vi.fn(async (container, id) => docs.get(`${container}/${id}`) ?? null),
  };
};

/** Every document written to a container, in write order. */
const written = (store, container) =>
  store.upsertDoc.mock.calls.filter(([c]) => c === container).map(([, doc]) => doc);

const row = (provider, serviceId, region, model = 'retail') => ({
  provider,
  serviceId,
  region,
  providerRegion: region,
  sku: `${provider}-sku`,
  model,
  pricePerUnit: 1,
  unit: 'hour',
  currency: 'USD',
  updatedAt: NOW.toISOString(),
  source: model === 'retail' ? `${provider}-api` : 'baseline-fallback',
});

/** A fetch that answers every provider live, and records its calls in order. */
const allLive = () =>
  vi.fn(async (serviceId, region) => PROVIDERS.map((p) => row(p, serviceId, region)));

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('parseRefreshPayload', () => {
  it('defaults to every region option', () => {
    const all = REGION_OPTIONS.map((r) => r.id);
    expect(parseRefreshPayload(undefined).regions).toEqual(all);
    expect(parseRefreshPayload({}).regions).toEqual(all);
    expect(parseRefreshPayload({ regions: [] }).regions).toEqual(all);
    expect(parseRefreshPayload({ regions: null }).regions).toEqual(all);
  });

  it('accepts a subset and dedupes it', () => {
    expect(parseRefreshPayload({ regions: ['westeurope', 'westeurope'] }).regions).toEqual([
      'westeurope',
    ]);
  });

  it('refuses an unknown region rather than refreshing nothing', () => {
    expect(() => parseRefreshPayload({ regions: ['eastus'] })).toThrow(/unknown region.*eastus/);
    expect(() => parseRefreshPayload({ regions: 'us-east-1' })).toThrow(/must be an array/);
  });
});

describe('createPricingRefresh', () => {
  it('writes one document per region, the whole catalog in each, in the contract shape', async () => {
    const store = memStore();
    const fetchLivePricing = allLive();
    const refresh = createPricingRefresh({ store, fetchLivePricing, now: () => NOW, log: quiet });

    const summary = await refresh.run();

    // Per region: the cache document, the day's snapshot, the change document.
    expect(store.upsertDoc).toHaveBeenCalledTimes(REGION_OPTIONS.length * 3);
    for (const option of REGION_OPTIONS) {
      const doc = store.docs.get(`${CACHE_CONTAINER}/pricing:${option.id}`);
      expect(doc).toMatchObject({
        id: `pricing:${option.id}`,
        region: option.id,
        refreshedAt: NOW.toISOString(),
        ttlMinutes: DEFAULT_CACHE_TTL_MINUTES,
        counts: { live: 24, baseline: 0, unavailable: 0 },
      });
      expect(doc.services.map((s) => s.serviceId)).toEqual(SERVICE_IDS);
      for (const service of doc.services) {
        expect(service.label).toBe(SERVICE_LABELS[service.serviceId]);
        expect(service.rows.map((r) => r.provider)).toEqual([...PROVIDERS]);
        expect(service.unit).toBe('hour');
        expect(Object.keys(service).sort()).toEqual(['label', 'rows', 'serviceId', 'sku', 'unit']);
      }
    }
    expect(summary.regions.map((r) => r.region)).toEqual(REGION_OPTIONS.map((r) => r.id));
    expect(summary.failed).toEqual([]);
    expect(summary.durationMs).toBe(0);
    // The summary names the region, its counts, the stamp and the change
    // counts — not the services, which are the document's, not the job's.
    for (const region of summary.regions) {
      expect(Object.keys(region).sort()).toEqual(['changes', 'counts', 'refreshedAt', 'region']);
    }
  });

  describe('price history (#613 Phase 3)', () => {
    it('writes the day snapshot after the cache document, then the change document from it', async () => {
      const store = memStore();
      const { regions } = await createPricingRefresh({
        store,
        fetchLivePricing: allLive(),
        now: () => NOW,
        log: quiet,
      }).run({ regions: ['us-east-1'] });

      expect(
        store.upsertDoc.mock.calls.map(([container, doc]) => `${container}/${doc.id}`)
      ).toEqual([
        'tool_service_cache/pricing:us-east-1',
        'tool_price_history/history:us-east-1:2026-09-15',
        'tool_service_cache/price-changes:us-east-1',
      ]);
      const snapshot = store.docs.get(`${HISTORY_CONTAINER}/history:us-east-1:2026-09-15`);
      expect(snapshot).toMatchObject({
        region: 'us-east-1',
        day: '2026-09-15',
        refreshedAt: NOW.toISOString(),
      });
      expect(Object.keys(snapshot.cells)).toHaveLength(SERVICE_IDS.length * PROVIDERS.length);
      expect(snapshot.cells['compute-vm:aws']).toEqual({
        pricePerUnit: 1,
        unit: 'hour',
        sku: 'aws-sku',
        currency: 'USD',
        source: 'live',
      });

      // Nothing older to compare against yet: both windows empty, and the
      // summary says so with sampleDays 0 rather than "no changes".
      const changes = store.docs.get(`${CACHE_CONTAINER}/price-changes:us-east-1`);
      expect(changes).toMatchObject({
        region: 'us-east-1',
        asOf: NOW.toISOString(),
        sampleDays: 0,
      });
      expect(changes.windows['7d']).toEqual({ since: '2026-09-08', sampleDay: null, items: [] });
      expect(regions[0].changes).toEqual({ '7d': 0, '30d': 0, sampleDays: 0 });
    });

    it('records a baseline row as baseline in the snapshot, so a later live price is not a "change" from it', async () => {
      const fetchLivePricing = vi.fn(async (serviceId, region) => [
        row('aws', serviceId, region, 'baseline-fallback'),
        row('azure', serviceId, region),
        row('gcp', serviceId, region),
      ]);
      const store = memStore();
      await createPricingRefresh({ store, fetchLivePricing, now: () => NOW, log: quiet }).run({
        regions: ['westeurope'],
      });
      const snapshot = store.docs.get(`${HISTORY_CONTAINER}/history:westeurope:2026-09-15`);
      expect(snapshot.cells['compute-vm:aws'].source).toBe('baseline');
      expect(snapshot.cells['compute-vm:azure'].source).toBe('live');
    });

    it('diffs today against the snapshot a week old and reports the moves', async () => {
      const weekAgo = {
        id: 'history:us-east-1:2026-09-08',
        region: 'us-east-1',
        day: '2026-09-08',
        cells: Object.fromEntries(
          SERVICE_IDS.flatMap((serviceId) =>
            PROVIDERS.map((p) => [
              `${serviceId}:${p}`,
              // Azure's VM price was 0.8 a week ago; everything else 1, as today.
              {
                pricePerUnit: serviceId === 'compute-vm' && p === 'azure' ? 0.8 : 1,
                unit: 'hour',
                sku: `${p}-sku`,
                currency: 'USD',
                source: 'live',
              },
            ])
          )
        ),
      };
      const store = memStore([[HISTORY_CONTAINER, weekAgo]]);
      const { regions } = await createPricingRefresh({
        store,
        fetchLivePricing: allLive(),
        now: () => NOW,
        log: quiet,
      }).run({ regions: ['us-east-1'] });

      const changes = store.docs.get(`${CACHE_CONTAINER}/price-changes:us-east-1`);
      expect(changes.windows['7d']).toEqual({
        since: '2026-09-08',
        sampleDay: '2026-09-08',
        items: [
          {
            serviceId: 'compute-vm',
            label: SERVICE_LABELS['compute-vm'],
            provider: 'azure',
            unit: 'hour',
            sku: 'azure-sku',
            from: 0.8,
            to: 1,
            deltaPct: 25,
          },
        ],
      });
      expect(changes.windows['30d']).toEqual({ since: '2026-08-16', sampleDay: null, items: [] });
      expect(changes.sampleDays).toBe(1);
      expect(regions[0].changes).toEqual({ '7d': 1, '30d': 0, sampleDays: 1 });
      // History is read by id, id as partition key, never queried.
      for (const [container, id, pk] of store.readDoc.mock.calls) {
        expect(container).toBe(HISTORY_CONTAINER);
        expect(pk).toBe(id);
      }
    });

    it('a history failure is logged and recorded, and the region still counts as refreshed', async () => {
      const store = memStore();
      store.upsertDoc.mockImplementation(async (container, doc) => {
        if (container === HISTORY_CONTAINER) throw new Error('history container missing');
        store.docs.set(`${container}/${doc.id}`, doc);
        return doc;
      });
      const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const summary = await createPricingRefresh({
        store,
        fetchLivePricing: allLive(),
        now: () => NOW,
        log,
      }).run({ regions: ['us-east-1', 'us-west-2'] });

      // Both cache documents stand; neither change document was written.
      expect(store.docs.has(`${CACHE_CONTAINER}/pricing:us-east-1`)).toBe(true);
      expect(store.docs.has(`${CACHE_CONTAINER}/pricing:us-west-2`)).toBe(true);
      expect(written(store, CACHE_CONTAINER).map((d) => d.id)).toEqual([
        'pricing:us-east-1',
        'pricing:us-west-2',
      ]);
      expect(summary.regions.map((r) => [r.region, r.changes])).toEqual([
        ['us-east-1', null],
        ['us-west-2', null],
      ]);
      // A sentence with the code and the log line's reference, and a
      // content-free log line: the store's words reach neither (#945).
      const historyFailed = expect.stringMatching(
        /^The region's price history could not be written \(Error; reference [\w.:-]+\)\.$/
      );
      expect(summary.failed).toEqual([
        { region: 'us-east-1', error: historyFailed },
        { region: 'us-west-2', error: historyFailed },
      ]);
      expect(log.error).toHaveBeenCalledWith(
        expect.stringMatching(/The region's price history could not be written \(name=Error( at=[^)]+)?\)$/)
      );
      expect(JSON.stringify([summary.failed, log.error.mock.calls])).not.toContain(
        'history container missing'
      );
    });
  });

  it('fetches services one at a time, never in parallel', async () => {
    // AWS and Azure rate-limit; 72 concurrent calls is how a refresh gets
    // throttled into a partial document.
    let inFlight = 0;
    let peak = 0;
    const fetchLivePricing = vi.fn(async (serviceId, region) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return PROVIDERS.map((p) => row(p, serviceId, region));
    });
    await createPricingRefresh({ store: memStore(), fetchLivePricing, log: quiet }).run();
    expect(fetchLivePricing).toHaveBeenCalledTimes(REGION_OPTIONS.length * SERVICE_IDS.length);
    expect(peak).toBe(1);
  });

  it('passes no baseline for the two unit-mismatched services, and the catalog entry for the rest', async () => {
    const fetchLivePricing = allLive();
    await createPricingRefresh({ store: memStore(), fetchLivePricing, log: quiet }).run({
      regions: ['us-east-1'],
    });
    for (const [serviceId, , baseline] of fetchLivePricing.mock.calls) {
      if (KNOWN_UNIT_MISMATCHES.has(serviceId)) expect(baseline, serviceId).toBeNull();
      else expect(baseline, serviceId).toBe(BASELINE_COSTS[serviceId]);
    }
  });

  it('counts live, baseline and unavailable cells from the rows it gets back', async () => {
    const fetchLivePricing = vi.fn(async (serviceId, region) => {
      if (serviceId === 'compute-serverless') return [row('aws', serviceId, region)]; // two absent
      if (serviceId === 'compute-vm') {
        return [
          row('aws', serviceId, region),
          row('azure', serviceId, region, 'baseline-fallback'),
          row('gcp', serviceId, region, 'baseline-fallback'),
        ];
      }
      return PROVIDERS.map((p) => row(p, serviceId, region));
    });
    const store = memStore();
    const { regions } = await createPricingRefresh({ store, fetchLivePricing, log: quiet }).run({
      regions: ['us-west-2'],
    });
    expect(regions[0].counts).toEqual({ live: 20, baseline: 2, unavailable: 2 });
    const doc = store.docs.get(`${CACHE_CONTAINER}/pricing:us-west-2`);
    expect(doc.counts).toEqual(regions[0].counts);
    // The absent providers are absent, not padded with placeholder rows.
    const partial = doc.services.find((s) => s.serviceId === 'compute-serverless');
    expect(partial.rows.map((r) => r.provider)).toEqual(['aws']);
  });

  it('names the catalog unit and sku when a service has no rows at all', async () => {
    const fetchLivePricing = vi.fn(async (serviceId, region) =>
      serviceId === 'database-nosql' ? [] : PROVIDERS.map((p) => row(p, serviceId, region))
    );
    const store = memStore();
    await createPricingRefresh({ store, fetchLivePricing, log: quiet }).run({
      regions: ['westeurope'],
    });
    const doc = store.docs.get(`${CACHE_CONTAINER}/pricing:westeurope`);
    const nosql = doc.services.find((s) => s.serviceId === 'database-nosql');
    expect(nosql.rows).toEqual([]);
    expect(nosql.unit).toBe(BASELINE_COSTS['database-nosql'].unit);
    expect(nosql.sku).toBe(BASELINE_COSTS['database-nosql'].sku);
    expect(doc.counts.unavailable).toBe(3);
  });

  it('one region failing does not stop the others', async () => {
    const store = memStore();
    store.upsertDoc.mockImplementation(async (container, doc) => {
      if (doc.region === 'us-west-2') throw new Error('cosmos 503');
      store.docs.set(`${container}/${doc.id}`, doc);
      return doc;
    });
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const summary = await createPricingRefresh({
      store,
      fetchLivePricing: allLive(),
      log,
    }).run();

    expect(summary.regions.map((r) => r.region)).toEqual(['us-east-1', 'westeurope']);
    expect(summary.failed).toEqual([
      {
        region: 'us-west-2',
        error: expect.stringMatching(/^The region could not be refreshed \(Error; reference [\w.:-]+\)\.$/),
      },
    ]);
    expect(store.docs.has(`${CACHE_CONTAINER}/pricing:westeurope`)).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/The region could not be refreshed \(name=Error( at=[^)]+)?\)$/)
    );
    expect(JSON.stringify(summary.failed)).not.toContain('cosmos 503');
  });

  it('clears the memoised provider state once per run, before fetching', async () => {
    const order = [];
    const clearCaches = vi.fn(() => order.push('clear'));
    const fetchLivePricing = vi.fn(async (serviceId, region) => {
      order.push('fetch');
      return PROVIDERS.map((p) => row(p, serviceId, region));
    });
    await createPricingRefresh({
      store: memStore(),
      fetchLivePricing,
      clearCaches,
      log: quiet,
    }).run({ regions: ['us-east-1'] });
    expect(clearCaches).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('clear');
  });

  it('refuses an unknown region before touching anything', async () => {
    const store = memStore();
    const fetchLivePricing = allLive();
    await expect(
      createPricingRefresh({ store, fetchLivePricing, log: quiet }).run({ regions: ['eastus'] })
    ).rejects.toThrow(/unknown region/);
    expect(fetchLivePricing).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('names the job type the worker registers', () => {
    expect(REFRESH_JOB_TYPE).toBe('refresh-tool-pricing');
    expect(CACHE_CONTAINER).toBe('tool_service_cache');
  });
});
