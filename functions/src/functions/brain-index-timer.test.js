/**
 * The 15-minute Second Brain timer queues work only when there is some
 * (#1772): a rebuild to start, once a day, or an unfinished one to resume.
 * When the last rebuild is recent it queues nothing, so the worker does not
 * run. The rule itself is tested in ../lib/brain/indexing.test.js; this file
 * holds the timer to it, with the Functions host stubbed.
 *
 * It also holds the timer to its three switches (#1822): Second Brain itself
 * (BRAIN_ENABLED), the schedulers master switch (FEATURE_FLAG_SCHEDULERS) and
 * the timer's own flag (FEATURE_FLAG_BRAIN_INDEX_RECONCILE), which Terraform
 * writes from the `enabled_timers` list like every other timer's.
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
  const lines = [];
  return {
    sent,
    lines,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    extraOutputs: { set: (_output, message) => sent.push(message) },
  };
}
/** Fire the timer once and keep the whole context: what it queued and logged. */
const fire = async () => {
  const context = invocation();
  await registrations.timers.get('brainIndexReconcile').handler({}, context);
  return context;
};
const fireTimer = async () => (await fire()).sent;
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
    vi.stubEnv('FEATURE_FLAG_BRAIN_INDEX_RECONCILE', 'true');
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

describe('brainIndexReconcile: its own switch (#1822)', () => {
  beforeEach(() => {
    memory.store = memoryStore().store;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('BRAIN_ENABLED', 'true');
    vi.stubEnv('BRAIN_OWNER_OID', 'owner');
    vi.stubEnv('BRAIN_OWNER_TENANT_ID', 'tenant');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  /** Each test sets all three, so nothing leaks in from the machine running it. */
  const set = ({ master, flag }) => {
    for (const [name, value] of [
      ['FEATURE_FLAG_SCHEDULERS', master],
      ['FEATURE_FLAG_BRAIN_INDEX_RECONCILE', flag],
    ]) {
      // An undefined value removes the variable for the test (vitest's stubEnv).
      vi.stubEnv(name, value);
    }
  };

  it('armed: runs when its flag is "true", with the master switch on or not set at all', async () => {
    set({ master: 'true', flag: 'true' });
    expect(await fireTimer()).toEqual([MESSAGE]);

    memory.store = memoryStore().store;
    set({ master: undefined, flag: 'true' });
    expect(await fireTimer()).toEqual([MESSAGE]);
  });

  it('not armed: queues nothing and writes nothing unless the flag is exactly "true"', async () => {
    for (const flag of ['false', undefined, '', '1', 'TRUE']) {
      set({ master: 'true', flag });
      expect(await fireTimer(), `flag ${String(flag)}`).toEqual([]);
    }
    expect(await saved()).toBeNull();
  });

  it('not armed: says so in the log, so a timer left off is not silent', async () => {
    set({ master: 'true', flag: 'false' });
    const { lines } = await fire();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[brainIndexReconcile] disabled');
  });

  it('the master switch holds it off even when its own flag is "true"', async () => {
    set({ master: 'false', flag: 'true' });
    expect(await fireTimer()).toEqual([]);
    expect(await saved()).toBeNull();
  });

  it('Second Brain switched off holds it off, silently, even when both flags are on', async () => {
    set({ master: 'true', flag: 'true' });
    vi.stubEnv('BRAIN_ENABLED', 'false');
    const { sent, lines } = await fire();
    expect(sent).toEqual([]);
    expect(lines).toEqual([]);
    expect(await saved()).toBeNull();

    // ...and so does a missing owner, the other half of "Second Brain is on".
    vi.stubEnv('BRAIN_ENABLED', 'true');
    vi.stubEnv('BRAIN_OWNER_OID', '');
    expect(await fireTimer()).toEqual([]);
  });

  it('the flag is one the catalogue declares, so Terraform writes it and the owner can arm it', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (file) => readFileSync(new URL(`../../../infra/${file}`, import.meta.url), 'utf8');
    expect(read('functionapp.tf')).toMatch(/^\s*BRAIN_INDEX_RECONCILE\s*=\s*"brainIndexReconcile /m);
    expect(read('variables.tf')).toContain('"BRAIN_INDEX_RECONCILE"');
  });
});
