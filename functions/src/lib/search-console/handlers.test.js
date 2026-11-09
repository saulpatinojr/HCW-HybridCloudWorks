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

function setup({ env = ENV, stored = null, jobs = [], guard = allow } = {}) {
  const store = {
    readDoc: vi.fn(async () => stored),
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

  it('is 500 when no queue output is wired', async () => {
    const { handlers, context } = setup();
    expect((await handlers.run({}, context, {})).status).toBe(500);
  });
});
