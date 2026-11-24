/**
 * The 15-minute Second Brain timer queues work only when there is some
 * (#1772): a rebuild to start, once a day, or an unfinished one to resume.
 * When the last rebuild is recent it queues nothing, so the worker does not
 * run. The rule itself is tested in ../lib/brain/indexing.test.js; this file
 * holds the timer to it, with the Functions host stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoryStore } from '../../test/brain-store.js';

const registrations = vi.hoisted(() => ({ timers: new Map(), queues: new Map() }));
const memory = vi.hoisted(() => ({ store: null }));

vi.mock('@azure/functions', () => ({
  app: {
    http: () => {},
    timer: (name, options) => registrations.timers.set(name, options),
    storageQueue: (name, options) => registrations.queues.set(name, options),
  },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: (...args) => memory.store.readDoc(...args),
  queryDocs: (...args) => memory.store.queryDocs(...args),
  upsertDoc: (...args) => memory.store.upsertDoc(...args),
  createDoc: (...args) => memory.store.createDoc(...args),
  replaceDocIfMatch: (...args) => memory.store.replaceDocIfMatch(...args),
  getContainer: () => ({}),
}));

await import('./brain-http.js');

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MESSAGE = { ownerId: 'owner' };

function invocation() {
  const sent = [];
  return { sent, extraOutputs: { set: (_output, message) => sent.push(message) } };
}
const fireTimer = async () => {
  const context = invocation();
  await registrations.timers.get('brainIndexReconcile').handler({}, context);
  return context.sent;
};
const runWorker = async () => {
  const context = invocation();
  await registrations.queues.get('brainIndexWorker').handler(MESSAGE, context);
  return context.sent;
};
/** Follow the queue as the host would, until the worker stops queueing. */
async function drain(sent) {
  let runs = 0;
  for (let pending = sent.length; pending > 0; runs++) {
    if (runs > 50) throw new Error('the rebuild did not finish');
    pending += (await runWorker()).length - 1;
  }
  return runs;
}
const saved = () => memory.store.readDoc('brain_records', 'indexing', 'owner');

describe('brainIndexReconcile', () => {
  beforeEach(() => {
    memory.store = memoryStore().store;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('BRAIN_ENABLED', 'true');
    vi.stubEnv('BRAIN_OWNER_OID', 'owner');
    vi.stubEnv('BRAIN_OWNER_TENANT_ID', 'tenant');
    vi.stubEnv('FEATURE_FLAG_SCHEDULERS', 'true');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('still fires every 15 minutes', () => {
    expect(registrations.timers.get('brainIndexReconcile').schedule).toBe('0 */15 * * * *');
  });

  it('queues the first rebuild, then nothing until a day has passed', async () => {
    const first = await fireTimer();
    expect(first).toEqual([MESSAGE]);
    expect(await drain(first)).toBeGreaterThan(0);
    expect(await saved()).toMatchObject({ status: 'complete' });

    let workerRuns = 0;
    for (let i = 1; i < 96; i++) {
      vi.setSystemTime(NOW + i * 15 * MINUTE);
      const sent = await fireTimer();
      expect(sent).toEqual([]);
      workerRuns += await drain(sent);
    }
    expect(workerRuns).toBe(0);

    vi.setSystemTime(NOW + DAY);
    expect(await fireTimer()).toEqual([MESSAGE]);
    expect(await saved()).toMatchObject({ status: 'queued', sourceIndex: 0 });
  });

  it('queues a message to resume an unfinished rebuild', async () => {
    await fireTimer();
    await runWorker();
    const place = await saved();
    expect(place.status).toBe('queued');

    vi.setSystemTime(NOW + 15 * MINUTE);
    expect(await fireTimer()).toEqual([MESSAGE]);
    expect((await saved())._etag).toBe(place._etag);
  });

  it('does nothing when Second Brain or the schedulers are switched off', async () => {
    vi.stubEnv('FEATURE_FLAG_SCHEDULERS', 'false');
    expect(await fireTimer()).toEqual([]);
    vi.stubEnv('FEATURE_FLAG_SCHEDULERS', 'true');
    vi.stubEnv('BRAIN_ENABLED', 'false');
    expect(await fireTimer()).toEqual([]);
    expect(await saved()).toBeNull();
  });
});
