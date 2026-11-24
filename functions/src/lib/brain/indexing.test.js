/**
 * When a rebuild of the Second Brain search index starts (#1772).
 *
 * The timer fires every 15 minutes. It used to start a full rebuild on every
 * firing; now it resumes an unfinished rebuild and starts a new one only once
 * a day. These tests hold each branch of that rule, and the admin's button,
 * which still rebuilds at once.
 */
import { describe, it, expect } from 'vitest';
import { memoryStore } from '../../../test/brain-store.js';
import { createBrainRepository } from './repository.js';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  REBUILD_INTERVAL_MS,
  REBUILD_STALLED_MS,
  createBrainIndexer,
  rebuildDecision,
} from './indexing.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms) => new Date(ms).toISOString();

function setup(startMs = NOW) {
  const { store, batch } = memoryStore();
  const repo = createBrainRepository(store, 'owner', batch);
  const clock = { ms: startMs };
  const indexer = createBrainIndexer(repo, { now: () => clock.ms });
  /** Run the worker until the rebuild is finished. */
  const finish = async () => {
    for (let i = 0; i < 50; i++) if (!(await indexer.step())) return;
    throw new Error('the rebuild did not finish');
  };
  const saved = () => repo.read('indexing');
  return { store, repo, clock, indexer, finish, saved };
}

