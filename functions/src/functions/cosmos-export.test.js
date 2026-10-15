import { describe, it, expect, vi } from 'vitest';

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

const { exportEnabled } = await import('./cosmos-export.js');
const { getJobType } = await import('../lib/jobs.js');
const { EXPORT_JOB_TYPE } = await import('../lib/backup/cosmos-export.js');

describe('cosmosExportScheduler registration', () => {
  it('is a daily 03:00 timer with the platform-jobs queue as its output', () => {
    const timer = timers.get('cosmosExportScheduler');
    expect(timer).toBeDefined();
    expect(timer.schedule).toBe('0 0 3 * * *');
    expect(timer.extraOutputs).toEqual([
      { type: 'queue', queueName: 'platform-jobs', connection: 'AzureWebJobsStorage' },
    ]);
  });

  it('is inert until FEATURE_FLAG_COSMOS_EXPORT is "1" (or "true"), and the master switch still wins', () => {
    expect(exportEnabled({})).toBe(false);
    expect(exportEnabled({ FEATURE_FLAG_COSMOS_EXPORT: '0' })).toBe(false);
    expect(exportEnabled({ FEATURE_FLAG_COSMOS_EXPORT: 'yes' })).toBe(false);
    expect(exportEnabled({ FEATURE_FLAG_COSMOS_EXPORT: '1' })).toBe(true);
    expect(exportEnabled({ FEATURE_FLAG_COSMOS_EXPORT: 'true' })).toBe(true);
    expect(
      exportEnabled({ FEATURE_FLAG_COSMOS_EXPORT: '1', FEATURE_FLAG_SCHEDULERS: 'false' })
    ).toBe(false);
  });

  it('a disabled timer logs and enqueues nothing', async () => {
    const saved = process.env.FEATURE_FLAG_COSMOS_EXPORT;
    delete process.env.FEATURE_FLAG_COSMOS_EXPORT;
    try {
      const context = { log: vi.fn(), extraOutputs: { set: vi.fn() } };
      await timers.get('cosmosExportScheduler').handler({}, context);
      expect(context.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
      expect(context.extraOutputs.set).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.FEATURE_FLAG_COSMOS_EXPORT = saved;
    }
  });
});

describe('cosmos-export-container job type', () => {
  it('is registered super_admin-only, small payload, under the 30-minute host limit, with the failure hook', () => {
    const spec = getJobType(EXPORT_JOB_TYPE);
    expect(spec).not.toBeNull();
    expect(spec.role).toBe('super_admin');
    expect(spec.maxPayloadBytes).toBe(1024);
    expect(spec.timeoutMs).toBeLessThan(30 * 60 * 1000);
    expect(typeof spec.onComplete).toBe('function');
  });

  it('refuses a payload outside the plan before touching Cosmos', async () => {
    const spec = getJobType(EXPORT_JOB_TYPE);
    await expect(
      spec.worker(
        { runId: '2026-09-14', mode: 'delta', container: 'audits' },
        { context: { log: vi.fn() } }
      )
    ).rejects.toThrow(/not exported on a delta run/);
  });

  it('throws when the signal is pre-aborted', async () => {
    const spec = getJobType(EXPORT_JOB_TYPE);
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(
      spec.worker(
        { runId: '2026-09-14', mode: 'full', container: 'content' },
        { context: { log: vi.fn() }, signal: controller.signal }
      )
    ).rejects.toThrow('timeout');
  });
});

