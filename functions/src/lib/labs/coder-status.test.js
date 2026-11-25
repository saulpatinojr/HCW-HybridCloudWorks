import { afterEach, describe, expect, it, vi } from 'vitest';

import { CACHE_CONTAINER } from '../cloud-tools/history.js';
import {
  CODER_STATUS_CACHE_ID,
  CODER_STATUS_CACHE_SECONDS,
  CODER_TIMEOUT_MS,
  CODER_API_KEY_PATTERN,
  DEFAULT_CODER_MAX_WORKSPACES,
  DEFAULT_CODER_STATUS_USER,
  MAX_TEMPLATES,
  STATUS_TOKEN_EXTRA_SCOPES,
  STATUS_TOKEN_SCOPES,
  SCOPE_REFUSAL_STATUSES,
  TOKEN_RENEW_WARNING_DAYS,
  TOKEN_SCOPE_FOR_EXPIRY,
  createCoderStatusHandlers,
  readCoderConfig,
  readMaxWorkspaces,
  readSetting,
  readStatusUser,
  readTokenExpiry,
  statusScopeProblem,
  tokenKeyId,
  verifyStatusToken,
} from './coder-status.js';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const ENV = {
  CODER_URL: 'https://coder.lab.example/',
  CODER_STATUS_TOKEN: 'read-only-token',
  CODER_MAX_WORKSPACES: '5',
};
const ENV_NO_TOKEN = { CODER_URL: 'https://coder.lab.example/', CODER_MAX_WORKSPACES: '5' };
const V1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const V2 = '11111111-2222-4333-8444-555555555555';

const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const request = () => ({ method: 'GET', query: { get: () => null } });
const body = (res) => JSON.parse(res.body);

const makeStore = (over = {}) => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, d) => d),
  ...over,
});

const okJson = (data) => ({ ok: true, status: 200, json: async () => data });

/** A Coder that answers by path (plus query string), recording every call. */
function coderFetch(routes, calls = []) {
  const fetchImpl = vi.fn(async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    const hit = routes[`${u.pathname}${u.search}`] ?? routes[u.pathname];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return typeof hit === 'function' ? hit() : okJson(hit);
  });
  fetchImpl.calls = calls;
  return fetchImpl;
}

const BUILD_INFO = { version: 'v2.37.3+b1d2e3f', external_url: 'https://github.com/coder/coder/commit/b1d2e3f' };

const HEALTHY = {
  '/api/v2/buildinfo': BUILD_INFO,
  '/api/v2/templates': [
    { name: 'hcw-lab', active_version_id: V1, display_name: 'HCW Lab' },
    { name: 'scratch', active_version_id: V2 },
  ],
  '/api/v2/workspaces?q=status%3Arunning': { count: 2, workspaces: [{ id: 'w1' }, { id: 'w2' }] },
  [`/api/v2/templateversions/${V1}`]: { name: 'v7', id: V1 },
  [`/api/v2/templateversions/${V2}`]: { name: 'v2', id: V2 },
};

const cachedDoc = (value, ageMs) => ({
  id: CODER_STATUS_CACHE_ID,
  kind: 'labs-coder-status',
  value,
  cachedAt: new Date(NOW - ageMs).toISOString(),
});

const handlers = ({ store = makeStore(), fetchImpl = coderFetch(HEALTHY), env = ENV } = {}) =>
  createCoderStatusHandlers({ store, fetchImpl, env, now: () => NOW });

afterEach(() => {
  vi.useRealTimers();
});

