import { describe, it, expect, vi } from 'vitest';
import {
  guardedFetch,
  isPrivateIp,
  validateFetchUrl,
  pinnedLookup,
  pinnedDispatcher,
} from './guarded-fetch.js';

const PUBLIC = '93.184.216.34';
const publicAddr = async () => ({ address: PUBLIC });
// Tests pass a dispatcher factory that records the pinned address instead of
// opening sockets; the real factory is covered by its own case below.
const pin = (address) => ({ pinnedTo: address, close: async () => {} });
const res = (status, headers = {}, body = 'body') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});
const streamRes = (chunks, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body: new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  }),
});

describe('isPrivateIp', () => {
  it('refuses loopback, RFC 1918, link-local, CGNAT, the zero net, multicast and the Azure platform address', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.9',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '100.127.255.254',
      '168.63.129.16',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
  });
  it('accepts public addresses and ignores non-IPv4 strings', () => {
    for (const ip of [PUBLIC, '172.32.0.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '168.63.129.17'])
      expect(isPrivateIp(ip), ip).toBe(false);
    expect(isPrivateIp('::1')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
    expect(isPrivateIp('1.2.3.999')).toBe(false);
  });
});

describe('validateFetchUrl', () => {
  it('refuses non-http protocols, localhost and IPv6 literals by name, before resolving', async () => {
    const resolve = vi.fn(publicAddr);
    await expect(validateFetchUrl('ftp://x', { resolve })).rejects.toMatchObject({ refused: true });
    await expect(validateFetchUrl('http://localhost/x', { resolve })).rejects.toMatchObject({ refused: true });
    await expect(validateFetchUrl('http://[::1]/x', { resolve })).rejects.toMatchObject({
      refused: true,
      message: expect.stringMatching(/IPv6/),
    });
    await expect(validateFetchUrl('http://[fe80::1]:8080/', { resolve })).rejects.toMatchObject({ refused: true });
    await expect(validateFetchUrl('not a url', { resolve })).rejects.toMatchObject({ refused: true });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('refuses a public name that resolves to a private address, flagged as a refusal', async () => {
    await expect(
      validateFetchUrl('https://kb.example/doc', { resolve: async () => ({ address: '10.0.0.5' }) })
    ).rejects.toMatchObject({ refused: true, code: 'URL_REFUSED', message: expect.stringMatching(/Private IP/) });
  });
  it('refuses a name that does not resolve (an IPv6-only host under the IPv4 lookup) as a refusal, not a retry', async () => {
    const enotfound = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND v6only.example'), { code: 'ENOTFOUND' });
    };
    await expect(validateFetchUrl('https://v6only.example/', { resolve: enotfound })).rejects.toMatchObject({
      refused: true,
      message: expect.stringMatching(/could not be resolved.*ENOTFOUND/),
    });
  });
  it('returns the one address the request must connect to', async () => {
    await expect(validateFetchUrl('https://a.example/', { resolve: publicAddr })).resolves.toEqual({ address: PUBLIC });
  });
});

describe('pinned connection', () => {
  it('pinnedLookup answers every name with the validated address, in both callback shapes', () => {
    const look = pinnedLookup(PUBLIC);
    const single = vi.fn();
    look('rebinding.example', {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC, 4);
    const all = vi.fn();
    look('rebinding.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC, family: 4 }]);
    const noOpts = vi.fn();
    look('rebinding.example', noOpts);
    expect(noOpts).toHaveBeenCalledWith(null, PUBLIC, 4);
  });
  it('pinnedDispatcher is an undici dispatcher that can be closed', async () => {
    const d = pinnedDispatcher(PUBLIC);
    expect(typeof d.dispatch).toBe('function');
    await d.close();
  });
});

describe('guardedFetch', () => {
  it('validates, pins the connection to the validated address, and fetches with manual redirects and the given headers', async () => {
    const fetch = vi.fn(async () => res(200));
    const r = await guardedFetch('https://a.example/x', {
      fetch,
      resolve: publicAddr,
      dispatcherFor: pin,
      headers: { 'User-Agent': 'ua' },
      timeoutMs: 1000,
    });
    expect(r.response.status).toBe(200);
    expect(r.text()).toBe('body');
    expect(r.buffer.toString()).toBe('body');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      headers: { 'User-Agent': 'ua' },
      dispatcher: { pinnedTo: PUBLIC },
    });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a rebinding host gets the address the guard saw, not whatever it answers at connect time', async () => {
    // The resolver answers public once; whatever it would answer next is
    // irrelevant because the dispatcher only ever connects to the pinned
    // address. The fetch mock records the pin it was handed.
    let calls = 0;
    const flapping = async () => ({ address: calls++ === 0 ? PUBLIC : '10.0.0.5' });
    const fetch = vi.fn(async (_url, { dispatcher }) => res(200, {}, `connected:${dispatcher.pinnedTo}`));
    const r = await guardedFetch('https://rebinding.example/', { fetch, resolve: flapping, dispatcherFor: pin });
    expect(r.text()).toBe(`connected:${PUBLIC}`);
    expect(calls).toBe(1);
  });

  it('never calls fetch for a private, link-local, Azure-platform, localhost or IPv6 target', async () => {
    const fetch = vi.fn(async () => res(200));
    for (const [url, address] of [
      ['http://10.0.0.5/', '10.0.0.5'],
      ['http://169.254.169.254/metadata', '169.254.169.254'],
      ['http://168.63.129.16/?comp=versions', '168.63.129.16'],
    ]) {
      await expect(guardedFetch(url, { fetch, resolve: async () => ({ address }), dispatcherFor: pin })).rejects.toMatchObject({
        refused: true,
      });
    }
    await expect(guardedFetch('http://localhost:7071/', { fetch, resolve: publicAddr, dispatcherFor: pin })).rejects.toMatchObject({ refused: true });
    await expect(guardedFetch('http://[::1]:7071/', { fetch, resolve: publicAddr, dispatcherFor: pin })).rejects.toMatchObject({ refused: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows a redirect only after re-validating and re-pinning the new host', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(302, { location: 'https://b.example/y' }))
      .mockResolvedValueOnce(res(200));
    const resolve = vi.fn(async (host) => ({ address: host === 'b.example' ? '93.184.216.35' : PUBLIC }));
    const closed = [];
    const closingPin = (address) => ({ pinnedTo: address, close: async () => closed.push(address) });
    const r = await guardedFetch('https://a.example/x', { fetch, resolve, dispatcherFor: closingPin });
    expect(r.response.status).toBe(200);
    expect(fetch.mock.calls[1][0]).toBe('https://b.example/y');
    expect(fetch.mock.calls[1][1].dispatcher.pinnedTo).toBe('93.184.216.35');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(closed).toEqual([PUBLIC, '93.184.216.35']);
  });

  it('refuses a redirect that lands on the private network', async () => {
    const fetch = vi.fn(async () => res(301, { location: 'http://10.0.0.5/internal' }));
    const resolve = vi.fn(async (host) => ({ address: host === 'a.example' ? PUBLIC : '10.0.0.5' }));
    await expect(guardedFetch('https://a.example/x', { fetch, resolve, dispatcherFor: pin })).rejects.toMatchObject({ refused: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('with httpsOnly, refuses an http URL and an https → http redirect before fetching it', async () => {
    const fetch = vi.fn(async () => res(200));
    await expect(
      guardedFetch('http://a.example/x', { fetch, resolve: publicAddr, dispatcherFor: pin, httpsOnly: true })
    ).rejects.toMatchObject({ refused: true });
    expect(fetch).not.toHaveBeenCalled();

    const down = vi.fn(async () => res(302, { location: 'http://a.example/plain' }));
    await expect(
      guardedFetch('https://a.example/x', { fetch: down, resolve: publicAddr, dispatcherFor: pin, httpsOnly: true })
    ).rejects.toMatchObject({ refused: true });
    expect(down).toHaveBeenCalledTimes(1);

    // Without the option, http stays allowed, as every existing caller expects.
    const plain = vi.fn(async () => res(200));
    await guardedFetch('http://a.example/x', { fetch: plain, resolve: publicAddr, dispatcherFor: pin });
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(307, { location: '/moved' }))
      .mockResolvedValueOnce(res(200));
    await guardedFetch('https://a.example/dir/x', { fetch, resolve: publicAddr, dispatcherFor: pin });
    expect(fetch.mock.calls[1][0]).toBe('https://a.example/moved');
  });

  it('stops at the redirect limit and on a redirect with no Location', async () => {
    const loop = vi.fn(async () => res(302, { location: 'https://a.example/again' }));
    await expect(
      guardedFetch('https://a.example/x', { fetch: loop, resolve: publicAddr, dispatcherFor: pin, maxRedirects: 2 })
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
    expect(loop).toHaveBeenCalledTimes(3);
    const blank = vi.fn(async () => res(302));
    await expect(guardedFetch('https://a.example/x', { fetch: blank, resolve: publicAddr, dispatcherFor: pin })).rejects.toMatchObject({
      code: 'REDIRECT_NO_LOCATION',
    });
  });

  it('returns a non-2xx response to the caller rather than deciding for it', async () => {
    const fetch = vi.fn(async () => res(403));
    const r = await guardedFetch('https://a.example/x', { fetch, resolve: publicAddr, dispatcherFor: pin });
    expect(r.response.status).toBe(403);
  });

  it('reads a streamed body under the cap and refuses one that grows past it', async () => {
    const fetch = vi.fn(async () => streamRes(['ab', 'cd', 'ef']));
    const r = await guardedFetch('https://a.example/x', { fetch, resolve: publicAddr, dispatcherFor: pin });
    expect(r.text()).toBe('abcdef');
    const big = vi.fn(async () => streamRes(['x'.repeat(100), 'y'.repeat(100)]));
    await expect(
      guardedFetch('https://a.example/x', { fetch: big, resolve: publicAddr, dispatcherFor: pin, maxBytes: 150 })
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const declared = vi.fn(async () => res(200, { 'content-length': '9999' }));
    await expect(
      guardedFetch('https://a.example/x', { fetch: declared, resolve: publicAddr, dispatcherFor: pin, maxBytes: 150 })
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('reports a hung socket as a timeout', async () => {
    const fetch = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    await expect(
      guardedFetch('https://a.example/x', { fetch, resolve: publicAddr, dispatcherFor: pin, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
  });

  it('keeps the deadline through the body: headers then a stalled body is a timeout, not a wait', async () => {
    const stalled = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({ start() {} }), // never enqueues, never closes
    }));
    await expect(
      guardedFetch('https://a.example/x', { fetch: stalled, resolve: publicAddr, dispatcherFor: pin, timeoutMs: 10 })
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
    const stalledText = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise(() => {}),
    }));
    await expect(
      guardedFetch('https://a.example/x', { fetch: stalledText, resolve: publicAddr, dispatcherFor: pin, timeoutMs: 10 })
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
  });

  it('aborts when parent signal is aborted (AP-B7)', async () => {
    const parent = new AbortController();
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            return reject(parent.signal.reason || new Error('aborted'));
          }
          signal?.addEventListener('abort', () => reject(parent.signal.reason || new Error('aborted')));
        })
    );
    const promise = guardedFetch('https://a.example/x', {
      fetch: fetchImpl,
      resolve: publicAddr,
      dispatcherFor: pin,
      signal: parent.signal,
    });
    parent.abort(new Error('job timeout'));
    await expect(promise).rejects.toThrow('job timeout');
  });
});

/**
 * The real dispatcher through the runtime's own fetch, end to end.
 *
 * Every case above injects a fake fetch or a fake dispatcher, which is right
 * for the logic and blind to the one integration that can break without a
 * line of this file changing: guardedFetch hands an Agent from the npm
 * `undici` package to `globalThis.fetch`, which is the undici Node bundles.
 * The two must speak the same dispatcher interface. On 2026-10-08 Dependabot
 * proposed undici 8 (#902) with every check green; on Node 24, the line the
 * Function App runs (bundled undici 7.29.1), an undici 8 Agent makes the
 * built-in fetch throw `fetch failed` (UND_ERR_INVALID_ARG), which would have
 * failed every guarded fetch in production. This case sends one request
 * through pinnedDispatcher to a local server, so it fails in CI (which runs
 * this package on Node 24) the moment the two disagree.
 */
describe('pinnedDispatcher with the built-in fetch', () => {
  it('carries a request to the pinned address through globalThis.fetch', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, response) => response.end(`pinned ${req.headers.host}`));
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address();
    // The hostname resolves nowhere; only the pinned lookup can reach the server.
    const dispatcher = pinnedDispatcher('127.0.0.1');
    try {
      const response = await globalThis.fetch(`http://pinned.invalid:${port}/`, { dispatcher });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`pinned pinned.invalid:${port}`);
    } catch (error) {
      const { createRequire } = await import('node:module');
      const installed = createRequire(import.meta.url)('undici/package.json').version;
      throw new Error(
        `globalThis.fetch (Node ${process.version}, bundled undici ${process.versions.undici}) refused an Agent from the ` +
          `npm undici ${installed}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}. Keep the npm ` +
          `undici on the bundled major (functions/package.json, .github/dependabot.yml).`,
        { cause: error }
      );
    } finally {
      await dispatcher.close();
      server.close();
    }
  });
});
