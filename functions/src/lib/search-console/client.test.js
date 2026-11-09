/**
 * client.js: the three Search Console calls, the retry rule and the 403
 * sentence (#1612). Fetch is a stub; nothing here reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSearchConsoleClient, defaultSleep, INSPECT_URL, SearchConsoleError, sleepUnlessAborted } from './client.js';

const SITE = 'sc-domain:hybridcloudworks.com';
const TOKEN = 'access-token-should-never-leak';

const response = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

function setup(responses) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => queue.shift());
  const sleep = vi.fn(async () => {});
  const auth = { getAccessToken: vi.fn(async () => TOKEN), reset: vi.fn() };
  const client = createSearchConsoleClient({ siteUrl: SITE, auth, fetchImpl, sleep });
  return { client, fetchImpl, sleep, auth };
}

describe('createSearchConsoleClient', () => {
  it('inspects one URL against the property, in English', async () => {
    const { client, fetchImpl } = setup([response(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } })]);
    await expect(client.inspect('https://hybridcloudworks.com/a')).resolves.toEqual({
      indexStatusResult: { verdict: 'PASS' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(INSPECT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      inspectionUrl: 'https://hybridcloudworks.com/a',
      siteUrl: SITE,
      languageCode: 'en-US',
    });
  });

  it('queries Search Analytics and lists sitemaps under the encoded property', async () => {
    const { client, fetchImpl } = setup([
      response(200, { rows: [{ keys: ['x'], clicks: 1 }] }),
      response(200, { sitemap: [{ path: 'https://hybridcloudworks.com/sitemap.xml' }] }),
    ]);
    await expect(client.searchAnalytics({ startDate: '2026-01-01', endDate: '2026-01-02' })).resolves.toHaveLength(1);
    await expect(client.listSitemaps()).resolves.toHaveLength(1);
    const base = 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ahybridcloudworks.com';
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/searchAnalytics/query`);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/sitemaps`);
    expect(fetchImpl.mock.calls[1][1].method).toBe('GET');
  });

  it('answers [] when Google sends no rows or no sitemaps', async () => {
    const { client } = setup([response(200, {}), response(200, {})]);
    await expect(client.searchAnalytics({})).resolves.toEqual([]);
    await expect(client.listSitemaps()).resolves.toEqual([]);
  });

  it('retries a 429 and a 503 with a growing pause, then succeeds', async () => {
    const { client, sleep } = setup([response(429), response(503), response(200, { inspectionResult: {} })]);
    await expect(client.inspect('https://hybridcloudworks.com/')).resolves.toEqual({});
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('honours a short Retry-After', async () => {
    const { client, sleep } = setup([response(429, {}, { 'retry-after': '3' }), response(200, { rows: [] })]);
    await client.searchAnalytics({});
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('gives up after three tries with the status and no body text', async () => {
    const { client, fetchImpl } = setup([response(500, { error: 'secret detail' }), response(500), response(500)]);
    const failure = await client.listSitemaps().catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure.status).toBe(500);
    expect(failure.message).not.toContain('secret detail');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 403, and says the service account is not a Full user', async () => {
    const { client, fetchImpl } = setup([response(403)]);
    const failure = await client.inspect('https://hybridcloudworks.com/').catch((caught) => caught);
    expect(failure.status).toBe(403);
    expect(failure.message).toContain('the service account is not a Full user on the Search Console property');
    expect(failure.message).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('signs in again once after a 401', async () => {
    const { client, auth } = setup([response(401), response(200, { rows: [] })]);
    await expect(client.searchAnalytics({})).resolves.toEqual([]);
    expect(auth.reset).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and then reports it without a status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createSearchConsoleClient({
      siteUrl: SITE,
      auth: { getAccessToken: async () => TOKEN },
      fetchImpl,
      sleep: async () => {},
    });
    const failure = await client.listSitemaps().catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure.status).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up on a call with no answer after 30 seconds, and retries it like a dropped connection', async () => {
    vi.useFakeTimers();
    try {
      // A call that never answers until its signal fires.
      const hanging = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      const fetchImpl = vi.fn(hanging).mockImplementationOnce(hanging).mockImplementationOnce(async () => response(200, { rows: [{ keys: ['x'] }] }));
      const client = createSearchConsoleClient({
        siteUrl: SITE,
        auth: { getAccessToken: async () => TOKEN },
        fetchImpl,
        sleep: async () => {},
      });
      const pending = client.searchAnalytics({});
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a call whose successful body is not JSON, without retrying it, and treats an odd status as unreachable', async () => {
    const { client, fetchImpl } = setup([{ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('x')) }, response(302)]);
    const unreadable = await client.inspect('https://hybridcloudworks.com/').catch((caught) => caught);
    expect(unreadable).toBeInstanceOf(SearchConsoleError);
    expect(unreadable).toMatchObject({ reason: 'unreadable', code: 'GSC_UNREADABLE', status: 200 });
    expect(unreadable.message).toBe("Search Console inspect failed: Google's answer could not be read.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const failure = await client.listSitemaps().catch((caught) => caught);
    expect(failure.message).toBe('Search Console sitemaps failed: Search Console could not be reached (HTTP 302).');
    expect(failure.reason).toBeNull();
  });

  it.each([
    ['an inspection without inspectionResult', (client) => client.inspect('https://hybridcloudworks.com/'), {}],
    ['an inspection whose inspectionResult is not an object', (client) => client.inspect('https://hybridcloudworks.com/'), { inspectionResult: 'x' }],
    ['Search Analytics rows that are not a list', (client) => client.searchAnalytics({}), { rows: { a: 1 } }],
    ['a sitemaps list that is not a list', (client) => client.listSitemaps(), { sitemap: 'x' }],
    ['a body that is a list, not an object', (client) => client.listSitemaps(), []],
    ['a body that is null', (client) => client.searchAnalytics({}), null],
  ])('fails %s, so the caller keeps its last good figures', async (_label, callIt, body) => {
    const { client } = setup([response(200, body)]);
    await expect(callIt(client)).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('asks beforeSend before every request, retries included, and stops when it says no', async () => {
    const { client, fetchImpl } = setup([response(503), response(503), response(200, { inspectionResult: {} })]);
    const answers = [true, false];
    const beforeSend = vi.fn(async () => answers.shift());
    const failure = await client.inspect('https://hybridcloudworks.com/', { beforeSend }).catch((caught) => caught);
    // The retry was held back, so the call fails with what it was retrying.
    expect(failure).toMatchObject({ status: 503, reason: null });
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when beforeSend says no to the first request', async () => {
    const { client, fetchImpl, auth } = setup([]);
    const failure = await client.inspect('https://hybridcloudworks.com/', { beforeSend: async () => false }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure).toMatchObject({ reason: 'not_sent', code: 'GSC_NOT_SENT' });
    expect(failure.status).toBeUndefined();
    expect(failure.message).toBe('Search Console inspect failed: the daily allowance of inspections is used up, so it was not sent.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });

  it('asks beforeSend again for the request it sends after signing in again', async () => {
    const { client, fetchImpl } = setup([response(401), response(200, { inspectionResult: { indexStatusResult: {} } })]);
    const beforeSend = vi.fn(async () => true);
    await expect(client.inspect('https://hybridcloudworks.com/', { beforeSend })).resolves.toEqual({ indexStatusResult: {} });
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up at once when Retry-After asks for longer than 30 seconds', async () => {
    const { client, fetchImpl, sleep } = setup([response(429, {}, { 'retry-after': '120' })]);
    await expect(client.inspect('https://hybridcloudworks.com/')).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits with the real clock by default', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined();
  });

  it.each([
    [401, 'Google did not accept the access token'],
    [404, 'Google has no such property or resource'],
    [400, 'Google refused the request as malformed'],
  ])('says what HTTP %s means', async (status, sentence) => {
    const client = createSearchConsoleClient({
      siteUrl: SITE,
      auth: { getAccessToken: async () => TOKEN },
      fetchImpl: vi.fn(async () => response(status)),
      sleep: async () => {},
    });
    const failure = await client.inspect('https://hybridcloudworks.com/').catch((caught) => caught);
    expect(failure.message).toContain(sentence);
  });
});

describe('the run\'s cancel switch (Copilot review round 2, #1614)', () => {
  it('sends nothing once the signal has fired', async () => {
    const { client, fetchImpl } = setup([response(200, { rows: [] })]);
    const failure = await client.searchAnalytics({}, { signal: AbortSignal.abort() }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure.status).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cuts off a call waiting for its answer and does not try again', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const sleep = vi.fn(async () => {});
    const client = createSearchConsoleClient({ siteUrl: SITE, auth: { getAccessToken: async () => TOKEN }, fetchImpl, sleep });
    const call = client.listSitemaps({ signal: controller.signal }).catch((caught) => caught);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(call).resolves.toBeInstanceOf(SearchConsoleError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('ends the pause before a retry when the signal fires, and sends no retry', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => response(503));
    // A pause that would never end by itself.
    const sleep = vi.fn(() => new Promise(() => {}));
    const client = createSearchConsoleClient({ siteUrl: SITE, auth: { getAccessToken: async () => TOKEN }, fetchImpl, sleep });
    const call = client.inspect('https://hybridcloudworks.com/', { signal: controller.signal }).catch((caught) => caught);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(call).resolves.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sleeps as asked without a signal, and not at all once it has fired', async () => {
    const sleep = vi.fn(async () => {});
    await sleepUnlessAborted(sleep, 5);
    expect(sleep).toHaveBeenCalledWith(5);
    sleep.mockClear();
    await sleepUnlessAborted(sleep, 5, AbortSignal.abort());
    expect(sleep).not.toHaveBeenCalled();
    // A pause that ends by itself leaves no listener behind.
    const controller = new AbortController();
    await sleepUnlessAborted(async () => {}, 5, controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });
});
