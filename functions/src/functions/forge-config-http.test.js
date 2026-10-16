/**
 * forge-config-http.test.js — handler-level tests for Forge Studio HTTP registrations (QA-2 #977).
 *
 * Verifies that the routes registered in forge-config-http.js correctly invoke
 * the underlying forge studio, workspace and queue handlers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const registrations = new Map();
vi.mock('../lib/auth/http-route.js', async (importOriginal) => ({
  ...(await importOriginal()),
  httpRoute: (name, options) => registrations.set(name, options),
  httpRouteByMethod: (name, options) => registrations.set(name, options),
}));

vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({
    requireRole: async (_req, role) => ({ user: { oid: 'user-1', name: 'ForgeEditor' }, role, error: null }),
    requireUser: async () => ({ user: { oid: 'user-1', name: 'ForgeEditor' }, error: null }),
  }),
}));

const queryDocs = vi.fn();
const readDoc = vi.fn();
const createDoc = vi.fn();
const upsertDoc = vi.fn();
const patchDoc = vi.fn();
const replaceDocIfMatch = vi.fn();
const deleteDoc = vi.fn();
vi.mock('../lib/cosmos-client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  queryDocs: (...args) => queryDocs(...args),
  readDoc: (...args) => readDoc(...args),
  createDoc: (...args) => createDoc(...args),
  upsertDoc: (...args) => upsertDoc(...args),
  patchDoc: (...args) => patchDoc(...args),
  replaceDocIfMatch: (...args) => replaceDocIfMatch(...args),
  deleteDoc: (...args) => deleteDoc(...args),
}));

vi.mock('@azure/functions', () => ({
  output: {
    storageQueue: vi.fn((opts) => ({ type: 'queue', ...opts })),
  },
}));

await import('./forge-config-http.js');

const makeContext = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  invocationId: 'inv-forge-1',
  extraOutputs: { set: vi.fn() },
});

const makeRequest = ({ method = 'GET', body = {}, params = {}, query = {} } = {}) => ({
  method,
  params,
  query: new URLSearchParams(query),
  headers: new Headers({ 'user-agent': 'vitest' }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('forge-config-http route registrations (QA-2 #977)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all expected forge studio routes', () => {
    expect(registrations.has('getForgeConfig')).toBe(true);
    expect(registrations.has('updateForgeConfig')).toBe(true);
    expect(registrations.has('cmsForgeBrief')).toBe(true);
    expect(registrations.has('cmsForgeAssist')).toBe(true);
    expect(registrations.has('cmsForgeSave')).toBe(true);
    expect(registrations.has('cmsForgeQueue')).toBe(true);
    expect(registrations.has('cmsForgeQueueUpdate')).toBe(true);
    expect(registrations.has('cmsForgeQueueForge')).toBe(true);
  });

  it('routes GET getForgeConfig to handlers().getForgeConfig', async () => {
    readDoc.mockResolvedValue(null); // falls back to defaultForgeConfig
    const reg = registrations.get('getForgeConfig');
    const res = await reg.handler(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.profile).toBeDefined();
    expect(data.prompts).toBeDefined();
  });

  it('routes GET cms/forge/queue to queue().list', async () => {
    queryDocs.mockResolvedValueOnce([]);
    const reg = registrations.get('cmsForgeQueue');
    const res = await reg.handlers.GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.items)).toBe(true);
  });
});
