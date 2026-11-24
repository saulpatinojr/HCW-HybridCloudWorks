/**
 * When the site's copy of the Community Days list is read from the API again,
 * and what it answers when it is not or cannot be (#1823).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CACHE_DOC_ID,
  CACHE_EVENTS_MAX_BYTES,
  CACHE_TTL_MS,
  CONTAINER,
  DEFAULT_RETRY_WAIT_MS,
  FAILED_RETRY_MS,
  MIN_REFRESH_MS,
  SAVE_FAILED_CODE,
  SAVE_FAILED_SENTENCE,
  fitEvents,
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
    expect(result.retryAt).toBeNull();
  });

  it('keeps the wait a 429 on the talks asked for, so Refresh does not ask again before it', async () => {
    const store = fakeStore();
    const api = apiClient({ talksFail: new CommunityDaysError('talks', 429, { retryAfterSeconds: 900 }) });
    const first = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    // The events were read, so the list is good; only the wait is remembered.
    expect(first).toMatchObject({ status: 'ok', refreshed: true, error: null, retryAt: later(900_000).toISOString() });
    expect(first.events.map((event) => event.id)).toEqual(['event-1']);
    expect(store.get(CONTAINER, CACHE_DOC_ID).retryAt).toBe(later(900_000).toISOString());

    // Opening the page as usual says nothing: the copy is fresh.
    const opened = await loadEvents({ store, env: ENV, now: () => later(120_000), makeClient: api.makeClient });
    expect(opened).toMatchObject({ status: 'ok', refreshed: false, notice: null });
    // Refresh inside the wait calls nothing and says why.
    const pressed = await loadEvents({ store, env: ENV, now: () => later(899_000), makeClient: api.makeClient, force: true });
    expect(pressed).toMatchObject({ status: 'ok', refreshed: false });
    expect(pressed.notice).toMatch(/asked this site to wait/);
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);
    expect(api.client.listTalks).toHaveBeenCalledTimes(1);

    // After the wait, Refresh reads again.
    await loadEvents({ store, env: ENV, now: () => later(900_000), makeClient: api.makeClient, force: true });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(2);
  });

  it('waits fifteen minutes after a 429 on the talks that names no time', async () => {
    const store = fakeStore();
    const api = apiClient({ talksFail: new CommunityDaysError('talks', 429) });
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(result).toMatchObject({ status: 'ok', retryAt: later(DEFAULT_RETRY_WAIT_MS).toISOString() });
  });
});

describe('a copy that could not be saved', () => {
  const storeFailure = () => Object.assign(new Error('Request size is too large: account acct-not-real'), { code: 413 });

  it('records the try beside the last good copy, so the next page views do not read the outside service again', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient({ events: [rawEvent(2)] });
    // The new copy is refused; the small record that follows is accepted.
    store.replaceDocIfMatch.mockRejectedValueOnce(storeFailure());
    const log = { warn: vi.fn() };
    const failed = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient, log });
    expect(failed).toMatchObject({ status: 'stale', refreshed: false, error: SAVE_FAILED_SENTENCE, code: SAVE_FAILED_CODE });
    // The last good copy is what is answered and what is stored, with the time of the try.
    expect(failed.events.map((event) => event.id)).toEqual(['event-9']);
    const stored = store.get(CONTAINER, CACHE_DOC_ID);
    expect(stored).toMatchObject({ fetchedAt: T0.toISOString(), attemptedAt: later(CACHE_TTL_MS).toISOString(), lastError: SAVE_FAILED_SENTENCE });
    expect(stored.events.map((event) => event.id)).toEqual(['event-9']);
    // A code is logged, never the store's own text.
    expect(log.warn).toHaveBeenCalledWith('communityDays: the copy of the list could not be saved (413)');
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/acct-not-real|too large/);

    // The next page view, a minute later: nothing is called.
    const soon = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS + 60_000), makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);
    expect(soon).toMatchObject({ status: 'stale', refreshed: false, error: SAVE_FAILED_SENTENCE });

    // After the five-minute wait it tries again, and this time the copy is saved.
    const again = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS + FAILED_RETRY_MS), makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ status: 'ok', refreshed: true, error: null });
    expect(again.events.map((event) => event.id)).toEqual(['event-2']);
  });

  it('is an error, not a crash, on the very first read, and is recorded the same way', async () => {
    const store = fakeStore();
    const api = apiClient();
    store.createDoc.mockRejectedValueOnce(storeFailure());
    const first = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    expect(first).toMatchObject({ status: 'error', events: [], error: SAVE_FAILED_SENTENCE, code: SAVE_FAILED_CODE });
    expect(store.get(CONTAINER, CACHE_DOC_ID)).toMatchObject({ fetchedAt: null, attemptedAt: T0.toISOString() });
    await loadEvents({ store, env: ENV, now: () => later(60_000), makeClient: api.makeClient });
    expect(api.client.listOpenCalls).toHaveBeenCalledTimes(1);
  });

  it('still answers the sentence when even the record cannot be saved', async () => {
    const store = fakeStore([[CONTAINER, cacheDoc()]]);
    const api = apiClient();
    store.replaceDocIfMatch.mockRejectedValue(storeFailure());
    const log = { warn: vi.fn() };
    const failed = await loadEvents({ store, env: ENV, now: () => later(CACHE_TTL_MS), makeClient: api.makeClient, log });
    expect(failed).toMatchObject({ status: 'stale', error: SAVE_FAILED_SENTENCE });
    expect(log.warn).toHaveBeenCalledWith('communityDays: the failed save could not be recorded (413)');
  });
});

describe('the size of the copy', () => {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const big = (n, pageText) => ({ id: `event-${n}`, title: `Example Day ${n}`, startDate: '2027-03-06', endDate: '2027-03-06', pageText });

  it('leaves a list that fits exactly as it is', () => {
    const events = [big(1, 'Talks.'), big(2, 'More talks.')];
    expect(fitEvents(events)).toEqual({ events, dropped: 0 });
  });

  it('shortens the page texts first, and keeps every event', () => {
    const events = Array.from({ length: 20 }, (_, n) => big(n, '日'.repeat(800)));
    const limit = Math.floor(bytes(events) / 2);
    const fitted = fitEvents(events, limit);
    expect(fitted.dropped).toBe(0);
    expect(fitted.events).toHaveLength(20);
    expect(bytes(fitted.events)).toBeLessThanOrEqual(limit);
    expect(fitted.events[0].pageText.length).toBeGreaterThan(0);
    expect(fitted.events[0].pageText.length).toBeLessThan(800);
  });

  it('keeps the soonest events, and counts the rest, when they do not fit even with no page text', () => {
    const events = Array.from({ length: 50 }, (_, n) => big(n, 'x'.repeat(100)));
    const limit = 1000;
    const fitted = fitEvents(events, limit);
    expect(fitted.events.length).toBeGreaterThan(0);
    expect(fitted.events.length).toBeLessThan(50);
    expect(fitted.dropped).toBe(50 - fitted.events.length);
    expect(fitted.events.map((event) => event.id)).toEqual(events.slice(0, fitted.events.length).map((event) => event.id));
    expect(bytes(fitted.events)).toBeLessThanOrEqual(limit);
  });

  it('holds 300 events of text in a three-byte script well under the database’s 2 MB limit', async () => {
    const store = fakeStore();
    // Every text field as long as the API could send it, in a script that takes three bytes a character.
    const wide = (n) => ({
      RowKey: `event-${n}`,
      title: '日'.repeat(400),
      tagline: '日'.repeat(400),
      location: '日'.repeat(400),
      city: '日'.repeat(400),
      state_province: '日'.repeat(400),
      start_date: '2027-03-06T09:00',
      website: `https://example.org/${'日'.repeat(150)}`,
      call_for_speakers_link: `https://example.org/${'日'.repeat(150)}`,
      home_content: `<p>${'日'.repeat(20000)}</p>`,
    });
    const api = apiClient({ events: Array.from({ length: 300 }, (_, n) => wide(n)) });
    const result = await loadEvents({ store, env: ENV, now: () => T0, makeClient: api.makeClient });
    const stored = store.get(CONTAINER, CACHE_DOC_ID);
    expect(bytes(stored)).toBeLessThan(2 * 1024 * 1024);
    expect(bytes(stored.events)).toBeLessThanOrEqual(CACHE_EVENTS_MAX_BYTES);
    // What was left out is said, not hidden.
    expect(result.events.length + result.skipped).toBe(300);
    expect(result.truncated).toBe(result.skipped > 0);
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
