/**
 * handlers.js: GET cms/search-console and POST cms/search-console/run
 * (#1612), against a stubbed guard and store.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSearchConsoleHandlers, SYNC_JOB_TYPE } from './handlers.js';

const ENV = {
  GSC_WIF_AUDIENCE: '//iam.googleapis.com/projects/000000000001/locations/global/workloadIdentityPools/hcw-azure/providers/entra',
  GSC_ENTRA_APP_ID_URI: 'api://00000000-0000-0000-0000-000000000001',
  GSC_SERVICE_ACCOUNT_EMAIL: 'sa-hcw-search-console@example-project.iam.gserviceaccount.com',
};
const NOW = new Date('2026-11-09T12:00:00Z');
const USER = { oid: '00000000-0000-0000-0000-000000000002', email: 'owner@example.com' };

const allow = { requireRole: vi.fn(async () => ({ user: USER })) };
const refuse = {
  requireRole: vi.fn(async () => ({ error: { status: 403, headers: {}, body: '{"ok":false,"error":"Forbidden"}' } })),
};

function setup({ env = ENV, stored = null, lease = null, jobs = [], guard = allow } = {}) {
  const store = {
    readDoc: vi.fn(async (_container, id) => (id === 'search_console_lease' ? lease : stored)),
    upsertDoc: vi.fn(async (_c, doc) => doc),
    queryDocs: vi.fn(async () => jobs),
  };
  const handlers = createSearchConsoleHandlers({ guard, store, env, now: () => NOW, uuid: () => 'job-1' });
  const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), invocationId: 'inv-1' };
  return { handlers, store, context };
}

const body = (response) => JSON.parse(response.body);

describe('GET cms/search-console', () => {
  it('needs editor', async () => {
    const { handlers, store, context } = setup({ guard: refuse });
    const response = await handlers.get({}, context);
    expect(response.status).toBe(403);
    expect(refuse.requireRole).toHaveBeenCalledWith({}, 'editor');
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('says not_configured, names the empty settings and never a value', async () => {
    const { handlers, context } = setup({ env: { GSC_WIF_AUDIENCE: ENV.GSC_WIF_AUDIENCE } });
    const answer = body(await handlers.get({}, context));
    expect(answer.status).toBe('not_configured');
    expect(answer.missing).toEqual(['GSC_ENTRA_APP_ID_URI', 'GSC_SERVICE_ACCOUNT_EMAIL']);
    expect(JSON.stringify(answer)).not.toContain(ENV.GSC_WIF_AUDIENCE);
    expect(answer.notAvailable).toEqual(['Page indexing totals and reasons', 'Links (internal and external)']);
    expect(answer.siteUrl).toBe('sc-domain:hybridcloudworks.com');
  });

  it('says never_run, in the full shape, before the first run', async () => {
    const { handlers, context } = setup();
    const response = await handlers.get({}, context);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    const answer = body(response);
    expect(answer).toMatchObject({ status: 'never_run', generatedAt: null, run: null, sitemaps: [] });
    expect(answer.indexing).toEqual({
      summary: { pass: 0, neutral: 0, fail: 0, unknown: 0, byCoverageState: [], byPageFetchState: [] },
      pages: [],
      strays: [],
      history: [],
    });
    expect(Object.keys(answer.performance).sort()).toEqual(
      ['countries', 'daily', 'devices', 'pages', 'queries', 'range', 'searchAppearance', 'totals', 'totals28d'].sort()
    );
  });

  it('answers the stored snapshot without Cosmos\'s own fields', async () => {
    const stored = {
      id: 'search_console_snapshot',
      configScope: 'admin_config',
      docType: 'search_console_snapshot',
      _etag: 'e1',
      _ts: 1,
      status: 'ok',
      siteUrl: 'sc-domain:hybridcloudworks.com',
      generatedAt: '2026-11-09T00:10:00.000Z',
      run: { inspected: 203, failed: 0 },
      indexing: { summary: { pass: 200 }, pages: [], strays: [], history: [] },
      performance: { totals: { clicks: 1 } },
      sitemaps: [],
    };
    const answer = body(await setup({ stored }).handlers.get({}, {}));
    expect(answer.status).toBe('ok');
    expect(answer.run.inspected).toBe(203);
    for (const key of ['_etag', '_ts', 'id', 'configScope', 'docType']) expect(answer).not.toHaveProperty(key);
  });

  it('says error when the last run failed', async () => {
    const answer = body(await setup({ stored: { status: 'error', run: { message: 'hop 2' } } }).handlers.get({}, {}));
    expect(answer.status).toBe('error');
    expect(answer.run.message).toBe('hop 2');
  });

  it('answers a failed read with a fixed sentence, not the error\'s text', async () => {
    const { handlers, store, context } = setup();
    store.readDoc.mockRejectedValueOnce(new Error('cosmos said something private'));
    const response = await handlers.get({}, context);
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('private');
  });
});

describe('POST cms/search-console/run', () => {
  it('needs editor and queues nothing on refusal', async () => {
    const { handlers, store, context } = setup({ guard: refuse });
    const enqueue = vi.fn();
    expect((await handlers.run({}, context, { enqueue })).status).toBe(403);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is 409 not_configured while a setting is empty', async () => {
    const { handlers, store, context } = setup({ env: {} });
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(409);
    expect(body(response)).toMatchObject({ error: 'not_configured' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('writes the job and sends its message, 202 queued', async () => {
    const { handlers, store, context } = setup();
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(202);
    expect(body(response)).toMatchObject({ queued: true, jobId: 'job-1' });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'jobs',
      expect.objectContaining({ id: 'job-1', type: SYNC_JOB_TYPE, status: 'queued', payload: {}, requestedBy: USER })
    );
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: SYNC_JOB_TYPE });
  });

  it('answers with the run already queued instead of a second job', async () => {
    const { handlers, store, context } = setup({
      jobs: [
        { id: 'old', status: 'queued', createdAt: '2026-11-08T00:00:00Z' },
        { id: 'live', status: 'running', createdAt: '2026-11-09T11:55:00Z' },
      ],
    });
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(202);
    expect(body(response)).toMatchObject({ queued: true, alreadyQueued: true, jobId: 'live' });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 202 alreadyRunning, with the job\'s id, while a run holds the lease', async () => {
    const lease = { holder: 'run-a', by: 'job', jobId: 'job-9', expiresAt: '2026-11-09T12:20:00Z' };
    const { handlers, store, context } = setup({ lease });
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(202);
    expect(body(response)).toEqual({ ok: true, queued: true, alreadyRunning: true, status: 'running', jobId: 'job-9' });
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'search_console_lease', 'admin_config');
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers alreadyRunning without a job id while the timer holds the lease', async () => {
    const lease = { holder: 'run-a', by: 'timer', jobId: null, expiresAt: '2026-11-09T12:20:00Z' };
    const answer = body(await setup({ lease }).handlers.run({}, {}, { enqueue: vi.fn() }));
    expect(answer).toEqual({ ok: true, queued: true, alreadyRunning: true, status: 'running' });
  });

  it('queues a run when the lease has lapsed', async () => {
    const lease = { holder: 'dead-run', expiresAt: '2026-11-09T11:00:00Z', budget: { day: '2026-11-09', used: 10 } };
    const enqueue = vi.fn();
    const response = await setup({ lease }).handlers.run({}, {}, { enqueue });
    expect(body(response)).toMatchObject({ queued: true, jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('is 429 daily_budget_spent, saying when it starts again, once today\'s budget is used', async () => {
    const lease = { holder: null, budget: { day: '2026-11-09', used: 1800 } };
    const { handlers, store, context } = setup({ lease });
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(429);
    expect(body(response)).toEqual({
      ok: false,
      error: 'daily_budget_spent',
      message: "Today's allowance of 1,800 Google page inspections is used up. It starts again at midnight Pacific time (2026-11-10 08:00 UTC).",
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('counts yesterday\'s inspections as spent no longer', async () => {
    const lease = { holder: null, budget: { day: '2026-11-08', used: 1800 } };
    const response = await setup({ lease }).handlers.run({}, {}, { enqueue: vi.fn() });
    expect(response.status).toBe(202);
  });

  it('keeps to a budget set in the app setting', async () => {
    const lease = { holder: null, budget: { day: '2026-11-09', used: 5 } };
    const response = await setup({ lease, env: { ...ENV, GSC_DAILY_INSPECTION_BUDGET: '5' } }).handlers.run({}, {}, { enqueue: vi.fn() });
    expect(response.status).toBe(429);
    expect(body(response).message).toContain('allowance of 5 Google');
  });

  it('answers a failed queue write with a fixed sentence', async () => {
    const { handlers, store, context } = setup();
    store.upsertDoc.mockRejectedValueOnce(new Error('cosmos said something private'));
    const response = await handlers.run({}, context, { enqueue: vi.fn() });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('private');
  });

  it('names the job with a fresh id and the real clock by default', async () => {
    const store = { readDoc: vi.fn(async () => null), upsertDoc: vi.fn(async (_c, doc) => doc), queryDocs: vi.fn(async () => []) };
    const handlers = createSearchConsoleHandlers({ guard: allow, store, env: ENV });
    const enqueue = vi.fn();
    const answer = body(await handlers.run({}, {}, { enqueue }));
    expect(answer.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(store.upsertDoc.mock.calls[0][1].createdAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('is 500 when no queue output is wired', async () => {
    const { handlers, context } = setup();
    expect((await handlers.run({}, context, {})).status).toBe(500);
  });
});
