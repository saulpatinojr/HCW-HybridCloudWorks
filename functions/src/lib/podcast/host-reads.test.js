/**
 * The Podbean overview the Distribution tab reads (#1115).
 *
 * What is pinned: the join is by episode id and keeps every row (listed or
 * not, sent by this hub or not); a Podbean failure lands where it happened
 * and never throws; the statistics reads stop at the cap, newest first; and
 * the cache is served while fresh, refreshed on request, and never a
 * dependency — a store that cannot read or write it still gets a live answer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HOST_OVERVIEW_CONFIG_ID,
  HOST_OVERVIEW_EPISODE_PAGE,
  HOST_OVERVIEW_STATS_CAP,
  HOST_OVERVIEW_TTL_MS,
  PUBLISHED_QUERY,
  fetchHostOverview,
  isFresh,
  readHostOverview,
  totalDownloads,
  windowEnding,
} from './host-reads.js';
import { PodbeanError } from './podbean.js';
import { TRANSCRIPT_CONTAINER } from './store.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

const NOW = new Date('2026-10-13T15:30:00.000Z');
const now = () => NOW;

/** Podbean's unix seconds for an ISO stamp. */
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

const liveEpisode = (id, over = {}) => ({
  id,
  title: `Episode ${id}`,
  permalink_url: `https://podcast.hybridcloudworks.com/e/${id}/`,
  media_url: `https://mcdn.podbean.com/mf/web/${id}.mp3`,
  publish_time: unix('2026-10-01T10:00:00Z'),
  status: 'publish',
  type: 'public',
  ...over,
});

const transcript = (id, episodeId, over = {}) => ({
  id,
  title: `Transcript ${id}`,
  generatedAt: '2026-10-01T09:00:00.000Z',
  host: {
    podbean: {
      episodeId,
      permalinkUrl: `https://podcast.hybridcloudworks.com/e/recorded-${episodeId}/`,
      hostStatus: 'publish',
      publishedAt: '2026-10-01T09:30:00.000Z',
    },
  },
  ...over,
});

const makeClient = (over = {}) => ({
  getPodcast: vi.fn(async () => ({
    podcast: { id: 'p1', title: 'Hybrid Cloud Insights', logo: 'https://x/logo.png', website: 'https://x' },
  })),
  listEpisodes: vi.fn(async () => ({ episodes: [], offset: 0, limit: 100, has_more: false, count: 0 })),
  getDownloadStats: vi.fn(async () => ({ '2026-10-11': 2, '2026-10-12': 3 })),
  ...over,
});

const makeStore = (over = {}) => ({
  queryDocs: vi.fn(async () => []),
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, doc) => doc),
  ...over,
});

const refused = (code, status = 429) =>
  new PodbeanError(`Podbean answered ${status} while reading.`, {
    status,
    code,
    retryable: status === 429 || status >= 500,
  });

describe('windowEnding and totalDownloads', () => {
  it('is `days` calendar days ending on the UTC day of now', () => {
    expect(windowEnding(NOW, 30)).toEqual({ start: '2026-09-14', end: '2026-10-13' });
    expect(windowEnding(NOW, 1)).toEqual({ start: '2026-10-13', end: '2026-10-13' });
    expect(windowEnding(new Date('2026-01-01T00:30:00Z'), 7)).toEqual({
      start: '2025-12-26',
      end: '2026-01-01',
    });
  });

  it('sums the map and ignores anything that is not a number', () => {
    expect(totalDownloads({ '2026-10-11': 2, '2026-10-12': '3', x: 'many' })).toBe(5);
    expect(totalDownloads(null)).toBe(0);
    expect(totalDownloads([])).toBe(0);
  });
});