describe('readSetting', () => {
  it('treats an unresolved Key Vault reference as unset, and trims a BOM', () => {
    expect(readSetting({ X: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/X)' }, 'X')).toBe('');
    expect(readSetting({ X: '﻿  value  ' }, 'X')).toBe('value');
    expect(readSetting({}, 'X')).toBe('');
    expect(readSetting({ X: 42 }, 'X')).toBe('');
  });
});

describe('readMaxWorkspaces', () => {
  it('defaults to the Community cap, and only accepts a positive integer', () => {
    expect(readMaxWorkspaces({})).toBe(DEFAULT_CODER_MAX_WORKSPACES);
    expect(readMaxWorkspaces({ CODER_MAX_WORKSPACES: '8' })).toBe(8);
    expect(readMaxWorkspaces({ CODER_MAX_WORKSPACES: '0' })).toBe(DEFAULT_CODER_MAX_WORKSPACES);
    expect(readMaxWorkspaces({ CODER_MAX_WORKSPACES: 'many' })).toBe(DEFAULT_CODER_MAX_WORKSPACES);
  });
});

describe('readCoderConfig', () => {
  it('needs the URL, and only the URL: the token is optional', () => {
    expect(readCoderConfig({})).toBeNull();
    expect(readCoderConfig({ CODER_STATUS_TOKEN: 't' })).toBeNull();
    expect(readCoderConfig({ ...ENV, CODER_URL: '@Microsoft.KeyVault(x)' })).toBeNull();
    expect(readCoderConfig({ CODER_URL: ENV.CODER_URL })).toEqual({
      base: 'https://coder.lab.example',
      token: '',
      max: 5,
    });
    expect(readCoderConfig({ ...ENV, CODER_STATUS_TOKEN: '@Microsoft.KeyVault(x)' }).token).toBe('');
  });

  it('refuses a URL that is not https, because the token travels in a header', () => {
    expect(readCoderConfig({ ...ENV, CODER_URL: 'http://coder.lab.example' })).toBeNull();
    expect(readCoderConfig({ ...ENV, CODER_URL: 'coder.lab.example' })).toBeNull();
  });

  it('normalises the base: no trailing slash, path prefix kept', () => {
    expect(readCoderConfig(ENV)).toEqual({ base: 'https://coder.lab.example', token: 'read-only-token', max: 5 });
    expect(readCoderConfig({ ...ENV, CODER_URL: 'https://lab.example/coder/' }).base).toBe('https://lab.example/coder');
  });
});

describe('GET /api/public/labs/coder-status', () => {
  it('unconfigured: answers { configured: false } with no store read and no network', async () => {
    const store = makeStore();
    const fetchImpl = vi.fn();
    const res = await handlers({ store, fetchImpl, env: {} }).getCoderStatus(request(), context);

    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ configured: false });
    expect(res.headers['Cache-Control']).toBeUndefined();
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('unconfigured with a warning when the URL is set but is not https, token or not', async () => {
    for (const env of [{ ...ENV, CODER_URL: 'http://coder.lab.example' }, { CODER_URL: 'http://coder.lab.example' }]) {
      const warn = vi.fn();
      const res = await handlers({ env }).getCoderStatus(request(), { ...context, warn });
      expect(body(res)).toEqual({ configured: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('https'));
    }
  });

  it('asks whether Coder answers with no token at all', async () => {
    const fetchImpl = coderFetch(HEALTHY);
    await handlers({ fetchImpl }).getCoderStatus(request(), context);
    const buildinfo = fetchImpl.calls.find(({ url }) => url.endsWith('/api/v2/buildinfo'));
    expect(buildinfo).toBeDefined();
    expect(buildinfo.options.headers).not.toHaveProperty('Coder-Session-Token');
  });

  it('healthy: templates with their active version names, the running count, the cap, cached a minute', async () => {
    const store = makeStore();
    const fetchImpl = coderFetch(HEALTHY);
    const res = await handlers({ store, fetchImpl }).getCoderStatus(request(), context);

    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe(`public, max-age=${CODER_STATUS_CACHE_SECONDS}`);
    expect(body(res)).toEqual({
      configured: true,
      reachable: true,
      templates: [
        { name: 'hcw-lab', activeVersion: 'v7' },
        { name: 'scratch', activeVersion: 'v2' },
      ],
      capacity: { running: 2, max: 5 },
      asOf: new Date(NOW).toISOString(),
    });

    // Every call went to the configured base and follows no redirect, and
    // every one but the build info carried the session token header.
    expect(fetchImpl.calls.length).toBe(5);
    for (const { url, options } of fetchImpl.calls) {
      expect(url.startsWith('https://coder.lab.example/api/v2/')).toBe(true);
      expect(options.redirect).toBe('error');
      if (!url.endsWith('/buildinfo')) expect(options.headers['Coder-Session-Token']).toBe('read-only-token');
    }

    expect(store.upsertDoc).toHaveBeenCalledWith(
      CACHE_CONTAINER,
      expect.objectContaining({
        id: CODER_STATUS_CACHE_ID,
        value: expect.objectContaining({ reachable: true }),
        ttl: CODER_STATUS_CACHE_SECONDS,
      })
    );
  });

  it('never returns the URL, the token, a workspace or an id', async () => {
    const res = await handlers().getCoderStatus(request(), context);
    const text = res.body;
    expect(text).not.toContain('coder.lab.example');
    expect(text).not.toContain('read-only-token');
    expect(text).not.toContain('w1');
    expect(text).not.toContain(V1);
  });

  it('caps the templates shown, and therefore the version lookups, at MAX_TEMPLATES', async () => {
    const many = Array.from({ length: MAX_TEMPLATES + 2 }, (_, i) => ({ name: `t${i}`, active_version_id: V1 }));
    const fetchImpl = coderFetch({ ...HEALTHY, '/api/v2/templates': many });
    const res = await handlers({ fetchImpl }).getCoderStatus(request(), context);

    expect(body(res).templates).toHaveLength(MAX_TEMPLATES);
    const versionCalls = fetchImpl.calls.filter(({ url }) => url.includes('/templateversions/'));
    expect(versionCalls).toHaveLength(MAX_TEMPLATES);
  });

  it('gives activeVersion null when the version cannot be resolved, never the uuid', async () => {
    const fetchImpl = coderFetch({
      ...HEALTHY,
      '/api/v2/templates': [
        { name: 'hcw-lab', active_version_id: V1 },
        { name: 'odd', active_version_id: 'not-a-uuid' },
        { name: 'broken', active_version_id: V2 },
      ],
      [`/api/v2/templateversions/${V2}`]: () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    const res = await handlers({ fetchImpl }).getCoderStatus(request(), context);
    expect(body(res)).toMatchObject({
      reachable: true,
      templates: [
        { name: 'hcw-lab', activeVersion: 'v7' },
        { name: 'odd', activeVersion: null },
        { name: 'broken', activeVersion: null },
      ],
    });
  });

  it('falls back to the length of the page when the workspaces answer carries no count', async () => {
    const fetchImpl = coderFetch({
      ...HEALTHY,
      '/api/v2/workspaces?q=status%3Arunning': { workspaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    });
    const res = await handlers({ fetchImpl }).getCoderStatus(request(), context);
    expect(body(res).capacity).toEqual({ running: 3, max: 5 });
  });

  it('unreachable: a thrown fetch answers reachable false with running null, and caches that', async () => {
    const store = makeStore();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await handlers({ store, fetchImpl }).getCoderStatus(request(), context);

    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      configured: true,
      reachable: false,
      templates: [],
      capacity: { running: null, max: 5 },
      asOf: new Date(NOW).toISOString(),
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      CACHE_CONTAINER,
      expect.objectContaining({ value: expect.objectContaining({ reachable: false }), ttl: 60 })
    );
  });

  it('unreachable: a build info that is not a 200 with a version is not guessed at, and nothing else is asked', async () => {
    for (const buildinfo of [
      () => ({ ok: false, status: 503, json: async () => ({}) }),
      () => ({ ok: false, status: 502, json: async () => ({}) }),
      { not: 'build info' },
      { version: '' },
    ]) {
      const fetchImpl = coderFetch({ ...HEALTHY, '/api/v2/buildinfo': buildinfo });
      const answer = body(await handlers({ fetchImpl }).getCoderStatus(request(), context));
      expect(answer).toMatchObject({ configured: true, reachable: false, templates: [], capacity: { running: null } });
      expect(fetchImpl.calls).toHaveLength(1);
    }
  });

  describe('reachable with the detail unknown: the panes open, the card lists nothing', () => {
    const UNKNOWN = {
      configured: true,
      reachable: true,
      templates: [],
      capacity: { running: null, max: 5 },
      asOf: new Date(NOW).toISOString(),
    };

    it.each([
      ['no token', { CODER_URL: ENV.CODER_URL, CODER_MAX_WORKSPACES: '5' }],
      ['an unresolved token reference', { ...ENV, CODER_STATUS_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/CODER-STATUS-TOKEN)' }],
    ])('%s: asks only the build info, and warns naming the setting', async (_label, env) => {
      const warn = vi.fn();
      const store = makeStore();
      const fetchImpl = coderFetch(HEALTHY);
      const res = await handlers({ env, store, fetchImpl }).getCoderStatus(request(), { ...context, warn });

      expect(body(res)).toEqual(UNKNOWN);
      expect(res.headers['Cache-Control']).toBe(`public, max-age=${CODER_STATUS_CACHE_SECONDS}`);
      expect(fetchImpl.calls.map(({ url }) => new URL(url).pathname)).toEqual(['/api/v2/buildinfo']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CODER_STATUS_TOKEN'));
      expect(store.upsertDoc).toHaveBeenCalledWith(
        CACHE_CONTAINER,
        expect.objectContaining({ value: expect.objectContaining({ reachable: true }) })
      );
    });

    it.each([[401], [403]])('a token Coder refuses with %i: warns naming the setting, never its value', async (status) => {
      const warn = vi.fn();
      const refused = () => ({ ok: false, status, json: async () => ({}) });
      const fetchImpl = coderFetch({
        ...HEALTHY,
        '/api/v2/templates': refused,
        '/api/v2/workspaces?q=status%3Arunning': refused,
      });
      const res = await handlers({ fetchImpl }).getCoderStatus(request(), { ...context, warn });

      expect(body(res)).toEqual(UNKNOWN);
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('CODER_STATUS_TOKEN') && line.includes(String(status)))).toBe(true);
      expect(lines.join('\n')).not.toContain(ENV.CODER_STATUS_TOKEN);
    });

    it.each([
      ['a templates answer that is not a list', { '/api/v2/templates': { not: 'a list' } }],
      ['a workspaces answer with no count', { '/api/v2/workspaces?q=status%3Arunning': { count: 'two' } }],
      ['a failing workspaces read', { '/api/v2/workspaces?q=status%3Arunning': () => ({ ok: false, status: 500, json: async () => ({}) }) }],
    ])('%s: the detail is unknown, never guessed at', async (_label, routes) => {
      const warn = vi.fn();
      const fetchImpl = coderFetch({ ...HEALTHY, ...routes });
      const res = await handlers({ fetchImpl }).getCoderStatus(request(), { ...context, warn });
      expect(body(res)).toEqual(UNKNOWN);
      expect(warn).toHaveBeenCalled();
    });
  });

  it('unreachable: a Coder that does not answer within the timeout', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    const pending = handlers({ fetchImpl }).getCoderStatus(request(), context);
    await vi.advanceTimersByTimeAsync(CODER_TIMEOUT_MS + 1);
    const res = await pending;
    expect(body(res)).toMatchObject({ configured: true, reachable: false, capacity: { running: null, max: 5 } });
  });

  it('cache hit: serves the stored body and does not call Coder', async () => {
    const stored = { configured: true, reachable: true, templates: [], capacity: { running: 1, max: 5 }, asOf: 'x' };
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc(stored, 30_000)) });
    const fetchImpl = vi.fn();
    const res = await handlers({ store, fetchImpl }).getCoderStatus(request(), context);

    expect(body(res)).toEqual(stored);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('a stale healthy entry is replaced by the failure, so the card never shows old numbers', async () => {
    const stale = { configured: true, reachable: true, templates: [], capacity: { running: 4, max: 5 }, asOf: 'x' };
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc(stale, 61_000)) });
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const res = await handlers({ store, fetchImpl }).getCoderStatus(request(), context);

    expect(body(res).reachable).toBe(false);
    expect(body(res).capacity.running).toBeNull();
    expect(store.upsertDoc).toHaveBeenCalledWith(
      CACHE_CONTAINER,
      expect.objectContaining({ value: expect.objectContaining({ reachable: false }) })
    );
  });

  it('readStatus is the same body the route returns, for the estate read', async () => {
    const h = handlers();
    const direct = await h.readStatus(context);
    const routed = body(await h.getCoderStatus(request(), context));
    expect(direct).toEqual(routed);
  });

  it('answers 500 when something outside the guarded paths throws', async () => {
    const error = vi.fn();
    const h = createCoderStatusHandlers({
      store: makeStore(),
      fetchImpl: coderFetch(HEALTHY),
      env: ENV,
      now: () => {
        throw new Error('clock broke');
      },
    });
    const res = await h.getCoderStatus(request(), { ...context, error });
    expect(res.status).toBe(500);
    expect(body(res)).toEqual({ error: 'Failed to read Coder status' });
    expect(error).toHaveBeenCalled();
  });
});

