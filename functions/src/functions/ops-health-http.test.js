/**
 * The ops-health routes as registered (#946).
 *
 * lib/ops-health.test.js proves the snapshot cache holds across handler sets
 * that share a store. This proves the other half, the one that broke:
 * ops-health-http.js builds a handler set per request, and the cache is only
 * reached again if every one of them is given the same store. When the store
 * was an object literal inside the per-request factory, every Health view ran
 * the eleven-query fan-out while the lib's own test, which reused a single
 * instance, stayed green.
 *
 * The Cosmos functions are spies behind the real module's other exports, the
 * guard admits everyone, and httpRoute captures the handler without CORS, so
 * what is measured is the registration and the cache, nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registrations = new Map();
vi.mock('../lib/auth/http-route.js', async (importOriginal) => ({
  ...(await importOriginal()),
  httpRoute: (name, options) => registrations.set(name, options),
}));

vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({
    requireRole: async (_request, role) => ({ user: { oid: 'u1', name: 'Ops' }, role, error: null }),
  }),
}));

const queryDocs = vi.fn();
const readDoc = vi.fn();
const upsertDoc = vi.fn();
const patchDoc = vi.fn();
vi.mock('../lib/cosmos-client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  queryDocs: (...args) => queryDocs(...args),
  readDoc: (...args) => readDoc(...args),
  upsertDoc: (...args) => upsertDoc(...args),
  patchDoc: (...args) => patchDoc(...args),
}));

const { OPS_HEALTH_CACHE_TTL_MS, resetOpsHealthCache } = await import('../lib/ops-health.js');
await import('./ops-health-http.js');

const T0 = new Date('2026-10-15T12:00:00.000Z');

const makeContext = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), invocationId: 'inv-1' });
const makeRequest = (body = {}) => ({
  query: new URLSearchParams(),
  headers: new Headers({ 'user-agent': 'vitest' }),
  json: async () => body,
});

/** One request through the registered route, as the host would make it. */
const call = (name, body) => registrations.get(name).handler(makeRequest(body), makeContext());

beforeEach(() => {
  resetOpsHealthCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  queryDocs
    .mockReset()
    .mockImplementation(async (_container, query) => (query.includes('VALUE COUNT') ? [0] : []));
  readDoc
    .mockReset()
    .mockImplementation(async (container, id) =>
      container === 'workflow_alerts' ? { id, alertType: 'link_rot', active: true } : null
    );
  upsertDoc.mockReset().mockImplementation(async (_container, doc) => doc);
  patchDoc.mockReset().mockImplementation(async (_container, id, updates) => ({ id, ...updates }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getOpsHealthSnapshot, through its registration', () => {
  it('serves the second request from the cache the first one filled', async () => {
    const first = await call('getOpsHealthSnapshot');
    expect(first.status).toBe(200);
    const fanOut = queryDocs.mock.calls.length;
    expect(fanOut).toBeGreaterThan(0);

    vi.setSystemTime(T0.getTime() + 10_000);
    const second = await call('getOpsHealthSnapshot');
    expect(second.status).toBe(200);
    expect(queryDocs).toHaveBeenCalledTimes(fanOut);
    expect(second.body).toBe(first.body);
  });

  it('builds again once the cached snapshot is 30 s old', async () => {
    await call('getOpsHealthSnapshot');
    const fanOut = queryDocs.mock.calls.length;

    vi.setSystemTime(T0.getTime() + OPS_HEALTH_CACHE_TTL_MS);
    const later = await call('getOpsHealthSnapshot');
    expect(queryDocs).toHaveBeenCalledTimes(fanOut * 2);
    expect(JSON.parse(later.body).generatedAt).toBe(
      new Date(T0.getTime() + OPS_HEALTH_CACHE_TTL_MS).toISOString()
    );
  });

  it('builds again after an alert update made through the other route', async () => {
    await call('getOpsHealthSnapshot');
    const fanOut = queryDocs.mock.calls.length;

    const update = await call('updateWorkflowAlert', { alertId: 'a1', action: 'acknowledge' });
    expect(update.status).toBe(200);

    await call('getOpsHealthSnapshot');
    expect(queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });
});