describe('fetchHostOverview', () => {
  it('queries only transcripts with a string episode id, newest first, without the body', async () => {
    const store = makeStore();
    await fetchHostOverview({ client: makeClient(), store, now });
    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe(TRANSCRIPT_CONTAINER);
    expect(query).toBe(PUBLISHED_QUERY);
    expect(query).toContain('IS_STRING(c.host.podbean.episodeId)');
    expect(query).toMatch(/ ORDER BY c\.generatedAt DESC$/);
    expect(query).not.toContain('c.transcript');
    expect(params).toEqual([]);
  });

  it('reads the show and one page of 100 episodes, then joins by episode id', async () => {
    const client = makeClient({
      listEpisodes: vi.fn(async () => ({
        episodes: [
          liveEpisode('E1', { title: 'Live title', status: 'draft', publish_time: unix('2026-10-10T10:00:00Z') }),
          liveEpisode('E9', { publish_time: unix('2026-09-20T10:00:00Z') }),
        ],
      })),
    });
    const store = makeStore({ queryDocs: vi.fn(async () => [transcript('t1', 'E1')]) });
    const out = await fetchHostOverview({ client, store, now });

    expect(client.listEpisodes).toHaveBeenCalledWith({ offset: 0, limit: HOST_OVERVIEW_EPISODE_PAGE });
    expect(out.show).toEqual({
      id: 'p1',
      title: 'Hybrid Cloud Insights',
      logo: 'https://x/logo.png',
      website: 'https://x',
    });
    expect(out.fetchedAt).toBe(NOW.toISOString());
    expect(out.days).toBe(30);
    expect(out.range).toEqual({ start: '2026-09-14', end: '2026-10-13' });
    expect(out.errors).toEqual({});

    // The transcript's row carries Podbean's live fields, not the record's.
    const mine = out.episodes.find((row) => row.transcriptId === 't1');
    expect(mine).toMatchObject({
      episodeId: 'E1',
      title: 'Live title',
      hostStatus: 'draft',
      permalinkUrl: 'https://podcast.hybridcloudworks.com/e/E1/',
      publishTime: '2026-10-10T10:00:00.000Z',
      error: null,
    });
    // The hand-published episode is a row too, with no transcript.
    const theirs = out.episodes.find((row) => row.episodeId === 'E9');
    expect(theirs).toMatchObject({ transcriptId: null, title: 'Episode E9', hostStatus: 'publish' });
    // Newest publish first.
    expect(out.episodes.map((row) => row.episodeId)).toEqual(['E1', 'E9']);
  });

  it('reads the download window per episode and sums it', async () => {
    const client = makeClient({
      listEpisodes: vi.fn(async () => ({ episodes: [liveEpisode('E1')] })),
    });
    const store = makeStore({ queryDocs: vi.fn(async () => [transcript('t1', 'E1')]) });
    const out = await fetchHostOverview({ client, store, now });
    expect(client.getDownloadStats).toHaveBeenCalledWith({
      start: '2026-09-14',
      end: '2026-10-13',
      period: 'd',
      episodeId: 'E1',
    });
    expect(out.episodes[0].downloads).toEqual({
      total: 5,
      byDay: { '2026-10-11': 2, '2026-10-12': 3 },
    });
    expect(out.downloadsCapped).toBe(0);
  });

  it('a transcript whose episode is not in the page keeps the record and says NOT_LISTED', async () => {
    const store = makeStore({ queryDocs: vi.fn(async () => [transcript('t1', 'GONE')]) });
    const client = makeClient();
    const out = await fetchHostOverview({ client, store, now });
    expect(out.episodes).toHaveLength(1);
    expect(out.episodes[0]).toMatchObject({
      transcriptId: 't1',
      episodeId: 'GONE',
      title: 'Transcript t1',
      hostStatus: 'publish',
      permalinkUrl: 'https://podcast.hybridcloudworks.com/e/recorded-GONE/',
      publishTime: '2026-10-01T09:30:00.000Z',
      downloads: null,
    });
    expect(out.episodes[0].error.code).toBe('NOT_LISTED');
    expect(out.episodes[0].error.message).toContain(String(HOST_OVERVIEW_EPISODE_PAGE));
    expect(client.getDownloadStats).not.toHaveBeenCalled();
  });

  it('a failed listing is recorded on every transcript row and under errors.episodes, and reads no statistics', async () => {
    const client = makeClient({
      listEpisodes: vi.fn(async () => {
        throw refused('UPSTREAM', 429);
      }),
    });
    const store = makeStore({
      queryDocs: vi.fn(async () => [transcript('t1', 'E1'), transcript('t2', 'E2')]),
    });
    const out = await fetchHostOverview({ client, store, now });
    expect(out.errors.episodes).toEqual({
      status: 429,
      code: 'UPSTREAM',
      message: 'Podbean answered 429 while reading.',
      retryable: true,
    });
    expect(out.episodes).toHaveLength(2);
    for (const row of out.episodes) {
      expect(row.error).toEqual(out.errors.episodes);
      expect(row.downloads).toBeNull();
      expect(row.title).toMatch(/^Transcript /);
    }
    expect(client.getDownloadStats).not.toHaveBeenCalled();
    expect(out.show).not.toBeNull();
  });

  it('a failed show read is errors.show with show null; the rows still come', async () => {
    const client = makeClient({
      getPodcast: vi.fn(async () => {
        throw refused('CREDENTIALS_REJECTED', 403);
      }),
      listEpisodes: vi.fn(async () => ({ episodes: [liveEpisode('E1')] })),
    });
    const out = await fetchHostOverview({ client, store: makeStore(), now });
    expect(out.show).toBeNull();
    expect(out.errors.show.code).toBe('CREDENTIALS_REJECTED');
    expect(out.episodes).toHaveLength(1);
    expect(out.episodes[0].downloads.total).toBe(5);
  });

  it('a failed statistics read lands on its row only, in the recorded shape', async () => {
    const client = makeClient({
      listEpisodes: vi.fn(async () => ({ episodes: [liveEpisode('E1'), liveEpisode('E2')] })),
      getDownloadStats: vi.fn(async ({ episodeId }) => {
        if (episodeId === 'E1') throw refused('UPSTREAM', 500);
        return { '2026-10-12': 1 };
      }),
    });
    const out = await fetchHostOverview({ client, store: makeStore(), now });
    const e1 = out.episodes.find((row) => row.episodeId === 'E1');
    const e2 = out.episodes.find((row) => row.episodeId === 'E2');
    expect(e1.downloads).toBeNull();
    expect(e1.error).toEqual({
      status: 500,
      code: 'UPSTREAM',
      message: 'Podbean answered 500 while reading.',
      retryable: true,
    });
    expect(e2.error).toBeNull();
    expect(e2.downloads).toEqual({ total: 1, byDay: { '2026-10-12': 1 } });
    expect(out.errors).toEqual({});
  });

  it('a non-Podbean throw inside a Podbean read is recorded as UNEXPECTED rather than thrown', async () => {
    const client = makeClient({
      listEpisodes: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const out = await fetchHostOverview({ client, store: makeStore(), now });
    expect(out.errors.episodes).toEqual({
      status: null,
      code: 'UNEXPECTED',
      message: 'fetch failed',
      retryable: false,
    });
  });

  it('reads statistics for the newest rows up to the cap and leaves the rest null, counted', async () => {
    const episodes = Array.from({ length: 25 }, (_, i) =>
      liveEpisode(`E${String(i).padStart(2, '0')}`, {
        publish_time: unix('2026-09-01T00:00:00Z') + i * 86_400,
      })
    );
    const client = makeClient({ listEpisodes: vi.fn(async () => ({ episodes })) });
    const out = await fetchHostOverview({ client, store: makeStore(), now });
    expect(client.getDownloadStats).toHaveBeenCalledTimes(HOST_OVERVIEW_STATS_CAP);
    const read = out.episodes.filter((row) => row.downloads !== null);
    const unread = out.episodes.filter((row) => row.downloads === null);
    expect(read).toHaveLength(20);
    expect(unread).toHaveLength(5);
    // The newest got them: E24 down to E05; E04..E00 did not.
    expect(read[0].episodeId).toBe('E24');
    expect(unread.map((row) => row.episodeId)).toEqual(['E04', 'E03', 'E02', 'E01', 'E00']);
    expect(unread.every((row) => row.error === null)).toBe(true);
    expect(out.downloadsCapped).toBe(5);
  });

  it('a store failure is thrown — that is ours, and the handler answers 500 for it', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    await expect(fetchHostOverview({ client: makeClient(), store, now })).rejects.toThrow('cosmos down');
  });
});

describe('readHostOverview (the cache)', () => {
  const cachedDoc = (over = {}) => ({
    id: HOST_OVERVIEW_CONFIG_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    _etag: '"e1"',
    _ts: 1,
    fetchedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    days: 30,
    range: { start: '2026-09-14', end: '2026-10-13' },
    show: { id: 'p1', title: 'Cached show', logo: null, website: null },
    episodes: [{ transcriptId: 't1', episodeId: 'E1', downloads: { total: 9, byDay: {} }, error: null }],
    downloadsCapped: 0,
    errors: {},
    ...over,
  });

  it('serves a cached overview younger than the TTL, without touching Podbean, and strips Cosmos fields', async () => {
    const client = makeClient();
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc()) });
    const out = await readHostOverview({ client, store, now });
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', HOST_OVERVIEW_CONFIG_ID, ADMIN_CONFIG_PARTITION);
    expect(out.cached).toBe(true);
    expect(out.show.title).toBe('Cached show');
    expect(out.episodes[0].downloads.total).toBe(9);
    expect(out).not.toHaveProperty('_etag');
    expect(out).not.toHaveProperty('configScope');
    expect(out).not.toHaveProperty('id');
    expect(client.getPodcast).not.toHaveBeenCalled();
    expect(client.listEpisodes).not.toHaveBeenCalled();
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('reads live and writes the cache when the cached one is older than the TTL', async () => {
    const stale = cachedDoc({ fetchedAt: new Date(NOW.getTime() - HOST_OVERVIEW_TTL_MS).toISOString() });
    const client = makeClient();
    const store = makeStore({ readDoc: vi.fn(async () => stale) });
    const out = await readHostOverview({ client, store, now });
    expect(out.cached).toBe(false);
    expect(out.fetchedAt).toBe(NOW.toISOString());
    expect(client.listEpisodes).toHaveBeenCalledTimes(1);
    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('admin_config');
    expect(doc).toMatchObject({
      id: HOST_OVERVIEW_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      fetchedAt: NOW.toISOString(),
      days: 30,
    });
    expect(doc).not.toHaveProperty('cached');
  });

  it('refresh skips the cache read and still writes the new overview', async () => {
    const client = makeClient();
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc()) });
    const out = await readHostOverview({ client, store, now, refresh: true });
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(out.cached).toBe(false);
    expect(client.listEpisodes).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
  });

  it('a cached overview for a different window, or a malformed one, is not served', async () => {
    for (const doc of [
      cachedDoc({ days: 7 }),
      cachedDoc({ episodes: 'nope' }),
      cachedDoc({ fetchedAt: 'not a date' }),
      cachedDoc({ fetchedAt: new Date(NOW.getTime() + 60_000).toISOString() }),
    ]) {
      const client = makeClient();
      const store = makeStore({ readDoc: vi.fn(async () => doc) });
      const out = await readHostOverview({ client, store, now });
      expect(out.cached, JSON.stringify(doc.days)).toBe(false);
      expect(client.listEpisodes).toHaveBeenCalledTimes(1);
    }
  });

  it('a cache read that throws is logged content-free and the live read is served', async () => {
    const log = vi.fn();
    const client = makeClient();
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error('Cosmos said: episode "Secret title"'), { code: 503 });
      }),
    });
    const out = await readHostOverview({ client, store, now, log });
    expect(out.cached).toBe(false);
    expect(out.episodes).toEqual([]);
    expect(log).toHaveBeenCalledWith('podbean overview: cache read failed (503); reading live');
    expect(log.mock.calls.flat().join(' ')).not.toContain('Secret title');
  });

  it('a cache write that throws is logged content-free and the live overview is still returned', async () => {
    const log = vi.fn();
    const client = makeClient({
      listEpisodes: vi.fn(async () => ({ episodes: [liveEpisode('E1')] })),
    });
    const store = makeStore({
      upsertDoc: vi.fn(async () => {
        throw Object.assign(new Error('write refused'), { code: 429 });
      }),
    });
    const out = await readHostOverview({ client, store, now, log });
    expect(out.cached).toBe(false);
    expect(out.episodes).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('podbean overview: cache write failed (429); serving live');
  });

  it('isFresh is the one rule: same window, non-negative age under the TTL', () => {
    const at = NOW;
    const fresh = { days: 30, fetchedAt: new Date(at.getTime() - 1).toISOString() };
    expect(isFresh(fresh, { now: at, ttlMs: 1000, days: 30 })).toBe(true);
    expect(isFresh(fresh, { now: at, ttlMs: 1000, days: 7 })).toBe(false);
    expect(isFresh({ ...fresh, fetchedAt: at.toISOString() }, { now: at, ttlMs: 0, days: 30 })).toBe(false);
    expect(isFresh(null, { now: at, ttlMs: 1000, days: 30 })).toBe(false);
  });
});
