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

// The module store, faked: the enabled handler is exercised end to end here,
// and cosmos-client.js would otherwise build a client from app settings on
// its first read.
const fakeStore = vi.hoisted(() => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, doc) => doc),
  queryDocs: vi.fn(async () => []),
}));
vi.mock('../lib/cosmos-client.js', () => fakeStore);

const { rollupEnabled, TIMER_NAME, TIMER_FLAG, TIMER_SCHEDULE } = await import('./labs-jobs.js');

const saved = {};
beforeEach(() => {
  saved.master = process.env.FEATURE_FLAG_SCHEDULERS;
  saved.flag = process.env[`FEATURE_FLAG_${TIMER_FLAG}`];
  delete process.env.FEATURE_FLAG_SCHEDULERS;
  delete process.env[`FEATURE_FLAG_${TIMER_FLAG}`];
  fakeStore.readDoc.mockClear();
  fakeStore.upsertDoc.mockClear();
  fakeStore.queryDocs.mockClear();
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

describe('labsWeeklyRollup registration', () => {
  it('is a daily 23:55 UTC timer with no output binding — it writes its own document', () => {
    const timer = timers.get(TIMER_NAME);
    expect(TIMER_NAME).toBe('labsWeeklyRollup');
    expect(timer).toBeDefined();
    expect(TIMER_SCHEDULE).toBe('0 55 23 * * *');
    expect(timer.schedule).toBe(TIMER_SCHEDULE);
    expect(timer.extraOutputs).toBeUndefined();
  });

  it('is gated exactly like every other timer: its own flag "true", master not "false"', () => {
    expect(TIMER_FLAG).toBe('LABS_WEEKLY_ROLLUP');
    expect(rollupEnabled({})).toBe(false);
    expect(rollupEnabled({ FEATURE_FLAG_LABS_WEEKLY_ROLLUP: '1' })).toBe(false);
    expect(rollupEnabled({ FEATURE_FLAG_LABS_WEEKLY_ROLLUP: 'true' })).toBe(true);
    expect(
      rollupEnabled({ FEATURE_FLAG_LABS_WEEKLY_ROLLUP: 'true', FEATURE_FLAG_SCHEDULERS: 'false' })
    ).toBe(false);
  });

  it('a disabled timer logs the skip and touches nothing', async () => {
    const context = { log: vi.fn(), warn: vi.fn() };
    await timers.get(TIMER_NAME).handler({}, context);
    const logged = [...context.warn.mock.calls, ...context.log.mock.calls].map(([m]) => m);
    expect(logged.some((m) => m.startsWith(`[${TIMER_NAME}] disabled — skipping`))).toBe(true);
    expect(fakeStore.readDoc).not.toHaveBeenCalled();
    expect(fakeStore.queryDocs).not.toHaveBeenCalled();
    expect(fakeStore.upsertDoc).not.toHaveBeenCalled();
  });

  it('an armed timer writes the day document and logs the summary', async () => {
    process.env.FEATURE_FLAG_LABS_WEEKLY_ROLLUP = 'true';
    const context = { log: vi.fn(), warn: vi.fn() };
    await timers.get(TIMER_NAME).handler({}, context);
    expect(fakeStore.readDoc).toHaveBeenCalledTimes(3);
    expect(fakeStore.queryDocs).toHaveBeenCalledTimes(1);
    expect(fakeStore.upsertDoc).toHaveBeenCalledTimes(1);
    const [container, doc] = fakeStore.upsertDoc.mock.calls[0];
    expect(container).toBe('tool_service_cache');
    expect(doc.id).toMatch(/^labs:day:\d{4}-\d{2}-\d{2}$/);
    expect(doc.ttl).toBe(60 * 24 * 60 * 60);
    const summary = context.log.mock.calls.map(([m]) => m).find((m) => m.startsWith(`[${TIMER_NAME}] {`));
    expect(summary).toBeDefined();
    const printed = JSON.parse(summary.slice(`[${TIMER_NAME}] `.length));
    expect(printed).toMatchObject({ jobs: 0, merged: false });
    // The summary is printed without the document's id (#1802).
    expect(printed).not.toHaveProperty('id');
  });
});
