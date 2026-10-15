/**
 * authedFetch's `token` option: a caller that has already acquired a bearer
 * token can hand it over and no acquisition happens. Added for the Admin
 * Diagnostics page, which must decode and send the same acquisition; the
 * default path — acquire here, from the cache, with a forced refresh only
 * for a caller that asks (`freshToken`, AP-F12 #936) — is pinned alongside
 * so neither option can quietly become the default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const acquireApiToken = vi.fn();
vi.mock('@/lib/entraAuth', () => ({ acquireApiToken: (...args) => acquireApiToken(...args) }));
vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.example.test/api',
  getFunctionsBase: () => 'https://api.example.test/api',
}));

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });

beforeEach(() => {
  acquireApiToken.mockReset().mockResolvedValue('acquired-here');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okResponse())
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authedFetch', () => {
  it('sends a pre-acquired token as-is and does not acquire another', async () => {
    const { authedFetch } = await import('@/lib/api');
    await authedFetch('getCurrentAdminStatus', { method: 'GET', token: 'pre-acquired' });

    expect(acquireApiToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetch.mock.calls;
    expect(url).toBe('https://api.example.test/api/getCurrentAdminStatus');
    expect(init.headers.Authorization).toBe('Bearer pre-acquired');
    // The option is consumed, not forwarded to fetch as a stray field.
    expect('token' in init).toBe(false);
  });

  it('acquires from the cache when no token is given, and forces a refresh only when asked', async () => {
    const { authedFetch } = await import('@/lib/api');

    // No route forces a refresh on its own any more: getCurrentAdminStatus
    // used to, once per mounted hook instance (AP-F12, #936).
    await authedFetch('getCurrentAdminStatus', { method: 'GET' });
    expect(acquireApiToken).toHaveBeenLastCalledWith({ forceRefresh: false });

    await authedFetch('getLabsSnapshot', { method: 'POST', body: '{}' });
    expect(acquireApiToken).toHaveBeenLastCalledWith({ forceRefresh: false });

    await authedFetch('getCurrentAdminStatus', { method: 'GET', freshToken: true });
    expect(acquireApiToken).toHaveBeenLastCalledWith({ forceRefresh: true });

    expect(acquireApiToken).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer acquired-here');
    // The option is consumed, not forwarded to fetch as a stray field.
    expect('freshToken' in fetch.mock.calls[2][1]).toBe(false);
  });

  it('never lets a caller header replace the Authorization it sends', async () => {
    const { authedFetch } = await import('@/lib/api');
    await authedFetch('getLabsSnapshot', {
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: 'Bearer forged',
        authorization: 'Bearer forged-too',
        'X-Trace': 't1',
      },
    });
    const [[, init]] = fetch.mock.calls;
    // The acquired token wins, exactly once, under the canonical name.
    expect(init.headers.Authorization).toBe('Bearer acquired-here');
    expect(Object.keys(init.headers).filter((h) => h.toLowerCase() === 'authorization')).toEqual([
      'Authorization',
    ]);
    // Other caller headers still get through.
    expect(init.headers['X-Trace']).toBe('t1');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('the same holds with a pre-acquired token: only the token option decides', async () => {
    const { authedFetch } = await import('@/lib/api');
    await authedFetch('getLabsSnapshot', {
      method: 'POST',
      body: '{}',
      token: 'pre-acquired',
      headers: { Authorization: 'Bearer forged' },
    });
    expect(acquireApiToken).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer pre-acquired');
  });

  it('getJSON forwards a pre-acquired token and stays a GET', async () => {
    const { getJSON } = await import('@/lib/api');
    await getJSON('getAuthExpectations', { token: 'pre-acquired' });
    expect(acquireApiToken).not.toHaveBeenCalled();
    const [[url, init]] = fetch.mock.calls;
    expect(url).toBe('https://api.example.test/api/getAuthExpectations');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer pre-acquired');
    expect('token' in init).toBe(false);
  });

  it('treats an empty token as absent rather than sending "Bearer "', async () => {
    const { authedFetch } = await import('@/lib/api');
    await authedFetch('getLabsSnapshot', { method: 'POST', body: '{}', token: '' });
    expect(acquireApiToken).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer acquired-here');
  });
});
