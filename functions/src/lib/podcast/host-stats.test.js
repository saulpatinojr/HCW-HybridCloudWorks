/**
 * The Podbean statistics the Stats tab reads (#1115).
 *
 * Pinned: the three ranges map to the documented windows and periods; the
 * six sub-reads are independent, each failure recorded in its own place and
 * never thrown; the cache is per range, served for an hour, and skipped on
 * refresh; a cached document for another range is not served.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HOST_STATS_RANGES,
  HOST_STATS_REFRESH_FLOOR_MS,
  HOST_STATS_TTL_MS,
  fetchHostStats,
  hostStatsConfigId,
  parseRange,
  readHostStats,
  sumCounts,
  windowForRange,
} from './host-stats.js';
import { isYoungerThan, readThroughCache } from './host-cache.js';
import { PodbeanError } from './podbean.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

const NOW = new Date('2026-10-13T15:30:00.000Z');
const now = () => NOW;

const BY_DAY = { '2026-10-11': 2, '2026-10-12': 3 };
const COUNTRIES = { US: 4026, GH: 1429 };
const PLATFORMS = { Android: 1685, iOS: 1125 };
const SOURCES = { 'Podbean App': 2547, 'Apple Podcasts': 2048 };
const RETENTION = { 'Aug 04-Aug 10': [{ listeners: 12, retention: 1 }] };
const REPORT = { followers: 3, likes: 1, comments: 0, total_episode_length: 5400 };

const makeClient = (over = {}) => ({
  getDownloadStats: vi.fn(async () => BY_DAY),
  getCountryStats: vi.fn(async () => COUNTRIES),
  getPlatformStats: vi.fn(async () => PLATFORMS),
  getSourceStats: vi.fn(async () => SOURCES),
  getUserRetention: vi.fn(async () => RETENTION),
  getAnalyticReports: vi.fn(async () => REPORT),
  ...over,
});

const makeStore = (over = {}) => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, doc) => doc),
  ...over,
});

const refused = (code, status) =>
  new PodbeanError(`Podbean answered ${status} while reading.`, {
    status,
    code,
    retryable: status === 429 || status >= 500,
  });

describe('ranges and windows', () => {
  it('accepts exactly the three ranges and nothing else', () => {
    expect(HOST_STATS_RANGES).toEqual(['30d', '90d', '12m']);
    for (const range of HOST_STATS_RANGES) expect(parseRange(range)).toBe(range);
    expect(parseRange(' 90d ')).toBe('90d');
    for (const bad of ['7d', '30D', '', null, undefined, 30, '12m;drop']) {
      expect(parseRange(bad), String(bad)).toBeNull();
    }
  });

  it('30d and 90d are daily windows ending today; 12m is monthly from the first of the month eleven back', () => {
    expect(windowForRange('30d', NOW)).toEqual({ start: '2026-09-14', end: '2026-10-13', period: 'd' });
    expect(windowForRange('90d', NOW)).toEqual({ start: '2026-07-16', end: '2026-10-13', period: 'd' });
    expect(windowForRange('12m', NOW)).toEqual({ start: '2025-11-01', end: '2026-10-13', period: 'm' });
    // Across a year boundary, the month arithmetic rolls back a year.
    expect(windowForRange('12m', new Date('2026-01-31T23:00:00Z'))).toEqual({
      start: '2025-02-01',
      end: '2026-01-31',
      period: 'm',
    });
  });

  it('each range has its own cache document', () => {
    expect(hostStatsConfigId('30d')).toBe('podbean_host_stats_30d');
    expect(hostStatsConfigId('12m')).toBe('podbean_host_stats_12m');
  });

  it('sumCounts ignores what is not a number', () => {
    expect(sumCounts({ a: 1, b: '2', c: 'x', d: null })).toBe(3);
    expect(sumCounts(null)).toBe(0);
    expect(sumCounts([1, 2])).toBe(0);
  });
});

describe('fetchHostStats', () => {
  it('reads the six statistics over the range’s window and shapes them', async () => {
    const client = makeClient();
    const out = await fetchHostStats({ client, now, range: '30d' });
    const window = { start: '2026-09-14', end: '2026-10-13', period: 'd' };
    expect(client.getDownloadStats).toHaveBeenCalledWith(window);
    expect(client.getCountryStats).toHaveBeenCalledWith(window);
    expect(client.getPlatformStats).toHaveBeenCalledWith(window);
    expect(client.getSourceStats).toHaveBeenCalledWith(window);
    expect(client.getUserRetention).toHaveBeenCalledWith({ period: 'm' });
    expect(client.getAnalyticReports).toHaveBeenCalledWith({
      types: ['followers', 'likes', 'comments', 'total_episode_length'],
    });
    expect(out).toEqual({
      fetchedAt: NOW.toISOString(),
      range: '30d',
      window,
      downloads: { byPeriod: BY_DAY, total: 5 },
      countries: COUNTRIES,
      platforms: PLATFORMS,
      sources: SOURCES,
      retention: RETENTION,
      audience: { followers: 3, likes: 1, comments: 0, totalEpisodeLengthSeconds: 5400 },
      errors: {},
    });
  });

  it('12m reads monthly and passes the monthly map through as given', async () => {
    const monthly = { '2026-09': 40, '2026-10': 2 };
    const client = makeClient({ getDownloadStats: vi.fn(async () => monthly) });
    const out = await fetchHostStats({ client, now, range: '12m' });
    expect(client.getDownloadStats).toHaveBeenCalledWith({
      start: '2025-11-01',
      end: '2026-10-13',
      period: 'm',
    });
    expect(out.downloads).toEqual({ byPeriod: monthly, total: 42 });
    expect(out.range).toBe('12m');
  });

  it('a failed sub-read is null in its place and recorded under errors, and the others still answer', async () => {
    const client = makeClient({
      getCountryStats: vi.fn(async () => {
        throw refused('UPSTREAM', 429);
      }),
      getAnalyticReports: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const out = await fetchHostStats({ client, now, range: '90d' });
    expect(out.countries).toBeNull();
    expect(out.audience).toBeNull();
    expect(out.errors).toEqual({
      countries: {
        status: 429,
        code: 'UPSTREAM',
        message: 'Podbean answered 429 while reading.',
        retryable: true,
      },
      audience: {
        status: null,
        code: 'UNEXPECTED',
        message: 'The Podbean step failed unexpectedly (TypeError).',
        retryable: false,
      },
    });
    expect(out.downloads.total).toBe(5);
    expect(out.platforms).toEqual(PLATFORMS);
    expect(out.sources).toEqual(SOURCES);
    expect(out.retention).toEqual(RETENTION);
  });

  it('an answer that is not a map reads as empty, and a report with missing or non-numeric fields as null fields', async () => {
    const client = makeClient({
      getCountryStats: vi.fn(async () => 'nope'),
      getDownloadStats: vi.fn(async () => null),
      getAnalyticReports: vi.fn(async () => ({ followers: '7', likes: 'many' })),
    });
    const out = await fetchHostStats({ client, now, range: '30d' });
    expect(out.countries).toEqual({});
    expect(out.downloads).toEqual({ byPeriod: {}, total: 0 });
    expect(out.audience).toEqual({
      followers: 7,
      likes: null,
      comments: null,
      totalEpisodeLengthSeconds: null,
    });
    expect(out.errors).toEqual({});
  });
});

describe('readHostStats (the per-range cache)', () => {
  const cachedDoc = (range = '30d', over = {}) => ({
    id: hostStatsConfigId(range),
    configScope: ADMIN_CONFIG_PARTITION,
    _etag: '"e1"',
    fetchedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    range,
    window: { start: '2026-09-14', end: '2026-10-13', period: 'd' },
    downloads: { byPeriod: {}, total: 99 },
    countries: {},
    platforms: {},
    sources: {},
    retention: null,
    audience: null,
    errors: {},
    ...over,
  });

  it('serves the range’s cached document while it is under an hour old, touching Podbean for nothing', async () => {
    const client = makeClient();
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc('30d')) });
    const out = await readHostStats({ client, store, range: '30d', now });
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'podbean_host_stats_30d', ADMIN_CONFIG_PARTITION);
    expect(out.cached).toBe(true);
    expect(out.downloads.total).toBe(99);
    expect(out).not.toHaveProperty('_etag');
    expect(out).not.toHaveProperty('configScope');
    for (const read of Object.values(client)) expect(read).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('reads live and writes the range’s document when the cache is stale, absent, or for another range', async () => {
    for (const stored of [
      null,
      cachedDoc('30d', { fetchedAt: new Date(NOW.getTime() - HOST_STATS_TTL_MS).toISOString() }),
      cachedDoc('90d'),
    ]) {
      const client = makeClient();
      const store = makeStore({ readDoc: vi.fn(async () => stored) });
      const out = await readHostStats({ client, store, range: '30d', now });
      expect(out.cached).toBe(false);
      expect(out.downloads.total).toBe(5);
      expect(client.getDownloadStats).toHaveBeenCalledTimes(1);
      const [container, doc] = store.upsertDoc.mock.calls[0];
      expect(container).toBe('admin_config');
      expect(doc).toMatchObject({
        id: 'podbean_host_stats_30d',
        configScope: ADMIN_CONFIG_PARTITION,
        range: '30d',
        fetchedAt: NOW.toISOString(),
      });
      expect(doc).not.toHaveProperty('cached');
    }
  });

  it('refresh skips the cache read, reads live, and replaces the stored document under its etag', async () => {
    const client = makeClient();
    const stored = { ...cachedDoc('30d'), _etag: '"s1"', fetchedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    const store = makeStore({ readDoc: vi.fn(async () => stored), replaceDocIfMatch: vi.fn(async (_c, doc) => doc) });
    const out = await readHostStats({ client, store, range: '30d', now, refresh: true });
    // Two reads: the floor check before the live read, and the write's own freshness check.
    expect(store.readDoc).toHaveBeenCalledTimes(2);
    expect(out.cached).toBe(false);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch.mock.calls[0][1]).toMatchObject({ _etag: '"s1"', fetchedAt: NOW.toISOString() });
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('a refresh within the floor serves the range’s cache, so every session together makes one live read a minute', async () => {
    expect(HOST_STATS_REFRESH_FLOOR_MS).toBe(60_000);
    const client = makeClient();
    const log = vi.fn();
    const young = cachedDoc('30d', { fetchedAt: new Date(NOW.getTime() - 30_000).toISOString() });
    const store = makeStore({ readDoc: vi.fn(async () => young) });
    const out = await readHostStats({ client, store, range: '30d', now, refresh: true, log });
    expect(out.cached).toBe(true);
    expect(out.downloads.total).toBe(99);
    expect(client.getDownloadStats).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('podbean stats 30d: refresh within the floor; serving the cache');

    const past = cachedDoc('30d', { fetchedAt: new Date(NOW.getTime() - 61_000).toISOString() });
    const live = makeStore({ readDoc: vi.fn(async () => past) });
    expect((await readHostStats({ client: makeClient(), store: live, range: '30d', now, refresh: true })).cached).toBe(false);
  });

  it('a range cached for another Podbean account is a miss, and the live answer is written with the account key', async () => {
    const client = makeClient({ accountKey: 'acct-b' });
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc('30d', { accountKey: 'acct-a' })) });
    const out = await readHostStats({ client, store, range: '30d', now });
    expect(out.cached).toBe(false);
    expect(out.accountKey).toBe('acct-b');
    expect(client.getDownloadStats).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({ accountKey: 'acct-b' });

    const same = makeStore({ readDoc: vi.fn(async () => cachedDoc('30d', { accountKey: 'acct-b' })) });
    const hit = await readHostStats({ client: makeClient({ accountKey: 'acct-b' }), store: same, range: '30d', now });
    expect(hit.cached).toBe(true);
    expect(hit.accountKey).toBe('acct-b');

    expect(isYoungerThan(cachedDoc(), { now: NOW, ttlMs: HOST_STATS_TTL_MS })).toBe(true);
    expect(isYoungerThan(cachedDoc(), { now: NOW, ttlMs: HOST_STATS_TTL_MS, accountKey: 'acct-b' })).toBe(false);
  });

  it('creates, not upserts, when nothing is cached yet; a 409 means another first writer landed', async () => {
    const created = makeStore({ createDoc: vi.fn(async (_c, doc) => doc) });
    await readHostStats({ client: makeClient(), store: created, range: '30d', now });
    expect(created.createDoc).toHaveBeenCalledTimes(1);
    expect(created.upsertDoc).not.toHaveBeenCalled();

    const log = vi.fn();
    const lost = makeStore({
      createDoc: vi.fn(async () => {
        throw Object.assign(new Error('conflict'), { code: 409 });
      }),
    });
    const out = await readHostStats({ client: makeClient(), store: lost, range: '30d', now, log });
    expect(out.cached).toBe(false);
    expect(lost.upsertDoc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cache write failed (CONFLICT)'));
  });

  it('two refreshes finishing out of order: the stored document fetched later stands, and a 412 keeps what landed first', async () => {
    const client = makeClient();
    const newer = { ...cachedDoc('30d'), _etag: '"s2"', fetchedAt: new Date(NOW.getTime() + 60_000).toISOString() };
    const store = makeStore({ readDoc: vi.fn(async () => newer), replaceDocIfMatch: vi.fn() });
    await readHostStats({ client, store, range: '30d', now, refresh: true });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const log = vi.fn();
    const contended = makeStore({
      readDoc: vi.fn(async () => ({ ...cachedDoc('30d'), _etag: '"s3"', fetchedAt: '2026-01-01T00:00:00.000Z' })),
      replaceDocIfMatch: vi.fn(async () => {
        throw Object.assign(new Error('precondition failed'), { code: 412 });
      }),
    });
    const out = await readHostStats({ client: makeClient(), store: contended, range: '30d', now, refresh: true, log });
    expect(out.cached).toBe(false);
    expect(contended.upsertDoc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cache write failed (CHANGED)'));
  });

  it('a cache that cannot be read or written is logged by code, and the live answer is served', async () => {
    const log = vi.fn();
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error('Cosmos said: "Secret"'), { code: 503 });
      }),
      upsertDoc: vi.fn(async () => {
        throw Object.assign(new Error('write refused'), { code: 429 });
      }),
    });
    const out = await readHostStats({ client: makeClient(), store, range: '12m', now, log });
    expect(out.cached).toBe(false);
    expect(out.downloads.total).toBe(5);
    expect(log).toHaveBeenCalledWith('podbean stats 12m: cache read failed (503); reading live');
    expect(log).toHaveBeenCalledWith('podbean stats 12m: cache write failed (429); serving live');
    expect(log.mock.calls.flat().join(' ')).not.toContain('Secret');
  });
});

describe('host-cache', () => {
  it('isYoungerThan needs a parseable, non-negative age under the TTL', () => {
    const fresh = { fetchedAt: new Date(NOW.getTime() - 1).toISOString() };
    expect(isYoungerThan(fresh, { now: NOW, ttlMs: 1000 })).toBe(true);
    expect(isYoungerThan({ fetchedAt: NOW.toISOString() }, { now: NOW, ttlMs: 0 })).toBe(false);
    expect(isYoungerThan({ fetchedAt: 'not a date' }, { now: NOW, ttlMs: 1000 })).toBe(false);
    expect(isYoungerThan({ fetchedAt: new Date(NOW.getTime() + 1).toISOString() }, { now: NOW, ttlMs: 1000 })).toBe(false);
    expect(isYoungerThan(null, { now: NOW, ttlMs: 1000 })).toBe(false);
    expect(isYoungerThan({}, { now: NOW, ttlMs: 1000 })).toBe(false);
  });

  it('readThroughCache stores only the named fields and lets the live read’s own throw through', async () => {
    const store = makeStore();
    const out = await readThroughCache({
      store,
      id: 'x',
      fields: ['fetchedAt', 'a'],
      read: async () => ({ fetchedAt: NOW.toISOString(), a: 1, secret: 'no' }),
      now,
      ttlMs: 1000,
      label: 't',
    });
    // The live answer gains the account key (null for a client without one); the stored document only the named fields.
    expect(out).toEqual({ fetchedAt: NOW.toISOString(), a: 1, secret: 'no', accountKey: null, cached: false });
    expect(store.upsertDoc.mock.calls[0][1]).toEqual({
      id: 'x',
      configScope: ADMIN_CONFIG_PARTITION,
      fetchedAt: NOW.toISOString(),
      a: 1,
    });
    await expect(
      readThroughCache({
        store,
        id: 'x',
        fields: ['fetchedAt'],
        read: async () => {
          throw new Error('ours');
        },
        now,
        ttlMs: 1000,
        label: 't',
      })
    ).rejects.toThrow('ours');
  });
});