describe('rebuildDecision', () => {
  const complete = (ageMs) => ({ status: 'complete', completedAt: at(NOW - ageMs) });
  const unfinished = (status, ageMs) => ({ status, startedAt: at(NOW - ageMs) });

  it('keeps the interval and the stalled limit at one day', () => {
    expect(REBUILD_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(REBUILD_STALLED_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('starts when there is no saved record, for the timer and the button', () => {
    expect(rebuildDecision(null, NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision(undefined, NOW)).toBe('start');
  });

  it('makes the timer wait while the last rebuild is under a day old', () => {
    expect(rebuildDecision(complete(0), NOW, { scheduled: true })).toBe('wait');
    expect(rebuildDecision(complete(REBUILD_INTERVAL_MS - 1), NOW, { scheduled: true })).toBe('wait');
  });

  it('lets the timer start once the last rebuild is a day old', () => {
    expect(rebuildDecision(complete(REBUILD_INTERVAL_MS), NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision(complete(3 * REBUILD_INTERVAL_MS), NOW, { scheduled: true })).toBe('start');
  });

  it('never makes the button wait', () => {
    expect(rebuildDecision(complete(0), NOW)).toBe('start');
    expect(rebuildDecision(complete(0), NOW, { scheduled: false })).toBe('start');
  });

  it.each(['queued', 'running'])('resumes a %s rebuild instead of starting another', (status) => {
    expect(rebuildDecision(unfinished(status, 0), NOW, { scheduled: true })).toBe('resume');
    expect(rebuildDecision(unfinished(status, REBUILD_STALLED_MS - 1), NOW, { scheduled: true })).toBe('resume');
    expect(rebuildDecision(unfinished(status, 0), NOW)).toBe('resume');
  });

  it.each(['queued', 'running'])('starts again when a %s rebuild is a day old', (status) => {
    expect(rebuildDecision(unfinished(status, REBUILD_STALLED_MS), NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision(unfinished(status, REBUILD_STALLED_MS), NOW)).toBe('start');
  });

  it('starts when a saved time is missing or unreadable', () => {
    expect(rebuildDecision({ status: 'complete' }, NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision({ status: 'complete', completedAt: 'not-a-date' }, NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision({ status: 'running' }, NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision({ status: 'queued', startedAt: 12 }, NOW, { scheduled: true })).toBe('start');
  });

  it('trusts a time a little in the future and distrusts one far in the future', () => {
    const little = -CLOCK_SKEW_TOLERANCE_MS;
    const far = -CLOCK_SKEW_TOLERANCE_MS - 1;
    expect(rebuildDecision(complete(little), NOW, { scheduled: true })).toBe('wait');
    expect(rebuildDecision(complete(far), NOW, { scheduled: true })).toBe('start');
    expect(rebuildDecision(unfinished('running', little), NOW, { scheduled: true })).toBe('resume');
    expect(rebuildDecision(unfinished('running', far), NOW, { scheduled: true })).toBe('start');
  });

  it('starts when the saved status is not one it knows', () => {
    expect(rebuildDecision({ status: 'failed' }, NOW, { scheduled: true })).toBe('start');
  });
});

describe('the timer (reconcile)', () => {
  it('starts the first rebuild when nothing is saved yet', async () => {
    const { indexer, saved } = setup();
    const { action, job } = await indexer.reconcile();
    expect(action).toBe('start');
    expect(job).toMatchObject({ status: 'queued', sourceIndex: 0, count: 0, startedAt: at(NOW) });
    expect(await saved()).toMatchObject({ status: 'queued', ownerId: 'owner', type: 'indexing' });
  });

  it('rebuilds once, then waits a day, then rebuilds again', async () => {
    const { indexer, clock, finish, saved } = setup();
    expect((await indexer.reconcile()).action).toBe('start');
    await finish();
    expect(await saved()).toMatchObject({ status: 'complete', completedAt: at(NOW) });

    // Every 15-minute firing for the rest of the day changes nothing.
    const before = (await saved())._etag;
    for (let i = 1; i < 96; i++) {
      clock.ms = NOW + i * 15 * MINUTE;
      expect((await indexer.reconcile()).action).toBe('wait');
    }
    expect((await saved())._etag).toBe(before);
    expect(await indexer.step()).toBe(false);

    clock.ms = NOW + REBUILD_INTERVAL_MS;
    const { action, job } = await indexer.reconcile();
    expect(action).toBe('start');
    expect(job).toMatchObject({ status: 'queued', startedAt: at(clock.ms) });
    expect(job.completedAt).toBeUndefined();
  });

  it('resumes an unfinished rebuild from its saved place', async () => {
    const { indexer, clock, saved } = setup();
    await indexer.reconcile();
    expect(await indexer.step()).toBe(true);
    const place = await saved();
    expect(place).toMatchObject({ status: 'queued', sourceIndex: 1 });

    clock.ms = NOW + 15 * MINUTE;
    const { action, job } = await indexer.reconcile();
    expect(action).toBe('resume');
    expect(job._etag).toBe(place._etag);
    expect(await saved()).toMatchObject({ sourceIndex: 1, startedAt: at(NOW) });
  });

  it('retries a failed page on the next firing, not a day later', async () => {
    const { indexer, clock, store, saved } = setup();
    await indexer.reconcile();
    const query = store.queryDocs;
    store.queryDocs = async () => {
      throw Object.assign(new Error('unavailable'), { code: 503 });
    };
    await expect(indexer.step()).rejects.toMatchObject({ code: 503 });
    expect(await saved()).toMatchObject({ status: 'running', sourceIndex: 0 });

    store.queryDocs = query;
    clock.ms = NOW + 15 * MINUTE;
    expect((await indexer.reconcile()).action).toBe('resume');
    expect(await indexer.step()).toBe(true);
    expect(await saved()).toMatchObject({ status: 'queued', sourceIndex: 1 });
  });

  it('starts a stuck rebuild again from the beginning after a day', async () => {
    const { indexer, clock, repo, saved } = setup();
    // A saved place no rebuild can read: every worker run fails on it.
    await repo.putInternal({
      id: 'indexing',
      type: 'indexing',
      status: 'queued',
      sourceIndex: 99,
      after: '',
      count: 0,
      startedAt: at(NOW),
      updatedAt: at(NOW),
    });
    await expect(indexer.step()).rejects.toThrow();

    clock.ms = NOW + REBUILD_STALLED_MS - 1;
    expect((await indexer.reconcile()).action).toBe('resume');

    clock.ms = NOW + REBUILD_STALLED_MS;
    expect((await indexer.reconcile()).action).toBe('start');
    expect(await saved()).toMatchObject({ status: 'queued', sourceIndex: 0, startedAt: at(clock.ms) });
  });

  // In the two tests below both firings read the record before either
  // writes. The second firing's read is handed the old copy to make that
  // order certain; the test store does not run two writes at the same moment.
  it('lets only one of two overlapping firings start the rebuild', async () => {
    const { repo, store, saved } = setup();
    await repo.putInternal({
      id: 'indexing',
      type: 'indexing',
      status: 'complete',
      completedAt: at(NOW - REBUILD_INTERVAL_MS),
    });
    const stale = await saved();
    let writes = 0;
    const replace = store.replaceDocIfMatch;
    store.replaceDocIfMatch = async (...args) => {
      const result = await replace(...args);
      writes++;
      return result;
    };
    const first = await createBrainIndexer(repo, { now: () => NOW }).reconcile();
    let reads = 0;
    const late = { ...repo, read: async (id) => (reads++ < 1 ? stale : repo.read(id)) };
    const second = await createBrainIndexer(late, { now: () => NOW + 1000 }).reconcile();

    expect(first.action).toBe('start');
    expect(second.action).toBe('resume');
    expect(writes).toBe(1);
    expect(second.job._etag).toBe(first.job._etag);
    expect(await saved()).toMatchObject({ status: 'queued', sourceIndex: 0, startedAt: at(NOW) });
  });

  it('lets only one of two first-ever firings create the record', async () => {
    const { repo, saved } = setup();
    const first = await createBrainIndexer(repo, { now: () => NOW }).reconcile();
    let reads = 0;
    const late = { ...repo, read: async (id) => (reads++ < 1 ? null : repo.read(id)) };
    const second = await createBrainIndexer(late, { now: () => NOW + 1000 }).reconcile();

    expect(first.action).toBe('start');
    expect(second.action).toBe('resume');
    expect(second.job._etag).toBe(first.job._etag);
    expect(await saved()).toMatchObject({ status: 'queued', startedAt: at(NOW) });
  });

  it('waits when the record that won the race is already finished', async () => {
    const { repo, store } = setup();
    await repo.putInternal({
      id: 'indexing',
      type: 'indexing',
      status: 'complete',
      completedAt: at(NOW - REBUILD_INTERVAL_MS),
    });
    const stale = await repo.read('indexing');
    await repo.putInternal({ id: 'indexing', type: 'indexing', status: 'complete', completedAt: at(NOW) });
    let reads = 0;
    const racing = { ...repo, read: async (id) => (reads++ < 1 ? stale : repo.read(id)) };
    const { action, job } = await createBrainIndexer(racing, { now: () => NOW }).reconcile();
    expect(action).toBe('wait');
    expect(job.completedAt).toBe(at(NOW));
    expect(store.docs.size).toBe(1);
  });

  it('passes on a write failure that is not a lost race', async () => {
    const { indexer, store } = setup();
    store.createDoc = async () => {
      throw Object.assign(new Error('unavailable'), { code: 503 });
    };
    await expect(indexer.reconcile()).rejects.toMatchObject({ code: 503 });
  });
});

describe("the admin's button (start)", () => {
  it('rebuilds at once, even minutes after the last rebuild finished', async () => {
    const { indexer, clock, finish, saved } = setup();
    await indexer.reconcile();
    await finish();
    clock.ms = NOW + 5 * MINUTE;
    expect((await indexer.reconcile()).action).toBe('wait');

    const job = await indexer.start();
    expect(job).toMatchObject({ status: 'queued', sourceIndex: 0, startedAt: at(clock.ms) });
    expect(await saved()).toMatchObject({ status: 'queued' });
    // The timer then resumes that rebuild instead of waiting.
    expect((await indexer.reconcile()).action).toBe('resume');
  });

  it('returns the rebuild already under way instead of starting a second', async () => {
    const { indexer, saved } = setup();
    const first = await indexer.start();
    await indexer.step();
    const again = await indexer.start();
    expect(again.startedAt).toBe(first.startedAt);
    expect(again).toMatchObject({ sourceIndex: 1 });
    expect((await saved())._etag).toBe(again._etag);
  });

  it('returns what was saved when it loses a race', async () => {
    const { repo } = setup();
    await repo.putInternal({ id: 'indexing', type: 'indexing', status: 'complete', completedAt: at(NOW) });
    const stale = await repo.read('indexing');
    const winner = await repo.putInternal({
      id: 'indexing',
      type: 'indexing',
      status: 'queued',
      sourceIndex: 0,
      startedAt: at(NOW),
    });
    let reads = 0;
    const racing = { ...repo, read: async (id) => (reads++ < 1 ? stale : repo.read(id)) };
    const job = await createBrainIndexer(racing, { now: () => NOW }).start();
    expect(job._etag).toBe(winner._etag);
  });
});