describe('the status token\'s own expiry (#763)', () => {
  const KEY_ENV = { ...ENV, CODER_STATUS_TOKEN: 'AbCdEf1234-s3cr3ts3cr3t' };
  const keyPath = '/api/v2/users/me/keys/AbCdEf1234';
  const guardAs = (error = null) => ({
    requireRole: vi.fn(async () => (error ? { error } : { user: { oid: 'u1' }, role: 'editor' })),
  });
  const config = () => readCoderConfig(KEY_ENV);

  it('reads the key id off the token, and nothing off a value that is not a Coder key', () => {
    expect(tokenKeyId('AbCdEf1234-s3cr3t')).toBe('AbCdEf1234');
    expect(tokenKeyId('  AbCdEf1234-s3cr3t\n')).toBe('AbCdEf1234');
    expect(tokenKeyId('read-only-token-with-dashes')).toBe('');
    expect(tokenKeyId('nodash')).toBe('');
    expect(tokenKeyId('')).toBe('');
  });

  it('answers the expiry, days left and renewSoon from the key record, with the token in the header', async () => {
    const expires = new Date(NOW + 200 * 86_400_000).toISOString();
    const fetchImpl = coderFetch({
      [keyPath]: { id: 'AbCdEf1234', expires_at: expires, token_name: 'hcw-status', scopes: ['template:read', 'workspace:read', 'api_key:read'] },
    });
    const out = await readTokenExpiry({ fetchImpl, config: config(), context, now: () => NOW });
    expect(out).toEqual({
      known: true,
      expiresAt: expires,
      daysLeft: 200,
      renewSoon: false,
      tokenName: 'hcw-status',
      scopes: ['template:read', 'workspace:read', 'api_key:read'],
    });
    const call = fetchImpl.calls.find(({ url }) => url.endsWith(keyPath));
    expect(call.options.headers['Coder-Session-Token']).toBe('AbCdEf1234-s3cr3ts3cr3t');

    const soon = new Date(NOW + (TOKEN_RENEW_WARNING_DAYS - 1) * 86_400_000).toISOString();
    const near = await readTokenExpiry({
      fetchImpl: coderFetch({ [keyPath]: { expires_at: soon } }),
      config: config(),
      context,
      now: () => NOW,
    });
    expect(near).toMatchObject({ known: true, daysLeft: TOKEN_RENEW_WARNING_DAYS - 1, renewSoon: true, tokenName: null, scopes: [] });
  });

  it('says why when it cannot: no token, not a key, the scope (403 or 404), refused (401), a failure', async () => {
    expect(await readTokenExpiry({ fetchImpl: vi.fn(), config: readCoderConfig(ENV_NO_TOKEN), context })).toEqual({ known: false, reason: 'unset' });
    expect(await readTokenExpiry({ fetchImpl: vi.fn(), config: readCoderConfig(ENV), context })).toEqual({ known: false, reason: 'shape' });
    const refusedBy = (status) => coderFetch({ [keyPath]: () => ({ ok: false, status, json: async () => ({}) }) });
    expect(await readTokenExpiry({ fetchImpl: refusedBy(403), config: config(), context })).toEqual({ known: false, reason: 'scope', scope: TOKEN_SCOPE_FOR_EXPIRY });
    expect(await readTokenExpiry({ fetchImpl: refusedBy(401), config: config(), context })).toEqual({ known: false, reason: 'refused' });
    const warn = vi.fn();
    expect(await readTokenExpiry({ fetchImpl: refusedBy(500), config: config(), context: { warn } })).toEqual({ known: false, reason: 'error' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be read (Coder answered 500)'));
    expect(warn.mock.calls[0][0]).not.toContain('AbCdEf1234');
    expect(await readTokenExpiry({ fetchImpl: coderFetch({ [keyPath]: { expires_at: 'soon' } }), config: config(), context })).toEqual({ known: false, reason: 'shape' });
  });

  // Coder v2.38.0's apiKeyByID goes through httpapi.Is404Error, which answers
  // an unauthorized read as not found, so the live token (no api_key:read)
  // read its own record as 404 and the check said nothing useful (#1009).
  it.each([[403], [404]])(
    'reads %i on the token\'s own record as the missing api_key:read scope, and says to re-issue the token with it',
    async (status) => {
      const warn = vi.fn();
      const fetchImpl = coderFetch({ [keyPath]: () => ({ ok: false, status, json: async () => ({}) }) });
      expect(await readTokenExpiry({ fetchImpl, config: config(), context: { warn } })).toEqual({
        known: false,
        reason: 'scope',
        scope: TOKEN_SCOPE_FOR_EXPIRY,
      });
      expect(SCOPE_REFUSAL_STATUSES).toContain(status);
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0];
      expect(line).toContain(`(${status})`);
      expect(line).toMatch(/re-issue the token with api_key:read added/);
      // The status, never the path: the path carries the key id.
      expect(line).not.toContain('AbCdEf1234');
    }
  );

  it('GET cms/labs/coder-token: editor only, unconfigured without a URL, the token read otherwise, never cached', async () => {
    const denied = { status: 403, headers: {}, body: '{}' };
    const h = createCoderStatusHandlers({ store: makeStore(), guard: guardAs(denied), fetchImpl: vi.fn(), env: KEY_ENV, now: () => NOW });
    expect(await h.getCoderToken(request(), context)).toBe(denied);

    const unconfigured = createCoderStatusHandlers({ store: makeStore(), guard: guardAs(), fetchImpl: vi.fn(), env: {}, now: () => NOW });
    expect(body(await unconfigured.getCoderToken(request(), context))).toEqual({ configured: false });

    const expires = new Date(NOW + 10 * 86_400_000).toISOString();
    const fetchImpl = coderFetch({ [keyPath]: { expires_at: expires } });
    const res = await createCoderStatusHandlers({ store: makeStore(), guard: guardAs(), fetchImpl, env: KEY_ENV, now: () => NOW }).getCoderToken(request(), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(body(res)).toEqual({
      configured: true,
      warningDays: TOKEN_RENEW_WARNING_DAYS,
      token: { known: true, expiresAt: expires, daysLeft: 10, renewSoon: true, tokenName: null, scopes: [] },
    });
    // Without a guard the read refuses to run rather than answer anonymously.
    const unguarded = createCoderStatusHandlers({ store: makeStore(), fetchImpl, env: KEY_ENV, now: () => NOW });
    expect((await unguarded.getCoderToken(request(), context)).status).toBe(500);
  });
});

describe('verifying a renewed status token before it is stored (Coder automation)', () => {
  // Shaped like a Coder key and plainly not one. Every key-shaped value here,
  // near misses included, is built at run time: a literal in Coder's API key
  // shape reads as a leaked token to secret scanners (GitGuardian flagged
  // these on #1030).
  const ID = 'FAKEKEYID0';
  const SECRET = 'FAKESECRETFAKESECRET00';
  const CANDIDATE = [ID, SECRET].join('-');
  const config = { base: 'https://coder.lab.example', token: 'the-stored-one', max: 5 };
  const RUNNING = '/api/v2/workspaces?q=status%3Arunning';
  const ME = '/api/v2/users/me';
  const KEY = `/api/v2/users/me/keys/${ID}`;
  const READ_SCOPES = [...STATUS_TOKEN_SCOPES, ...STATUS_TOKEN_EXTRA_SCOPES];

  /** A Coder whose three answers are right unless a test says otherwise. */
  const coder = (over = {}) =>
    coderFetch({
      [RUNNING]: { count: 3, workspaces: [] },
      [ME]: { id: 'u1', username: DEFAULT_CODER_STATUS_USER },
      [KEY]: { id: ID, scopes: READ_SCOPES, scope: '', token_name: 'renewed' },
      ...over,
    });
  const status = (code) => () => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({ count: 1 }) });
  const verify = (fetchImpl, extra = {}) => verifyStatusToken({ fetchImpl, config, token: CANDIDATE, ...extra });

  it('knows the shape of a Coder API key: ten letters or digits, a dash, twenty-two more', () => {
    expect(CODER_API_KEY_PATTERN.test(CANDIDATE)).toBe(true);
    for (const wrong of [
      [ID.slice(1), SECRET].join('-'), // nine-character id
      [`${ID}0`, SECRET.slice(1)].join('-'), // eleven
      [ID, SECRET.slice(1)].join('-'), // twenty-one-character secret
      [ID, SECRET].join('_'),
      [ID, SECRET.slice(0, 10), SECRET.slice(11)].join('-'),
      ` ${CANDIDATE}`,
      `${CANDIDATE}\n`,
      'read-only-token',
    ]) {
      expect(CODER_API_KEY_PATTERN.test(wrong), wrong).toBe(false);
    }
  });

  it('passes a working, read-only key of the status user, asking each read with the candidate', async () => {
    const fetchImpl = coder();
    await expect(verify(fetchImpl)).resolves.toEqual({ ok: true, running: 3, expiresAt: null });
    expect(fetchImpl.calls.map(({ url }) => url)).toEqual([
      `https://coder.lab.example${RUNNING}`,
      `https://coder.lab.example${ME}`,
      `https://coder.lab.example${KEY}`,
    ]);
    for (const { options } of fetchImpl.calls) {
      // The candidate, not the stored token; and no redirect may carry it on.
      expect(options.headers['Coder-Session-Token']).toBe(CANDIDATE);
      expect(options.redirect).toBe('error');
      expect(options.signal).toBeDefined();
    }
    // Without user:read too, as Coder may issue it: the three are required, user:read is permitted.
    await expect(verify(coder({ [KEY]: { scopes: [...STATUS_TOKEN_SCOPES] } }))).resolves.toMatchObject({ ok: true });
  });

  it('reports the key’s own expiry from Coder’s nanosecond expires_at, and null for anything unreadable', async () => {
    const withExpiry = (expires_at) => coder({ [KEY]: { scopes: [...STATUS_TOKEN_SCOPES], expires_at } });
    expect((await verify(withExpiry('2027-11-30T00:00:00.123456789Z'))).expiresAt).toBe('2027-11-30T00:00:00.123Z');
    expect((await verify(withExpiry('2027-11-30T00:00:00Z'))).expiresAt).toBe('2027-11-30T00:00:00.000Z');
    for (const bad of ['never', '', null, 42]) {
      expect((await verify(withExpiry(bad))).expiresAt, String(bad)).toBeNull();
    }
  });

  it('accepts zero, and nothing that is not an integer count', async () => {
    expect(await verify(coder({ [RUNNING]: { count: 0 } }))).toEqual({ ok: true, running: 0, expiresAt: null });
    for (const answer of [{}, { count: '2' }, { count: 1.5 }, { workspaces: [{ id: 'w' }] }, null]) {
      const verdict = await verify(coder({ [RUNNING]: () => okJson(answer) }));
      expect(verdict, JSON.stringify(answer)).toEqual({
        ok: false,
        check: 'works',
        reason: 'Coder answered the running-workspaces read without a count',
      });
    }
  });

  it('requires exactly 200 from every read: a 201 with a count is not the documented answer', async () => {
    expect(await verify(coder({ [RUNNING]: status(201) }))).toEqual({
      ok: false,
      check: 'works',
      reason: 'Coder answered HTTP 201 to the running-workspaces read',
    });
    expect(await verify(coder({ [ME]: status(204) }))).toMatchObject({
      check: 'user',
      reason: 'User check: Coder answered HTTP 204 when the token asked for its own user',
    });
    expect(await verify(coder({ [KEY]: status(203) }))).toMatchObject({
      check: 'scopes',
      reason: 'Scope check: Coder answered HTTP 203 when the token asked for its own key record',
    });
  });

  it('refuses a working key that belongs to someone else, without naming them', async () => {
    const verdict = await verify(coder({ [ME]: { username: 'some-learner' } }));
    expect(verdict).toEqual({
      ok: false,
      check: 'user',
      reason: 'User check: the token does not belong to hcw-status',
    });
    expect(verdict.reason).not.toContain('some-learner');
  });

  it('checks the user CODER_STATUS_USER names, and hcw-status when it names none', async () => {
    expect(readStatusUser({})).toBe('hcw-status');
    expect(readStatusUser({ CODER_STATUS_USER: ' lab-status ' })).toBe('lab-status');
    const fetchImpl = coder({ [ME]: { username: 'lab-status' } });
    await expect(verify(fetchImpl, { expectedUser: 'lab-status' })).resolves.toMatchObject({ ok: true });
    await expect(verify(fetchImpl)).resolves.toMatchObject({ ok: false, check: 'user' });
  });

  it('says which scope its own user needs when Coder hides it (404, or 403)', async () => {
    for (const code of [404, 403]) {
      expect(await verify(coder({ [ME]: () => ({ ok: false, status: code, json: async () => ({}) }) }))).toEqual({
        ok: false,
        check: 'user',
        reason: `User check: Coder would not show the token its own user (HTTP ${code}), which it refuses a token without user:read`,
      });
    }
  });

  it('refuses an unscoped key, whether Coder says coder:all or the deprecated scope says all', async () => {
    const unscoped = 'Scope check: the token is unscoped, so it can do whatever its user can; a status token must be scoped to reading';
    for (const record of [
      { scopes: ['coder:all'], scope: 'all' },
      { scopes: ['coder:all'] },
      { scope: 'all' },
      { scopes: [...READ_SCOPES], scope: 'all' },
      { scopes: ['coder:application_connect'], scope: 'application_connect' },
    ]) {
      expect(await verify(coder({ [KEY]: record })), JSON.stringify(record)).toEqual({
        ok: false,
        check: 'scopes',
        reason: unscoped,
      });
    }
  });

  it('refuses a key that can do more than read, naming the extra scopes', async () => {
    expect(
      await verify(coder({ [KEY]: { scopes: [...READ_SCOPES, 'template:update', 'workspace:delete'] } }))
    ).toEqual({
      ok: false,
      check: 'scopes',
      reason: 'Scope check: the token carries scopes beyond reading: template:update, workspace:delete',
    });
    // A wildcard is not reading, and a name Coder never spells is counted, not repeated.
    expect(await verify(coder({ [KEY]: { scopes: [...READ_SCOPES, 'workspace:*', 'Not A Scope!'] } }))).toMatchObject({
      reason: 'Scope check: the token carries scopes beyond reading: workspace:*, 1 unrecognised',
    });
  });

  it('refuses a key without api_key:read, from its record or from Coder hiding the record', async () => {
    expect(await verify(coder({ [KEY]: { scopes: ['template:read', 'workspace:read', 'user:read'] } }))).toEqual({
      ok: false,
      check: 'scopes',
      reason: 'Scope check: the token lacks api_key:read',
    });
    expect(await verify(coder({ [KEY]: () => ({ ok: false, status: 404, json: async () => ({}) }) }))).toEqual({
      ok: false,
      check: 'scopes',
      reason:
        'Scope check: Coder would not show the token its own key record (HTTP 404), which it refuses a token without api_key:read and user:read',
    });
  });

  it('refuses a record with no scopes list, since what the key can do cannot be checked', async () => {
    for (const record of [{}, { scopes: [] }, { scopes: 'template:read' }, { scope: '' }]) {
      expect(await verify(coder({ [KEY]: record })), JSON.stringify(record)).toMatchObject({
        check: 'scopes',
        reason: "Scope check: Coder's record of the token lists no scopes, so what it can do could not be checked",
      });
    }
    expect(statusScopeProblem(null)).toMatch(/lists no scopes/);
  });

  it('says why in words that carry neither the token nor Coder’s address', async () => {
    const cases = [
      [() => ({ ok: false, status: 401, json: async () => ({}) }), 'Coder refused the token (HTTP 401)'],
      [() => ({ ok: false, status: 403, json: async () => ({}) }), 'Coder refused the token (HTTP 403)'],
      [
        () => ({ ok: false, status: 502, json: async () => ({}) }),
        'Coder answered HTTP 502 to the running-workspaces read',
      ],
      [
        () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }),
        'Coder answered with something that is not JSON',
      ],
      [
        () => {
          throw new TypeError(`fetch failed for ${CANDIDATE} at https://coder.lab.example`);
        },
        'Coder could not be reached',
      ],
    ];
    for (const [answer, reason] of cases) {
      const verdict = await verify(coder({ [RUNNING]: answer }));
      expect(verdict).toEqual({ ok: false, check: 'works', reason });
      expect(verdict.reason).not.toContain(CANDIDATE);
      expect(verdict.reason).not.toContain('coder.lab.example');
    }
    // Nor in the later checks' sentences.
    const later = await verify(
      coder({
        [ME]: () => {
          throw new TypeError(`fetch failed for ${CANDIDATE}`);
        },
      })
    );
    expect(later).toEqual({ ok: false, check: 'user', reason: 'User check: Coder could not be reached' });
  });

  it('gives up after the same five seconds as every other Coder call', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    const pending = verify(fetchImpl);
    await vi.advanceTimersByTimeAsync(CODER_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({
      ok: false,
      check: 'works',
      reason: 'Coder did not answer within 5 s',
    });
  });
});
