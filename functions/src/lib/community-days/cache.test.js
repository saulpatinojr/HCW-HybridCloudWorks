/**
 * When the site's copy of the Community Days list is read from the API again,
 * and what it answers when it is not or cannot be (#1823).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CACHE_DOC_ID,
  CACHE_TTL_MS,
  CONTAINER,
  DEFAULT_RETRY_WAIT_MS,
  FAILED_RETRY_MS,
  MIN_REFRESH_MS,
  loadEvents,
  readCacheState,
  refreshDecision,
} from './cache.js';
import { CommunityDaysError } from './client.js';
import { fakeStore } from './fake-store.test-helper.js';

const KEY = 'cdo_test_not-a-real-key-EXAMPLE';
const ENV = { COMMUNITY_DAYS_API_KEY: KEY };
const T0 = new Date('2026-11-24T12:00:00.000Z');
const later = (ms) => new Date(T0.getTime() + ms);

const rawEvent = (n) => ({ RowKey: `event-${n}`, title: `Example Day ${n}`, start_date: '2027-03-06T09:00', home_content: '<p>Talks.</p>' });

function apiClient({ events = [rawEvent(1)], talks = [{ title: 'A made-up talk' }], fail = null, talksFail = null } = {}) {
  const client = {
    listOpenCalls: vi.fn(async () => {
      if (fail) throw fail;
      return { events, total: events.length, truncated: false, calls: 1 };
    }),
    listTalks: vi.fn(async () => {
      if (talksFail) throw talksFail;
      return talks;
    }),
  };
  return { client, makeClient: vi.fn(() => client) };
}

const cacheDoc = (over = {}) => ({
  id: CACHE_DOC_ID,
  configScope: 'admin_config',
  docType: 'community_days_cache',
  events: [{ id: 'event-9', title: 'Kept copy', startDate: '2027-01-01', endDate: '2027-01-01' }],
  talks: ['Old talk'],
  fetchedAt: T0.toISOString(),
  total: 1,
  truncated: false,
  skipped: 0,
  retryAt: null,
  lastError: null,
  attemptedAt: T0.toISOString(),
  ...over,
});

describe('without a key', () => {
  it('calls nothing and says the key is not set', async () => {
    const store = fakeStore();
    const api = apiClient();
    for (const env of [{}, { COMMUNITY_DAYS_API_KEY: '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/COMMUNITY-DAYS-API-KEY)' }]) {
      const result = await loadEvents({ store, env, now: () => T0, makeClient: api.makeClient, force: true });
      expect(result).toMatchObject({ status: 'no_key', events: [], refreshed: false, error: null });
    }
    expect(api.makeClient).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });
});

describe('the first read', () => {
  it('reads the list and the talks once, and keeps a copy', async () => {
    const store = fakeStore();
    const api = apiClient();
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(api.makeClient).toHaveBeenCalledWith({ apiKey: KEY });
    expect(result).toMatchObject({ status: 'ok', refreshed: true, fetchedAt: T0.toISOString(), talks: ['A made-up talk'] });
    expect(result.events.map((event) => event.id)).toEqual(['event-1']);

    const stored = store.get(CONTAINER, CACHE_DOC_ID);
    expect(stored).toMatchObject({ configScope: 'admin_config', docType: 'community_days_cache', fetchedAt: T0.toISOString(), retryAt: null });
    // The key is never stored, and no field is undefined.
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(Object.values(stored).includes(undefined)).toBe(false);
  });

  it('keeps the events when only the talks could not be read, and logs a code, not the failure’s text', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc({ fetchedAt: null, attemptedAt: null, events: [] })]]);
    const api = apiClient({ talksFail: new CommunityDaysError('talks', 500) });
    const log = { warn: vi.fn() };
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient, log });
    expect(result).toMatchObject({ status: 'ok', talks: ['Old talk'] });
    expect(log.warn).toHaveBeenCalledWith('communityDays: the talks could not be read (CDAYS_HTTP_500)');
  });
});

describe('a copy that is fresh enough', () => {
  it('answers the copy without calling the API on every page view', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient();
    for (const ms of [0, 60_000, CACHE_TTL_MS - 1]) {
      const result = await loadEvents({ store, env: ENV, now: () => later(ms), makeClient: api.makeClient });
      expect(result).toMatchObject({ status: 'ok', refreshed: false, error: null });
      expect(result.events[0].id).toBe('event-9');
    }
    expect(api.makeClient).not.toHaveBeenCalled();
  });

  it('reads again once the copy is six hours old', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient();
    const result = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient });
    expect(result).toMatchObject({ status: 'ok', refreshed: true });
    expect(result.events[0].id).toBe('event-1');
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
  });
});

describe('Refresh', () => {
  it('reads again when asked, but not twice inside a minute', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient();
    const tooSoon = await loadEvents({ store, env: ENV, now: () => later(MIN_REFRESH_MS - 1), makeClient: api.makeClient, force: true });
    expect(tooSoon).toMatchObject({ status: 'ok', refreshed: false });
    expect(tooSoon.notice).toMatch(/less than a minute ago/);
    expect(api.makeClient).not.toHaveBeenCalled();

    const allowed = await loadEvents({ store, env: ENV, now: () => later(MIN_REFRESH_MS), makeClient: api.makeClient, force: true });
    expect(allowed).toMatchObject({ status: 'ok', refreshed: true });
  });
});

describe('a refresh that fails', () => {
  it('keeps the last good copy and says why, as stale', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient({ fail: new CommunityDaysError('events', 401) });
    const log = { warn: vi.fn() };
    const result = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient, log });
    expect(result).toMatchObject({ status: 'stale', refreshed: false, code: 'CDAYS_HTTP_401' });
    expect(result.error).toMatch(/did not accept the key/);
    expect(result.events[0].id).toBe('event-9');
    expect(log.warn).toHaveBeenCalledWith('communityDays: the list could not be refreshed (CDAYS_HTTP_401)');
    expect(store.get(CONTAINER, CACHE_DOC_ID)).toMatchObject({ fetchedAt: T0.toISOString(), lastError: result.error });
  });

  it('is an error when there is no copy to fall back on (403: access not approved yet)', async () => {
    const store = fakeStore();
    const api = apiClient({ fail: new CommunityDaysError('events', 403) });
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(result).toMatchObject({ status: 'error', events: [], refreshed: false });
    expect(result.error).toMatch(/not approved for this account yet/);
  });

  it('does not try again on the next page view for five minutes, then does', async () => {
    const store = fakeStore();
    const api = apiClient({ fail: new CommunityDaysError('events', 401) });
    await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);

    const soon = await loadEvents({ store, env: ENV, now: () => later(FAILED_RETRY_MS - 1), makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);
    expect(soon).toMatchObject({ status: 'error', refreshed: false });
    expect(soon.error).toMatch(/did not accept the key/);

    await loadEvents({ store, env: ENV, now: () => later(FAILED_RETRY_MS), makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(2);
  });

  it('waits out a 429’s Retry-After, even when Refresh is pressed', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient({ fail: new CommunityDaysError('events', 429, { retryAfterSeconds: 600 }) });
    const first = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient });
    expect(first.retryAt).toBe(later(CACHE_TTL_MS + 600_000).toISOString());

    const pressed = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS + 599_000), makeClient: api.makeClient, force: true });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);
    expect(pressed).toMatchObject({ status: 'stale', refreshed: false });
    expect(pressed.notice).toMatch(/asked this site to wait/);

    api.client.listOpenCalls.mockResolvedValueOnce({ events: [rawEvent(2)], total: 1, truncated: false, calls: 1 });
    const after = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS + 600_000), makeClient: api.makeClient, force: true });
    expect(after).toMatchObject({ status: 'ok', refreshed: true, retryAt: null });
  });

  it('waits fifteen minutes after a 429 that names no time', async () => {
    const store = fakeStore();
    const api = apiClient({ fail: new CommunityDaysError('events', 429) });
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(result.retryAt).toBe(later(DEFAULT_RETRY_WAIT_MS).toISOString());
  });

  it('lets a failure that is not the API’s (the store, say) reach the caller', async () => {
    const store = fakeStore();
    const api = apiClient({ fail: new TypeError('a bug') });
    await expect(loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient })).rejects.toThrow(TypeError);
  });
});

describe('two refreshes at the same moment', () => {
  it('answers the other request’s copy when this one loses the write', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient();
    // Another request writes between this one's read and its write.
    api.client.listOpenCalls.mockImplementationOnce(async () => {
      store.put(CONTAINER, cacheDoc({ events: [{ id: 'event-winner', title: 'Winner', startDate: '2027-02-02', endDate: '2027-02-02' }], fetchedAt: later(CACHE_TTL_MS).toISOString() }));
      return { events: [rawEvent(1)], total: 1, truncated: false, calls: 1 };
    });
    const result = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient });
    expect(result.status).toBe('ok');
    expect(result.events[0].id).toBe('event-winner');
  });
});

describe('readCacheState and refreshDecision', () => {
  it('reads a document of any shape without throwing', () => {
    for (const doc of [null, undefined, 'text', {}, { events: 'no', talks: [1, 'ok'], fetchedAt: 'never', retryAt: 5 }]) {
      const state = readCacheState(doc);
      expect(Array.isArray(state.events)).toBe(true);
      expect(state.fetchedAt).toBeNull();
      expect(state.retryAt).toBeNull();
    }
    expect(readCacheState({ talks: [1, 'ok'] }).talks).toEqual(['ok']);
  });

  it('decides from the copy’s age, the last try and the wait', () => {
    const state = readCacheState(cacheDoc());
    expect(refreshDecision(state, { now: T0, force: false })).toEqual({ call: false });
    expect(refreshDecision(state, { now: later(CACHE_TTL_MS), force: false })).toEqual({ call: true });
    expect(refreshDecision({ ...state, retryAt: later(1000).toISOString() }, { now: T0, force: true })).toEqual({ call: false, reason: 'rate_limited' });
    expect(refreshDecision(readCacheState(null), { now: T0, force: false })).toEqual({ call: true });
  });
});
