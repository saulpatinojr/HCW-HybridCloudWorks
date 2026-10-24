import { afterEach, describe, expect, it, vi } from 'vitest';

import { CACHE_CONTAINER } from '../cloud-tools/history.js';
import { ADDON_IDS, ADDONS, isKnownAddon } from './registry.js';
import {
  ADDON_STATUS_CACHE_KIND,
  ADDON_STATUS_CACHE_SECONDS,
  ADDON_STATUS_FIELDS,
  ADDON_TIMEOUT_MS,
  addonStatusCacheId,
  createAddonStatusHandlers,
  projectHealth,
  readAddonConfig,
} from './status.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const URL_SETTING = 'https://migration.lab.example/';
const ENV = { ADDON_MIGRATION_URL: URL_SETTING };

const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** A GET request for one id, as the Function host hands it over. */
const request = (id) => ({ method: 'GET', params: { id }, query: { get: () => null } });
/** The parsed JSON body of an answer. */
const body = (res) => JSON.parse(res.body);

/** A cache store stand-in: readDoc misses and upsertDoc succeeds unless overridden. */
const makeStore = (over = {}) => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, d) => d),
  ...over,
});

/** A fetch Response stand-in whose body is a readable stream of `text`, in 8 KiB chunks, with a cancel spy. */
const streamCancel = vi.fn();
const streamed = (text, status = 200) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 8192));
      offset += 8192;
      return undefined;
    },
    cancel: streamCancel,
  });
  return { ok: status < 300, status, headers: { get: () => null }, body: stream };
};

/** A fetch Response stand-in: status, the body as text, and no Content-Length unless given. */
const okJson = (data, status = 200, headers = {}) => ({
  ok: status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(data),
  json: async () => data,
});

/** The AddOn's health body as the migration edition answers it, extras included. */
const HEALTH = {
  ok: true,
  id: 'migration',
  version: '0.3.0',
  edition: 'demo',
  capabilities: ['assessments', 'sample-csv', 'bundle-download'],
  asOf: '2026-10-10T11:59:40.000Z',
  siteOrigins: ['https://hybridcloudworks.com', 'https://www.hybridcloudworks.com'],
  turnstile: { required: true, siteKey: '1x00000000000000000000AA' },
  rulesLoaded: true,
  azureConnectivity: 'disabled-by-design',
  workspace: 'disabled',
};

