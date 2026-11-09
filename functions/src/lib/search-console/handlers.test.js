/**
 * handlers.js: GET cms/search-console and POST cms/search-console/run
 * (#1612), against a stubbed guard and store.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSearchConsoleHandlers, IN_FLIGHT_WINDOW_MS, lastActivity, PENDING_WRITE_GRACE_MS, SYNC_JOB_TYPE } from './handlers.js';

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

function setup({ env = ENV, stored = null, lease = null, jobs = [], jobDocs = {}, guard = allow } = {}) {
  // The lease document is kept in memory with an ETag, so the marker's
  // conditional writes are exercised.
  let leaseDoc = lease ? { ...lease, _etag: 'e0' } : null;
  let version = 0;
  const store = {
    readDoc: vi.fn(async (container, id) => {
      if (container === 'jobs') return jobDocs[id] ?? null;
      return id === 'search_console_lease' ? (leaseDoc ? structuredClone(leaseDoc) : null) : stored;
    }),
    upsertDoc: vi.fn(async (_c, doc) => doc),
    queryDocs: vi.fn(async () => jobs),
    createDoc: vi.fn(async (_c, doc) => {
      if (leaseDoc) throw Object.assign(new Error('conflict'), { code: 409 });
      version += 1;
      leaseDoc = { ...doc, _etag: `e${version}` };
      return leaseDoc;
    }),
    replaceDocIfMatch: vi.fn(async (_c, doc) => {
      if (!leaseDoc || doc._etag !== leaseDoc._etag) throw Object.assign(new Error('precondition'), { code: 412 });
      version += 1;
      leaseDoc = { ...doc, _etag: `e${version}` };
      return leaseDoc;
    }),
    get lease() {
      return leaseDoc;
    },
    /** Another press or a run writes the lease document between this press's read and its write. */
    setLease(next) {
      version += 1;
      leaseDoc = next ? { ...next, _etag: `e${version}` } : null;
    },
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
        { id: 'live', status: 'queued', createdAt: '2026-11-09T11:55:00Z' },
      ],
    });
    const enqueue = vi.fn();
    const response = await handlers.run({}, context, { enqueue });
    expect(response.status).toBe(202);
    expect(body(response)).toEqual({ ok: true, queued: true, alreadyQueued: true, jobId: 'live', status: 'queued' });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers alreadyRunning, with its id, for a sync job that has started but holds no lease yet', async () => {
    const { handlers } = setup({ jobs: [{ id: 'live', status: 'running', createdAt: '2026-11-09T11:55:00Z', startedAt: '2026-11-09T11:59:00Z' }] });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toEqual({ ok: true, queued: true, alreadyRunning: true, status: 'running', jobId: 'live' });
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
    const store = {
      readDoc: vi.fn(async () => null),
      upsertDoc: vi.fn(async (_c, doc) => doc),
      queryDocs: vi.fn(async () => []),
      createDoc: vi.fn(async (_c, doc) => doc),
      replaceDocIfMatch: vi.fn(async (_c, doc) => doc),
    };
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

