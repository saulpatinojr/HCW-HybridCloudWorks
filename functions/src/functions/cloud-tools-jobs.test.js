import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const timers = new Map();
vi.mock('@azure/functions', () => ({
  app: {
    timer: (name, options) => timers.set(name, options),
    http: () => {},
    storageQueue: () => {},
    cosmosDB: () => {},
  },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));

// The module store is never reached by these tests — the timer's enqueue is
// exercised through enqueueRefreshJob with a fake — but the module imports
// it, and cosmos-client.js builds a client from app settings at first use,
// not at import, so no mock is needed.
const { refreshEnabled, enqueueRefreshJob, TIMER_NAME, TIMER_FLAG } =
  await import('./cloud-tools-jobs.js');
const { getJobType, JOBS_CONTAINER } = await import('../lib/jobs.js');
const { REFRESH_JOB_TYPE } = await import('../lib/cloud-tools/refresh.js');

const saved = {};
beforeEach(() => {
  saved.master = process.env.FEATURE_FLAG_SCHEDULERS;
  saved.flag = process.env[`FEATURE_FLAG_${TIMER_FLAG}`];
  delete process.env.FEATURE_FLAG_SCHEDULERS;
  delete process.env[`FEATURE_FLAG_${TIMER_FLAG}`];
});
afterEach(() => {
  for (const [key, value] of [
    ['FEATURE_FLAG_SCHEDULERS', saved.master],
    [`FEATURE_FLAG_${TIMER_FLAG}`, saved.flag],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('refreshToolServiceCache registration', () => {
  it('is a daily 02:00 UTC timer with the platform-jobs queue as its output', () => {
    const timer = timers.get(TIMER_NAME);
    expect(TIMER_NAME).toBe('refreshToolServiceCache');
    expect(timer).toBeDefined();
    expect(timer.schedule).toBe('0 0 2 * * *');
    expect(timer.extraOutputs).toEqual([
      { type: 'queue', queueName: 'platform-jobs', connection: 'AzureWebJobsStorage' },
    ]);
  });

  it('is gated exactly like every other timer: its own flag "true", master not "false"', () => {
    expect(TIMER_FLAG).toBe('REFRESH_TOOL_SERVICE_CACHE');
    expect(refreshEnabled({})).toBe(false);
    expect(refreshEnabled({ FEATURE_FLAG_REFRESH_TOOL_SERVICE_CACHE: '1' })).toBe(false);
    expect(refreshEnabled({ FEATURE_FLAG_REFRESH_TOOL_SERVICE_CACHE: 'true' })).toBe(true);
    expect(
      refreshEnabled({
        FEATURE_FLAG_REFRESH_TOOL_SERVICE_CACHE: 'true',
        FEATURE_FLAG_SCHEDULERS: 'false',
      })
    ).toBe(false);
  });

  it('a disabled timer logs the skip and enqueues nothing', async () => {
    const context = { log: vi.fn(), warn: vi.fn(), extraOutputs: { set: vi.fn() } };
    await timers.get(TIMER_NAME).handler({}, context);
    // First skip in the process is the Warning that reaches Log Analytics.
    const logged = [...context.warn.mock.calls, ...context.log.mock.calls].map(([m]) => m);
    expect(logged.some((m) => m.startsWith(`[${TIMER_NAME}] disabled — skipping`))).toBe(true);
    expect(context.extraOutputs.set).not.toHaveBeenCalled();
  });

  it('writes a queued job document in the enqueueJob shape and returns the queue message', async () => {
    const store = { upsertDoc: vi.fn(async (_c, doc) => doc) };
    const now = () => new Date('2026-09-15T02:00:00Z');
    const message = await enqueueRefreshJob({ store, now, uuid: () => 'job-1' });

    expect(message).toEqual({ jobId: 'job-1', type: 'refresh-tool-pricing' });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe(JOBS_CONTAINER);
    // The worker's claim, the sweeper and getJob all read these fields.
    expect(doc).toMatchObject({
      id: 'job-1',
      type: 'refresh-tool-pricing',
      payload: {},
      status: 'queued',
      createdAt: '2026-09-15T02:00:00.000Z',
      attempts: 0,
      requestedBy: { oid: null, email: null },
    });
  });
});

describe('refresh-tool-pricing job type', () => {
  it('is registered editor, small payload, ten-minute budget, with the failure hook', () => {
    const spec = getJobType(REFRESH_JOB_TYPE);
    expect(spec).not.toBeNull();
    expect(spec.role).toBe('editor');
    expect(spec.maxPayloadBytes).toBe(512);
    expect(spec.timeoutMs).toBe(10 * 60 * 1000);
    expect(spec.timeoutMs).toBeLessThan(30 * 60 * 1000);
    expect(typeof spec.onComplete).toBe('function');
  });

  it('refuses an unknown region before touching a provider or Cosmos', async () => {
    const spec = getJobType(REFRESH_JOB_TYPE);
    await expect(
      spec.worker({ regions: ['eastus'] }, { context: { log: vi.fn(), error: vi.fn() } })
    ).rejects.toThrow(/unknown region/);
  });

  it('throws when the signal is pre-aborted', async () => {
    const spec = getJobType(REFRESH_JOB_TYPE);
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(
      spec.worker({}, { context: { log: vi.fn(), error: vi.fn() }, signal: controller.signal })
    ).rejects.toThrow('timeout');
  });
});