/** An AddOn that answers by path, recording every call. */
function addonFetch(routes, calls = []) {
  const fetchImpl = vi.fn(async (url, options) => {
    calls.push({ url, options });
    const hit = routes[new URL(url).pathname];
    if (hit === undefined) return okJson({}, 404);
    return typeof hit === 'function' ? hit() : okJson(hit);
  });
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** A cache document for the migration id, written `ageMs` before NOW. */
const cachedDoc = (value, ageMs) => ({
  id: addonStatusCacheId('migration'),
  kind: ADDON_STATUS_CACHE_KIND,
  value,
  cachedAt: new Date(NOW - ageMs).toISOString(),
});

/** The handlers under test with a healthy fetch, a fresh store and a fixed clock, unless overridden. */
const handlers = (over = {}) =>
  createAddonStatusHandlers({
    store: makeStore(),
    fetchImpl: addonFetch({ '/api/health': HEALTH }),
    env: ENV,
    now: () => NOW,
    ...over,
  });

/** Nothing a visitor receives, and nothing logged, may carry the AddOn's address. */
function expectNoUrl(...texts) {
  for (const text of texts) expect(text).not.toMatch(/migration\.lab\.example|https?:\/\//);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('the registry', () => {
  it('names the four program AddOns, each with its setting and health path', () => {
    expect(ADDON_IDS).toEqual([
      'migration',
      'network-assessment',
      'cloud-assessment',
      'cloud-crawler',
    ]);
    for (const id of ADDON_IDS) {
      expect(ADDONS[id].setting).toBe(`ADDON_${id.replace(/-/g, '_').toUpperCase()}_URL`);
      expect(ADDONS[id].healthPath).toBe('/api/health');
      expect(Object.isFrozen(ADDONS[id])).toBe(true);
    }
    expect(Object.isFrozen(ADDONS)).toBe(true);
  });

  it('knows an id by own property only', () => {
    expect(isKnownAddon('migration')).toBe(true);
    expect(isKnownAddon('constructor')).toBe(false);
    expect(isKnownAddon('__proto__')).toBe(false);
    expect(isKnownAddon(undefined)).toBe(false);
    expect(isKnownAddon(['migration'])).toBe(false);
  });
});

describe('readAddonConfig', () => {
  it('reads the https address for a known id, trailing slash removed', () => {
    expect(readAddonConfig(ENV, 'migration')).toEqual({
      base: 'https://migration.lab.example',
      healthPath: '/api/health',
    });
  });

  it.each([
    ['absent', {}],
    ['blank', { ADDON_MIGRATION_URL: '   ' }],
    ['an unresolved Key Vault reference', { ADDON_MIGRATION_URL: '@Microsoft.KeyVault(SecretUri=x)' }],
    ['plain http', { ADDON_MIGRATION_URL: 'http://migration.lab.example' }],
    ['not a URL', { ADDON_MIGRATION_URL: 'migration.lab.example' }],
  ])('is null when the setting is %s', (_label, env) => {
    expect(readAddonConfig(env, 'migration')).toBeNull();
  });

  it('is null for an id the registry does not name, whatever the environment says', () => {
    expect(readAddonConfig({ ADDON_OTHER_URL: 'https://x.example' }, 'other')).toBeNull();
    expect(readAddonConfig(ENV, 'constructor')).toBeNull();
  });
});

describe('projectHealth', () => {
  it('copies version, edition, capabilities and asOf, and nothing else', () => {
    expect(projectHealth(HEALTH)).toEqual({
      version: '0.3.0',
      edition: 'demo',
      capabilities: ['assessments', 'sample-csv', 'bundle-download'],
      asOf: '2026-10-10T11:59:40.000Z',
    });
  });

  it.each([
    ['missing', undefined],
    ['not a string', 1760097580000],
    ['not a timestamp', 'yesterday'],
    ['too long', `2026-10-10T11:59:40.000Z${'0'.repeat(40)}`],
  ])('nulls an asOf that is %s so the caller uses the read time', (_label, asOf) => {
    expect(projectHealth({ ...HEALTH, asOf }).asOf).toBeNull();
  });

  it.each([
    ['not an object', 'ok'],
    ['ok false', { ...HEALTH, ok: false }],
    ['no version', { ...HEALTH, version: undefined }],
    ['a version that is not semver', { ...HEALTH, version: 'latest' }],
    ['a semver prefix with a long tail', { ...HEALTH, version: `1.2.3${'x'.repeat(200)}` }],
    ['a semver prefix with a space', { ...HEALTH, version: '1.2.3 and more' }],
    ['a version over the length bound', { ...HEALTH, version: `1.2.3-${'a'.repeat(40)}` }],
  ])('refuses a body that is %s', (_label, health) => {
    expect(() => projectHealth(health)).toThrow(/health body/);
  });

  it.each(['0.3.0', '1.2.3-beta.1', '1.2.3+build.7', '1.2.3-rc.1+sha.abc', '1.2.3-feature-branch-2026-10-10.1'])('accepts the whole semver %s', (version) => {
    expect(projectHealth({ ...HEALTH, version }).version).toBe(version);
  });

  it('bounds edition and capabilities', () => {
    const long = 'x'.repeat(41);
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`);
    expect(projectHealth({ ...HEALTH, edition: long, capabilities: [...many, long, 7] })).toEqual({
      version: '0.3.0',
      edition: null,
      capabilities: many.slice(0, 20),
      asOf: HEALTH.asOf,
    });
    expect(projectHealth({ ...HEALTH, edition: 42, capabilities: 'all' }).capabilities).toEqual([]);
  });
});

describe('getAddonStatus', () => {
  it('answers { configured: false } with no store read and no network when the setting is unset', async () => {
    const store = makeStore();
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const res = await handlers({ store, fetchImpl, env: {} }).getAddonStatus(request('migration'), context);
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ configured: false });
    expect(res.headers['Cache-Control']).toBeUndefined();
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps Cloud Crawler closed while it is coming: a known id, no setting, so no store read and no network', async () => {
    const store = makeStore();
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    // Every setting the site declares today is present; ADDON_CLOUD_CRAWLER_URL is not.
    const env = {
      ...ENV,
      ADDON_MIGRATION_URL: 'https://migration.lab.example',
      ADDON_NETWORK_ASSESSMENT_URL: 'https://network-assessment.lab.example',
      ADDON_CLOUD_ASSESSMENT_URL: 'https://cloud-assessment.lab.example',
    };
    const res = await handlers({ store, fetchImpl, env }).getAddonStatus(request('cloud-crawler'), context);
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ configured: false });
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a non-https setting as not configured, and names the setting in a warning without the value', async () => {
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const res = await handlers({
      fetchImpl,
      env: { ADDON_MIGRATION_URL: 'http://migration.lab.example' },
    }).getAddonStatus(request('migration'), context);
    expect(body(res)).toEqual({ configured: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('ADDON_MIGRATION_URL'));
    expectNoUrl(...context.warn.mock.calls.flat());
  });

  it('projects a healthy answer to exactly the six fields, and caches it for a minute', async () => {
    const store = makeStore();
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const res = await handlers({ store, fetchImpl }).getAddonStatus(request('migration'), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe(`public, max-age=${ADDON_STATUS_CACHE_SECONDS}`);
    const answer = body(res);
    expect(answer).toEqual({
      configured: true,
      reachable: true,
      version: '0.3.0',
      edition: 'demo',
      capabilities: ['assessments', 'sample-csv', 'bundle-download'],
      asOf: HEALTH.asOf,
    });
    expect(Object.keys(answer).sort()).toEqual([...ADDON_STATUS_FIELDS].sort());
    expectNoUrl(res.body);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [{ url, options }] = fetchImpl.calls;
    expect(url).toBe('https://migration.lab.example/api/health');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(options.signal).toBeInstanceOf(AbortSignal);

    expect(store.upsertDoc).toHaveBeenCalledWith(
      CACHE_CONTAINER,
      expect.objectContaining({
        id: 'addons:migration:status',
        kind: ADDON_STATUS_CACHE_KIND,
        value: answer,
        ttl: ADDON_STATUS_CACHE_SECONDS,
      })
    );
  });

  it('serves a fresh cached document without calling the AddOn', async () => {
    const cached = {
      configured: true,
      reachable: true,
      version: '0.2.9',
      edition: 'demo',
      capabilities: ['assessments'],
      asOf: '2026-10-10T11:59:30.000Z',
    };
    const store = makeStore({ readDoc: vi.fn(async () => cachedDoc(cached, 30_000)) });
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const res = await handlers({ store, fetchImpl }).getAddonStatus(request('migration'), context);
    expect(body(res)).toEqual(cached);
    expect(store.readDoc).toHaveBeenCalledWith(CACHE_CONTAINER, 'addons:migration:status', 'addons:migration:status');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('shares one live read among concurrent requests that all miss the cache', async () => {
    const store = makeStore();
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const h = handlers({ store, fetchImpl });
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => h.getAddonStatus(request('migration'), context))
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    for (const res of answers) expect(body(res)).toMatchObject({ configured: true, reachable: true });
    // The next miss after settlement reads again: the shared promise is not kept past its read.
    store.readDoc.mockResolvedValueOnce(null);
    await h.getAddonStatus(request('migration'), context);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('logs a failed read by category and class, never by message', async () => {
    const store = makeStore();
    store.readDoc.mockImplementation(async () => {
      throw Object.assign(new Error('read https://migration.lab.example/boom failed'), { code: 'ECOSMOS' });
    });
    store.upsertDoc.mockImplementation(async () => {
      throw new Error('write https://migration.lab.example/boom failed');
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: https://migration.lab.example/api/health');
    });
    const res = await handlers({ store, fetchImpl }).getAddonStatus(request('migration'), context);
    expect(res.status).toBe(200);
    expectNoUrl(res.body, ...context.warn.mock.calls.flat(), ...context.error.mock.calls.flat());
  });

  it('cancels the body of a rejected answer so the exchange ends with the deadline', async () => {
    streamCancel.mockClear();
    const res = await handlers({ fetchImpl: () => Promise.resolve(streamed('nope', 503)) }).getAddonStatus(
      request('migration'),
      context
    );
    expect(body(res)).toMatchObject({ configured: true, reachable: false });
    expect(streamCancel).toHaveBeenCalledTimes(1);
  });

  it('reads a streamed health body and cancels one that passes the budget', async () => {
    streamCancel.mockClear();
    const small = await handlers({ fetchImpl: () => Promise.resolve(streamed(JSON.stringify(HEALTH))) }).getAddonStatus(
      request('migration'),
      context
    );
    expect(body(small)).toMatchObject({ reachable: true, version: '0.3.0' });
    expect(streamCancel).not.toHaveBeenCalled();

    const large = await handlers({ fetchImpl: () => Promise.resolve(streamed('x'.repeat(40_000))) }).getAddonStatus(
      request('migration'),
      context
    );
    expect(body(large)).toMatchObject({ configured: true, reachable: false });
    expect(streamCancel).toHaveBeenCalledTimes(1);
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('reads live past a minute, replacing the stale document', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => cachedDoc({ configured: true, reachable: false }, 61_000)),
    });
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const res = await handlers({ store, fetchImpl }).getAddonStatus(request('migration'), context);
    expect(body(res).reachable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['refuses', () => okJson({}, 503)],
    ['redirects', () => okJson({}, 302)],
    [
      'times out',
      () => {
        throw Object.assign(new Error('timeout after 5000 ms'), { code: 'FETCH_TIMEOUT' });
      },
    ],
    [
      'cannot be reached',
      () => {
        throw new TypeError('fetch failed: https://migration.lab.example/api/health');
      },
    ],
    ['answers no JSON', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>' })],
    ['declares a body over the budget', () => okJson(HEALTH, 200, { 'content-length': '100000' })],
    ['sends a body over the budget', () => okJson({ ...HEALTH, padding: 'x'.repeat(20_000) })],
    ['streams a body over the budget with no Content-Length', () => streamed('x'.repeat(40_000))],
    ['answers ok: false', () => okJson({ ...HEALTH, ok: false })],
    ['answers without a version', () => okJson({ ok: true, id: 'migration' })],
  ])('reports unreachable, caches the failure and names no URL when the AddOn %s', async (_label, answer) => {
    const store = makeStore({
      readDoc: vi.fn(async () =>
        cachedDoc({ configured: true, reachable: true, version: '0.3.0', edition: 'demo', capabilities: [], asOf: 'x' }, 61_000)
      ),
    });
    const res = await handlers({ store, fetchImpl: addonFetch({ '/api/health': answer }) }).getAddonStatus(
      request('migration'),
      context
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      configured: true,
      reachable: false,
      version: null,
      edition: null,
      capabilities: [],
      asOf: new Date(NOW).toISOString(),
    });
    expect(res.headers['Cache-Control']).toBe(`public, max-age=${ADDON_STATUS_CACHE_SECONDS}`);
    // The failure replaces the healthy entry.
    expect(store.upsertDoc).toHaveBeenCalledWith(
      CACHE_CONTAINER,
      expect.objectContaining({ value: expect.objectContaining({ reachable: false }) })
    );
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('ADDON_MIGRATION_URL unreachable'));
    expect(context.warn.mock.calls.flat().join(' ')).not.toMatch(/\bmigration\b/);
    expectNoUrl(res.body, ...context.warn.mock.calls.flat());
  });

  it('answers 404 for an id the registry does not name, with no store read and no network', async () => {
    const store = makeStore();
    const fetchImpl = addonFetch({ '/api/health': HEALTH });
    const env = { ...ENV, ADDON_OTHER_URL: 'https://other.lab.example' };
    for (const id of ['other', 'constructor', '', undefined]) {
      const res = await handlers({ store, fetchImpl, env }).getAddonStatus(request(id), context);
      expect(res.status).toBe(404);
      expect(body(res)).toEqual({ error: 'Unknown add-on' });
    }
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps one cache document per AddOn', async () => {
    const store = makeStore();
    const env = { ...ENV, ADDON_CLOUD_ASSESSMENT_URL: 'https://cloud-assessment.lab.example' };
    const h = handlers({ store, env });
    await h.getAddonStatus(request('migration'), context);
    await h.getAddonStatus(request('cloud-assessment'), context);
    expect(store.upsertDoc.mock.calls.map(([, doc]) => doc.id)).toEqual([
      'addons:migration:status',
      'addons:cloud-assessment:status',
    ]);
  });

  it('reads the status read through the same path the route uses', async () => {
    const h = handlers();
    expect(await h.readStatus('migration', context)).toMatchObject({ configured: true, reachable: true });
    expect(await h.readStatus('other', context)).toEqual({ configured: false });
  });

  it('bounds the health read at five seconds', () => {
    expect(ADDON_TIMEOUT_MS).toBe(5_000);
  });

  it('answers 500 with a plain sentence when the read itself throws', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw new Error('cosmos down at https://cosmos.example');
      }),
      upsertDoc: vi.fn(async () => {
        throw new Error('cosmos down at https://cosmos.example');
      }),
    });
    // The cache is best-effort in both directions, so a store failure is a
    // live read, not a 500; a thrown handler is what answers 500.
    const res = await handlers({ store }).getAddonStatus(request('migration'), context);
    expect(res.status).toBe(200);
    expect(body(res).reachable).toBe(true);

    const broken = createAddonStatusHandlers({
      store: makeStore(),
      fetchImpl: () => Promise.resolve(okJson(HEALTH)),
      env: ENV,
      now: () => {
        throw new Error('clock at https://clock.example');
      },
    });
    const failed = await broken.getAddonStatus(request('migration'), context);
    expect(failed.status).toBe(500);
    expect(body(failed)).toEqual({ error: 'Failed to read the add-on status' });
    expectNoUrl(failed.body);
  });
});
