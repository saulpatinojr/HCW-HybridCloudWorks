/**
 * The Community Days client (#1823): which calls it makes, how it reads the
 * answers, and what it says when a call fails. Every event here is made up.
 */
import { describe, it, expect, vi } from 'vitest';
import { ALLOWED_PATHS, API_BASE, API_KEY_SETTING, PROBE_URL, sentenceForStatus } from './api.js';
import { CommunityDaysError, MAX_PAGES, MAX_RETRY_AFTER_SECONDS, PER_PAGE, createCommunityDaysClient, readApiKey } from './client.js';
import { authoredMessage, errorFacts } from '../http/error-response.js';

// Plainly not a real key: the real ones start with cdo_ and are far longer.
const KEY = 'cdo_test_not-a-real-key-EXAMPLE';

const answer = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A client whose requests go to `fetchImpl` and nowhere else (no DNS, no socket). */
const clientWith = (fetchImpl) =>
  createCommunityDaysClient({
    apiKey: KEY,
    fetchImpl,
    resolve: async () => ({ address: '93.184.216.34' }),
    dispatcherFor: () => null,
  });

const page = (events, { pageNumber = 1, next = null, total = events.length } = {}) =>
  answer(200, { events, page: pageNumber, per_page: PER_PAGE, total, next_page: next });

const event = (n) => ({ RowKey: `event-${n}`, title: `Example Day ${n}`, start_date: '2027-03-06T09:00' });

describe('what the client sends', () => {
  it('asks for open calls for speakers with GET, the key in the Authorization header and nowhere else', async () => {
    const fetchImpl = vi.fn(async () => page([event(1)]));
    const result = await clientWith(fetchImpl).listOpenCalls();
    expect(result).toEqual({ events: [event(1)], total: 1, truncated: false, calls: 1 });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API_BASE}/published-events?call_for_speakers=true&per_page=${PER_PAGE}&page=1`);
    expect(url).not.toContain(KEY);
    expect(options.method).toBe('GET');
    expect(options.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
    expect(options.body).toBeUndefined();
    // A redirect is never followed, so the key cannot be sent on to another address.
    expect(options.redirect).toBe('manual');
  });

  it('reads the talks with GET /profile/talks and no query', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { talks: [{ title: 'A made-up talk' }, 'not an object'], events: [] }));
    expect(await clientWith(fetchImpl).listTalks()).toEqual([{ title: 'A made-up talk' }]);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API_BASE}/profile/talks`);
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  it('only ever names the two read paths', () => {
    expect(ALLOWED_PATHS).toEqual(['/published-events', '/profile/talks']);
    expect(PROBE_URL).toBe(`${API_BASE}/published-events?per_page=1`);
  });
});

describe('pages', () => {
  it('follows next_page until the API says there is none', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([event(1), event(2)], { next: 2, total: 3 }))
      .mockResolvedValueOnce(page([event(3)], { pageNumber: 2, total: 3 }));
    const result = await clientWith(fetchImpl).listOpenCalls();
    expect(result.events.map((entry) => entry.RowKey)).toEqual(['event-1', 'event-2', 'event-3']);
    expect(result).toMatchObject({ total: 3, truncated: false, calls: 2 });
    expect(fetchImpl.mock.calls[1][0]).toContain('page=2');
  });

  it('stops at MAX_PAGES and says the list was cut short', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return page([event(n)], { pageNumber: n, next: n + 1, total: 999 });
    });
    const result = await clientWith(fetchImpl).listOpenCalls();
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PAGES);
    expect(result).toMatchObject({ truncated: true, calls: MAX_PAGES, total: 999 });
  });

  it('does not loop on a next_page that does not move forward', async () => {
    const fetchImpl = vi.fn(async () => page([event(1)], { next: 1 }));
    const result = await clientWith(fetchImpl).listOpenCalls();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  it('drops entries that are not objects', async () => {
    const fetchImpl = vi.fn(async () => page([event(1), null, 'text', [1]]));
    expect((await clientWith(fetchImpl).listOpenCalls()).events).toEqual([event(1)]);
  });
});

