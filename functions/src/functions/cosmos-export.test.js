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

const { exportEnabled, contentArchiveCheck, exportThenArchive } = await import('./cosmos-export.js');
const { ARCHIVE_JOB_TYPE } = await import('../lib/backup/archive-job.js');
await import('./content-archive-http.js');
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


describe('the yearly content archive’s daily check rides this timer (ADR 0046)', () => {
  const stores = () => ({
    store: { upsertDoc: vi.fn() },
    backupBlobs: { readJson: vi.fn(async () => null), putJson: vi.fn(), listNames: vi.fn(async () => []) },
    archiveBlobs: { containerExists: vi.fn(async () => true), readJson: vi.fn(async () => null), listDetails: vi.fn(async () => []) },
    notifier: { notifyTelegram: vi.fn() },
  });

  it('with the archive’s switch off it reads nothing, queues nothing and says it is off', async () => {
    const deps = stores();
    const enqueue = vi.fn();
    const result = await contentArchiveCheck({ log: vi.fn() }, enqueue, { ...deps, env: { FEATURE_FLAG_COSMOS_EXPORT: 'true' } });
    expect(result).toMatchObject({ action: 'off', blockers: ['switch-off'] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(deps.archiveBlobs.containerExists).not.toHaveBeenCalled();
    expect(deps.backupBlobs.readJson).not.toHaveBeenCalled();
  });

  it('a failure of the check is logged by its code and never thrown, so the export’s own run is not failed by it', async () => {
    const deps = stores();
    deps.backupBlobs.readJson = vi.fn(async () => {
      throw Object.assign(new Error('secret words from storage'), { code: 'ServerBusy' });
    });
    const error = vi.fn();
    const result = await contentArchiveCheck({ log: vi.fn(), error }, vi.fn(), {
      ...deps,
      env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' },
    });
    expect(result).toEqual({ action: 'failed' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret words');
  });

  it('hands the export’s messages to the queue before the archive’s check is called, and a check that never answers cannot lose them', async () => {
    const exported = [{ jobId: 'made-up-1', type: 'cosmos-export-container' }, { jobId: 'made-up-2', type: 'cosmos-export-container' }];
    const sets = [];
    const context = { log: vi.fn(), error: vi.fn(), extraOutputs: { set: (_output, messages) => sets.push([...messages]) } };
    let setsWhenCheckStarted = null;
    const never = new Promise(() => {});
    const deps = stores();
    // A storage read that never comes back: the check hangs, it does not throw.
    deps.archiveBlobs.containerExists = vi.fn(() => never);
    const started = Date.now();
    const result = await exportThenArchive(context, {
      scheduleExport: async (enqueue) => {
        exported.forEach((message) => enqueue(message));
        return { runId: '2027-02-08', mode: 'delta', enqueued: 2 };
      },
      archiveCheck: (ctx, enqueue) => {
        setsWhenCheckStarted = sets.length;
        return contentArchiveCheck(ctx, enqueue, { ...deps, env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, deadlineMs: 30 });
      },
    });
    // The export was on the queue output before the check began...
    expect(setsWhenCheckStarted).toBe(1);
    expect(sets[0]).toEqual(exported);
    // ...the timer stopped waiting at the deadline, said so, and nothing was taken back.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.archive).toEqual({ action: 'timed-out' });
    expect(sets).toEqual([exported]);
    expect(context.error).toHaveBeenCalledTimes(1);
    expect(context.error.mock.calls[0][0]).toContain('did not answer');
  });

  it('adds what the check queued to the export’s messages, and a check that throws leaves the export’s as they were', async () => {
    const sets = [];
    const context = { log: vi.fn(), error: vi.fn(), extraOutputs: { set: (_output, messages) => sets.push([...messages]) } };
    const scheduleExport = async (enqueue) => {
      enqueue({ jobId: 'made-up-1', type: 'cosmos-export-container' });
      return { enqueued: 1 };
    };
    await exportThenArchive(context, {
      scheduleExport,
      archiveCheck: async (_ctx, enqueue) => {
        enqueue({ jobId: 'made-up-9', type: ARCHIVE_JOB_TYPE });
        return { action: 'started', year: 2026, queued: 1 };
      },
    });
    expect(sets.at(-1)).toEqual([
      { jobId: 'made-up-1', type: 'cosmos-export-container' },
      { jobId: 'made-up-9', type: ARCHIVE_JOB_TYPE },
    ]);

    sets.length = 0;
    const deps = stores();
    deps.archiveBlobs.containerExists = vi.fn(async () => true);
    deps.backupBlobs.readJson = vi.fn(async () => {
      throw new Error('storage was away');
    });
    await exportThenArchive(context, {
      scheduleExport,
      archiveCheck: (ctx, enqueue) => contentArchiveCheck(ctx, enqueue, { ...deps, env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' } }),
    });
    expect(sets).toEqual([[{ jobId: 'made-up-1', type: 'cosmos-export-container' }]]);
  });

  it('with the nightly export off the timer returns before the archive is looked at', async () => {
    const saved = { export: process.env.FEATURE_FLAG_COSMOS_EXPORT, archive: process.env.CONTENT_ARCHIVE_ENABLED };
    delete process.env.FEATURE_FLAG_COSMOS_EXPORT;
    process.env.CONTENT_ARCHIVE_ENABLED = 'true';
    try {
      const context = { log: vi.fn(), error: vi.fn(), extraOutputs: { set: vi.fn() } };
      await timers.get('cosmosExportScheduler').handler({}, context);
      expect(context.log).toHaveBeenCalledTimes(1);
      expect(context.log.mock.calls[0][0]).toContain('disabled');
      expect(context.error).not.toHaveBeenCalled();
      expect(context.extraOutputs.set).not.toHaveBeenCalled();
    } finally {
      if (saved.export !== undefined) process.env.FEATURE_FLAG_COSMOS_EXPORT = saved.export;
      if (saved.archive === undefined) delete process.env.CONTENT_ARCHIVE_ENABLED;
      else process.env.CONTENT_ARCHIVE_ENABLED = saved.archive;
    }
  });
});

describe('content-archive-container job type', () => {
  it('is registered super_admin-only, small payload, under the 30-minute host limit, with the failure hook', () => {
    const spec = getJobType(ARCHIVE_JOB_TYPE);
    expect(spec).not.toBeNull();
    expect(spec.role).toBe('super_admin');
    expect(spec.maxPayloadBytes).toBe(1024);
    expect(spec.timeoutMs).toBeLessThan(30 * 60 * 1000);
    expect(typeof spec.onComplete).toBe('function');
  });

  it('refuses a container the archive does not write before touching storage', async () => {
    const spec = getJobType(ARCHIVE_JOB_TYPE);
    for (const container of ['admins', 'a_new_container', 'jobs']) {
      await expect(
        spec.worker({ year: 2026, runId: '2027-02-07', container }, { context: { log: vi.fn() } })
      ).rejects.toThrow(/not written by the content archive/);
    }
  });

  it('writes nothing while CONTENT_ARCHIVE_ENABLED is not "true"', async () => {
    const saved = process.env.CONTENT_ARCHIVE_ENABLED;
    delete process.env.CONTENT_ARCHIVE_ENABLED;
    try {
      const spec = getJobType(ARCHIVE_JOB_TYPE);
      // No storage is configured in this test, so reaching it would throw.
      expect(
        await spec.worker({ year: 2026, runId: '2027-02-07', container: 'blogs' }, { context: { log: vi.fn() } })
      ).toEqual({ container: 'blogs', written: false, skipped: 'switch-off' });
    } finally {
      if (saved !== undefined) process.env.CONTENT_ARCHIVE_ENABLED = saved;
    }
  });
});