describe('POST cms/search-console/run, two presses at once (Copilot review round 1, #1614)', () => {
  const marker = (jobId, claimedAt = '2026-11-09T11:59:30.000Z') => ({
    jobId,
    claimedAt,
    expiresAt: new Date(Date.parse(claimedAt) + 35 * 60 * 1000).toISOString(),
  });

  it('claims the queued-job marker on the lease document before it writes the job', async () => {
    const { handlers, store } = setup();
    const enqueue = vi.fn();
    expect((await handlers.run({}, {}, { enqueue })).status).toBe(202);
    expect(store.lease).toMatchObject({ id: 'search_console_lease', holder: null, pendingJob: marker('job-1', NOW.toISOString()) });
    expect(store.createDoc.mock.invocationCallOrder[0]).toBeLessThan(store.upsertDoc.mock.invocationCallOrder[0]);
  });

  it('queues exactly one job for two presses that pass the checks together', async () => {
    const { store, context } = setup();
    let next = 0;
    const handlers = createSearchConsoleHandlers({ guard: allow, store, env: ENV, now: () => NOW, uuid: () => `job-${(next += 1)}` });
    const enqueue = vi.fn();
    const answers = (await Promise.all([handlers.run({}, context, { enqueue }), handlers.run({}, context, { enqueue })])).map(body);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const winner = answers.find((answer) => !answer.alreadyQueued);
    const loser = answers.find((answer) => answer.alreadyQueued);
    expect(loser).toEqual({ ok: true, queued: true, alreadyQueued: true, jobId: winner.jobId, status: 'queued' });
  });

  it('answers with the winner\'s job when another press claims the marker between the read and the write', async () => {
    const lease = { holder: null, budget: { day: '2026-11-09', used: 3 } };
    const { handlers, store } = setup({ lease });
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      store.setLease({ ...lease, pendingJob: marker('job-0') });
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    const enqueue = vi.fn();
    const answer = body(await handlers.run({}, {}, { enqueue }));
    expect(answer).toEqual({ ok: true, queued: true, alreadyQueued: true, jobId: 'job-0', status: 'queued' });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers alreadyRunning when a run takes the lease between the read and the write', async () => {
    const { handlers, store } = setup({ lease: { holder: null } });
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      store.setLease({ holder: 'run-b', by: 'job', jobId: 'job-7', expiresAt: '2026-11-09T12:30:00Z' });
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    const answer = body(await handlers.run({}, {}, { enqueue: vi.fn() }));
    expect(answer).toEqual({ ok: true, queued: true, alreadyRunning: true, status: 'running', jobId: 'job-7' });
  });

  it('tries again when what changed the document left no job behind (a budget write)', async () => {
    const lease = { holder: null, budget: { day: '2026-11-09', used: 3 } };
    const { handlers, store } = setup({ lease });
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      store.setLease({ ...lease, budget: { day: '2026-11-09', used: 4 } });
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    const enqueue = vi.fn();
    expect(body(await handlers.run({}, {}, { enqueue }))).toMatchObject({ queued: true, jobId: 'job-1', status: 'queued' });
    expect(store.lease).toMatchObject({ budget: { used: 4 }, pendingJob: { jobId: 'job-1' } });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('is 409 busy after losing the write three times to something that left no job', async () => {
    const { handlers, store } = setup();
    store.createDoc.mockImplementation(async () => {
      throw Object.assign(new Error('conflict'), { code: 409 });
    });
    const response = await handlers.run({}, {}, { enqueue: vi.fn() });
    expect(response.status).toBe(409);
    expect(body(response)).toEqual({
      ok: false,
      error: 'busy',
      message: 'Another request changed the run state at the same moment. Press Run now again.',
    });
    expect(store.createDoc).toHaveBeenCalledTimes(3);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('answers a failed marker write with a fixed sentence', async () => {
    const { handlers, store, context } = setup();
    store.createDoc.mockRejectedValueOnce(new Error('cosmos said something private'));
    const response = await handlers.run({}, context, { enqueue: vi.fn() });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('private');
  });

  it.each([
    ['queued', 'queued'],
    ['running', 'running'],
  ])('answers with the marked job while it is %s', async (status) => {
    const { handlers, store } = setup({ lease: { holder: null, pendingJob: marker('job-0', '2026-11-09T11:40:00.000Z') }, jobDocs: { 'job-0': { id: 'job-0', status } } });
    const already = status === 'running' ? { alreadyRunning: true } : { alreadyQueued: true };
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toEqual({ ok: true, queued: true, ...already, jobId: 'job-0', status });
    expect(store.readDoc).toHaveBeenCalledWith('jobs', 'job-0', 'job-0');
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('queues a new job when the marked job has already finished', async () => {
    const { handlers, store } = setup({ lease: { holder: null, pendingJob: marker('job-0') }, jobDocs: { 'job-0': { id: 'job-0', status: 'done' } } });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ jobId: 'job-1', status: 'queued' });
    expect(store.lease.pendingJob.jobId).toBe('job-1');
  });

  it('treats a marker whose job was never written as waiting for two minutes, then not', async () => {
    const recent = setup({ lease: { holder: null, pendingJob: marker('job-0', '2026-11-09T11:58:30.000Z') } });
    expect(body(await recent.handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ alreadyQueued: true, jobId: 'job-0' });
    const old = setup({ lease: { holder: null, pendingJob: marker('job-0', '2026-11-09T11:57:59.000Z') } });
    expect(body(await old.handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ jobId: 'job-1', status: 'queued' });
    const unreadable = setup({ lease: { holder: null, pendingJob: { jobId: 'job-0', claimedAt: 'x', expiresAt: '2026-11-09T12:30:00Z' } } });
    expect(body(await unreadable.handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ jobId: 'job-1', status: 'queued' });
  });

  it('ignores a marker that has lapsed', async () => {
    const { handlers, store } = setup({ lease: { holder: null, pendingJob: marker('job-0', '2026-11-09T11:00:00.000Z') } });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ jobId: 'job-1', status: 'queued' });
    expect(store.readDoc).not.toHaveBeenCalledWith('jobs', 'job-0', 'job-0');
  });
});

describe('POST cms/search-console/run, a job that waited a long time (Copilot review round 3, #1614)', () => {
  // NOW is 12:00 UTC; the window is the job's 28 minutes plus 15.
  const longAgo = new Date(NOW.getTime() - IN_FLIGHT_WINDOW_MS - 60 * 1000).toISOString();
  const recently = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();

  it('sees a queued job the sweeper sent again, by its requeuedAt, though it was created long ago', async () => {
    const { handlers, store } = setup({ jobs: [{ id: 'requeued', status: 'queued', createdAt: longAgo, requeuedAt: recently }] });
    const enqueue = vi.fn();
    expect(body(await handlers.run({}, {}, { enqueue }))).toEqual({ ok: true, queued: true, alreadyQueued: true, jobId: 'requeued', status: 'queued' });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sees a job queued straight through enqueueJob, which claims no marker, by Cosmos\'s last-write time', async () => {
    const { handlers, store } = setup({ jobs: [{ id: 'direct', status: 'queued', createdAt: longAgo, _ts: Math.floor(Date.parse(recently) / 1000) }] });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ alreadyQueued: true, jobId: 'direct' });
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('asks the jobs container for every time it judges by', async () => {
    const { handlers, store } = setup();
    await handlers.run({}, {}, { enqueue: vi.fn() });
    const [container, sql, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe('jobs');
    for (const field of ['c.createdAt', 'c.startedAt', 'c.requeuedAt', 'c.updatedAt', 'c._ts']) expect(sql).toContain(field);
    expect(params).toEqual([{ name: '@type', value: SYNC_JOB_TYPE }]);
  });

  it('answers with the job most recently alive when several are', async () => {
    const { handlers } = setup({
      jobs: [
        { id: 'older', status: 'queued', createdAt: recently },
        { id: 'newer', status: 'running', createdAt: longAgo, startedAt: new Date(NOW.getTime() - 60 * 1000).toISOString() },
      ],
    });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ alreadyRunning: true, jobId: 'newer' });
  });

  it('queues a new job when the only one has shown no sign of life for the whole window', async () => {
    const { handlers } = setup({ jobs: [{ id: 'lost', status: 'queued', createdAt: longAgo, requeuedAt: longAgo }, { id: 'blank', status: 'queued' }] });
    expect(body(await handlers.run({}, {}, { enqueue: vi.fn() }))).toMatchObject({ jobId: 'job-1', status: 'queued' });
  });

  it('reads the latest of the job\'s times, ignoring missing and unreadable ones', () => {
    expect(lastActivity({ createdAt: '2026-11-09T10:00:00Z', startedAt: 'nonsense', requeuedAt: '2026-11-09T11:00:00Z', updatedAt: null })).toBe(Date.parse('2026-11-09T11:00:00Z'));
    expect(lastActivity({ createdAt: '2026-11-09T10:00:00Z', _ts: Date.parse('2026-11-09T11:30:00Z') / 1000 })).toBe(Date.parse('2026-11-09T11:30:00Z'));
    expect(lastActivity({})).toBeNaN();
    expect(lastActivity(null)).toBeNaN();
  });

  it('keeps the two-minute grace for a marker whose job is not written yet', () => {
    expect(PENDING_WRITE_GRACE_MS).toBe(2 * 60 * 1000);
  });
});