describe('failures', () => {
  const failure = async (response) => {
    const fetchImpl = typeof response === 'function' ? vi.fn(response) : vi.fn(async () => response);
    return clientWith(fetchImpl)
      .listOpenCalls()
      .then(
        () => null,
        (error) => error
      );
  };

  it.each([
    [401, /did not accept the key/, 'CDAYS_HTTP_401'],
    [403, /not approved for this account yet/, 'CDAYS_HTTP_403'],
    [429, /limiting how often/, 'CDAYS_HTTP_429'],
    [500, /failed on its side/, 'CDAYS_HTTP_500'],
    [404, /refused the request/, 'CDAYS_HTTP_404'],
  ])('HTTP %i becomes a sentence this site wrote, with the status as a field', async (status, sentence, code) => {
    const error = await failure(answer(status, { message: 'SECRET-UPSTREAM-TEXT from the far end' }));
    expect(error).toBeInstanceOf(CommunityDaysError);
    expect(error.message).toMatch(sentence);
    expect(error.message).toContain(`(HTTP ${status})`);
    expect(error.code).toBe(code);
    expect(error.upstreamStatus).toBe(status);
    // The far end's own words never reach the error, and neither does the key.
    expect(error.message).not.toContain('SECRET-UPSTREAM-TEXT');
    expect(JSON.stringify(errorFacts(error))).not.toContain(KEY);
    expect(authoredMessage(error, 'fallback')).toBe(error.message);
  });

  it('keeps a 429’s Retry-After in seconds, capped at a day, and ignores a date form', async () => {
    expect((await failure(answer(429, {}, { 'retry-after': '120' }))).retryAfterSeconds).toBe(120);
    expect((await failure(answer(429, {}, { 'retry-after': '999999999' }))).retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect((await failure(answer(429, {}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).retryAfterSeconds).toBeNull();
    expect((await failure(answer(429, {}))).retryAfterSeconds).toBeNull();
  });

  it('calls a 2xx that is not the documented JSON unreadable', async () => {
    for (const body of ['<html>not json</html>', '[]', '{"events":"nope"}', 'null']) {
      const error = await failure(answer(200, body));
      expect(error.code, body).toBe('CDAYS_UNREADABLE');
      expect(error.message).toBe('The answer from Community Days could not be read.');
    }
  });

  it('calls a request with no answer unreachable, without the transport’s own text', async () => {
    const error = await failure(async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    expect(error.code).toBe('CDAYS_UNREACHABLE');
    expect(error.message).toBe('Community Days could not be reached.');
    expect(error.upstreamStatus).toBeUndefined();
  });

  it('refuses a redirect instead of following it', async () => {
    const fetchImpl = vi.fn(async () => answer(302, '', { location: 'https://elsewhere.example.org/steal' }));
    const error = await clientWith(fetchImpl)
      .listTalks()
      .catch((caught) => caught);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(CommunityDaysError);
    expect(error.upstreamStatus).toBe(302);
  });

  it('has a sentence for every kind of status', () => {
    expect(sentenceForStatus(undefined)).toBe('Community Days could not be reached');
    expect(sentenceForStatus(503)).toMatch(/failed on its side/);
  });
});

describe('readApiKey', () => {
  it('reads the setting, and treats an unseeded Key Vault reference as not set', () => {
    expect(API_KEY_SETTING).toBe('COMMUNITY_DAYS_API_KEY');
    expect(readApiKey({ COMMUNITY_DAYS_API_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(readApiKey({})).toBe('');
    expect(readApiKey({ COMMUNITY_DAYS_API_KEY: '' })).toBe('');
    expect(
      readApiKey({
        COMMUNITY_DAYS_API_KEY:
          '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/COMMUNITY-DAYS-API-KEY)',
      })
    ).toBe('');
  });
});
