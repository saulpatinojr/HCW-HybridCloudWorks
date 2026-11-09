/**
 * lease.js: the run lease and the daily inspection budget (#1612 review),
 * against an in-memory store with ETags. Nothing here reaches Cosmos.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  budgetLeft,
  budgetSpentMessage,
  claimPendingJob,
  createRunLease,
  dailyBudget,
  DEFAULT_DAILY_BUDGET,
  LEASE_DOC_ID,
  LEASE_TTL_MS,
  leaseIsLive,
  nextPacificMidnight,
  pacificDay,
  pendingJobIsLive,
  usedToday,
} from './lease.js';

/** 2026-11-09 00:10 UTC is still 2026-11-08 in Pacific time (UTC-8). */
const NOW = new Date('2026-11-09T00:10:00Z');

const conflict = (code) => Object.assign(new Error('conflict'), { code });

function memoryStore(initial = null) {
  let doc = initial ? { ...initial, _etag: 'e0' } : null;
  let version = 0;
  const store = {
    readDoc: vi.fn(async (container, id, partitionKey) => {
      expect([container, id, partitionKey]).toEqual(['admin_config', LEASE_DOC_ID, 'admin_config']);
      return doc ? structuredClone(doc) : null;
    }),
    createDoc: vi.fn(async (_container, next) => {
      if (doc) throw conflict(409);
      version += 1;
      doc = { ...next, _etag: `e${version}` };
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (_container, next, options) => {
      expect(options).toEqual({ partitionKey: 'admin_config' });
      if (!doc || next._etag !== doc._etag) throw conflict(412);
      version += 1;
      doc = { ...next, _etag: `e${version}` };
      return doc;
    }),
    get doc() {
      return doc;
    },
  };
  return store;
}

const lease = (store, extra = {}) => createRunLease({ store, now: () => NOW, holder: 'run-a', ...extra });

describe('the Pacific quota day', () => {
  it('names the Pacific date, which can differ from the UTC one', () => {
    expect(pacificDay(NOW)).toBe('2026-11-08');
    expect(pacificDay(new Date('2026-11-09T08:00:00Z'))).toBe('2026-11-09');
    expect(pacificDay(new Date('2026-07-01T06:59:00Z'))).toBe('2026-06-30');
  });

  it('finds the next Pacific midnight in winter (08:00 UTC) and in summer (07:00 UTC)', () => {
    expect(nextPacificMidnight(NOW).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(nextPacificMidnight(new Date('2026-07-01T12:34:00Z')).toISOString()).toBe('2026-07-02T07:00:00.000Z');
    // At midnight exactly, the next one is a day away.
    expect(nextPacificMidnight(new Date('2026-11-09T08:00:00Z')).toISOString()).toBe('2026-11-10T08:00:00.000Z');
  });

  it('says when the budget starts again', () => {
    expect(budgetSpentMessage(NOW)).toBe(
      "Today's allowance of 1,800 Google page inspections is used up. It starts again at midnight Pacific time (2026-11-09 08:00 UTC)."
    );
    expect(budgetSpentMessage(NOW, 50)).toContain('allowance of 50 Google');
  });
});

describe('dailyBudget', () => {
  it('is 1,800 unless the setting is a whole number up to Google\'s 2,000', () => {
    expect(dailyBudget({})).toBe(DEFAULT_DAILY_BUDGET);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: ' 500 ' })).toBe(500);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: '0' })).toBe(0);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: '2000' })).toBe(2000);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: '2001' })).toBe(DEFAULT_DAILY_BUDGET);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: '-5' })).toBe(DEFAULT_DAILY_BUDGET);
    expect(dailyBudget({ GSC_DAILY_INSPECTION_BUDGET: 'lots' })).toBe(DEFAULT_DAILY_BUDGET);
    expect(dailyBudget(undefined)).toBe(DEFAULT_DAILY_BUDGET);
  });
});

describe('reading a stored lease', () => {
  it('is live only while held and not past its expiry', () => {
    expect(leaseIsLive(null, NOW)).toBe(false);
    expect(leaseIsLive({ holder: null, expiresAt: '2026-11-09T01:00:00Z' }, NOW)).toBe(false);
    expect(leaseIsLive({ holder: 'x', expiresAt: 'not a date' }, NOW)).toBe(false);
    expect(leaseIsLive({ holder: 'x', expiresAt: '2026-11-09T00:10:00Z' }, NOW)).toBe(false);
    expect(leaseIsLive({ holder: 'x', expiresAt: '2026-11-09T00:11:00Z' }, NOW)).toBe(true);
  });

  it('counts only today\'s inspections', () => {
    expect(usedToday(null, NOW)).toBe(0);
    expect(usedToday({ budget: { day: '2026-11-07', used: 900 } }, NOW)).toBe(0);
    expect(usedToday({ budget: { day: '2026-11-08', used: 900 } }, NOW)).toBe(900);
    expect(usedToday({ budget: { day: '2026-11-08', used: 'x' } }, NOW)).toBe(0);
    expect(budgetLeft({ budget: { day: '2026-11-08', used: 1700 } }, NOW)).toBe(100);
    expect(budgetLeft({ budget: { day: '2026-11-08', used: 2500 } }, NOW)).toBe(0);
  });
});

describe('createRunLease', () => {
  it('creates the lease when there is none, with a 35-minute expiry and a fresh day', async () => {
    const store = memoryStore();
    await expect(lease(store, { by: 'job', jobId: 'job-1' }).acquire()).resolves.toEqual({ ok: true });
    expect(store.doc).toMatchObject({
      id: LEASE_DOC_ID,
      configScope: 'admin_config',
      docType: 'search_console_lease',
      holder: 'run-a',
      by: 'job',
      jobId: 'job-1',
      takenAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + LEASE_TTL_MS).toISOString(),
      budget: { day: '2026-11-08', used: 0 },
    });
  });

  it('refuses while another run holds it, and writes nothing', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:30:00Z' });
    await expect(lease(store).acquire()).resolves.toEqual({ ok: false });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('takes over a lapsed lease and keeps its count for the day', async () => {
    const store = memoryStore({
      id: LEASE_DOC_ID,
      holder: 'run-b',
      expiresAt: '2026-11-08T23:00:00Z',
      budget: { day: '2026-11-08', used: 400 },
    });
    await expect(lease(store).acquire()).resolves.toEqual({ ok: true });
    expect(store.doc).toMatchObject({ holder: 'run-a', budget: { day: '2026-11-08', used: 400 } });
  });

  it('loses a race to create it and then sees the winner holding it', async () => {
    const store = memoryStore();
    store.createDoc.mockImplementationOnce(async () => {
      // The other run's create lands first.
      store.replaceDocIfMatch.mockClear();
      await store.createDoc.getMockImplementation()('admin_config', {
        id: LEASE_DOC_ID,
        holder: 'run-b',
        expiresAt: '2026-11-09T00:40:00Z',
      });
      throw conflict(409);
    });
    await expect(lease(store).acquire()).resolves.toEqual({ ok: false });
    expect(store.doc.holder).toBe('run-b');
  });

  it('gives up after three lost races', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null });
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw conflict(412);
    });
    await expect(lease(store).acquire()).resolves.toEqual({ ok: false });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3);
  });

  it('passes on a store failure that is not a lost race', async () => {
    const store = memoryStore();
    store.createDoc.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 503 }));
    await expect(lease(store).acquire()).rejects.toThrow('down');
  });

  it('reserves what fits in today\'s budget and counts it', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, budget: { day: '2026-11-08', used: 1700 } });
    const held = lease(store);
    await held.acquire();
    await expect(held.reserve(203)).resolves.toBe(100);
    expect(store.doc.budget).toEqual({ day: '2026-11-08', used: 1800 });
    expect(store.doc.holder).toBe('run-a');
    // Nothing left: no write at all.
    const writes = store.replaceDocIfMatch.mock.calls.length;
    await expect(held.reserve(5)).resolves.toBe(0);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(writes);
  });

  it('starts the count again on a new Pacific day', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, budget: { day: '2026-11-07', used: 1800 } });
    const held = lease(store);
    await held.acquire();
    await expect(held.reserve(203)).resolves.toBe(203);
    expect(store.doc.budget).toEqual({ day: '2026-11-08', used: 203 });
  });

  it('reserves nothing once another run has taken the lease over', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z' });
    await expect(lease(store).reserve(10)).resolves.toBe(0);
    const empty = memoryStore();
    await expect(lease(empty).reserve(10)).resolves.toBe(0);
  });

  it('re-reads after a lost race while reserving, gives up after three, and passes on other failures', async () => {
    const store = memoryStore();
    const held = lease(store);
    await held.acquire();
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw conflict(412);
    });
    await expect(held.reserve(10)).resolves.toBe(10);
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw conflict(412);
    });
    await expect(held.reserve(10)).resolves.toBe(0);
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw Object.assign(new Error('down'), { statusCode: 503 });
    });
    await expect(held.reserve(10)).rejects.toThrow('down');
    store.replaceDocIfMatch.mockImplementation(real);
  });

  it('gives the lease back and hands back unused inspections on the same day', async () => {
    const store = memoryStore();
    const held = lease(store);
    await held.acquire();
    await held.reserve(200);
    await held.release({ unused: 150 });
    expect(store.doc).toMatchObject({ holder: null, jobId: null, expiresAt: null, releasedAt: NOW.toISOString(), budget: { day: '2026-11-08', used: 50 } });
    expect(leaseIsLive(store.doc, NOW)).toBe(false);
  });

  it('hands nothing back when the day has turned since the reservation', async () => {
    let now = NOW;
    const store = memoryStore();
    const held = createRunLease({ store, now: () => now, holder: 'run-a' });
    await held.acquire();
    await held.reserve(200);
    now = new Date('2026-11-09T08:30:00Z');
    store.doc.budget = { day: '2026-11-09', used: 10 };
    await held.release({ unused: 150 });
    expect(store.doc.budget).toEqual({ day: '2026-11-09', used: 10 });
  });

  it('leaves alone a lease another run has taken over, and one that is gone', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z' });
    await lease(store).release({ unused: 5 });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    const empty = memoryStore();
    await expect(lease(empty).release()).resolves.toBeUndefined();
  });

  it('re-reads after a lost race while releasing, and passes on other failures', async () => {
    const store = memoryStore();
    const held = lease(store);
    await held.acquire();
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw conflict(412);
    });
    await held.release();
    expect(store.doc.holder).toBeNull();

    await held.acquire();
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw conflict(412);
    });
    await expect(held.release()).resolves.toBeUndefined();
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw new Error('refused after the job ran out of time');
    });
    await expect(held.release()).rejects.toThrow('refused');
    store.replaceDocIfMatch.mockImplementation(real);
  });

  it('gives each run its own random holder id, and reads the real clock, by default', async () => {
    const store = memoryStore();
    const first = createRunLease({ store });
    expect(first.holder).not.toBe(createRunLease({ store }).holder);
    await expect(first.acquire()).resolves.toEqual({ ok: true });
    expect(leaseIsLive(store.doc, new Date())).toBe(true);
  });
});

describe('the queued-job marker (Copilot review round 1, #1614)', () => {
  const LIVE = { jobId: 'job-1', claimedAt: '2026-11-09T00:09:00.000Z', expiresAt: '2026-11-09T00:44:00.000Z' };

  it('is live only while it names a job and has not lapsed', () => {
    expect(pendingJobIsLive(null, NOW)).toBe(false);
    expect(pendingJobIsLive({ pendingJob: null }, NOW)).toBe(false);
    expect(pendingJobIsLive({ pendingJob: { jobId: '', expiresAt: LIVE.expiresAt } }, NOW)).toBe(false);
    expect(pendingJobIsLive({ pendingJob: { jobId: 'job-1', expiresAt: 'not a date' } }, NOW)).toBe(false);
    expect(pendingJobIsLive({ pendingJob: { jobId: 'job-1', expiresAt: '2026-11-09T00:10:00Z' } }, NOW)).toBe(false);
    expect(pendingJobIsLive({ pendingJob: LIVE }, NOW)).toBe(true);
  });

  it('is claimed by creating the lease document when there is none, for 35 minutes', async () => {
    const store = memoryStore();
    await expect(claimPendingJob(store, null, { jobId: 'job-1', now: NOW })).resolves.toEqual({ ok: true });
    expect(store.doc).toMatchObject({
      id: LEASE_DOC_ID,
      configScope: 'admin_config',
      docType: 'search_console_lease',
      holder: null,
      budget: null,
      pendingJob: { jobId: 'job-1', claimedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + LEASE_TTL_MS).toISOString() },
    });
  });

  it('is claimed on an existing document under its ETag, keeping the budget', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, budget: { day: '2026-11-08', used: 7 } });
    const current = await store.readDoc('admin_config', LEASE_DOC_ID, 'admin_config');
    await expect(claimPendingJob(store, current, { jobId: 'job-2', now: NOW })).resolves.toEqual({ ok: true });
    expect(store.doc).toMatchObject({ budget: { day: '2026-11-08', used: 7 }, pendingJob: { jobId: 'job-2' } });
  });

  it('loses to a press that wrote first (409 on create, 412 on replace), and passes on other failures', async () => {
    const store = memoryStore();
    await claimPendingJob(store, null, { jobId: 'job-1', now: NOW });
    // A second press read "no document" before the first wrote.
    await expect(claimPendingJob(store, null, { jobId: 'job-2', now: NOW })).resolves.toEqual({ ok: false });
    // A third press read the document before the first claimed it.
    await expect(claimPendingJob(store, { id: LEASE_DOC_ID, _etag: 'stale' }, { jobId: 'job-3', now: NOW })).resolves.toEqual({ ok: false });
    expect(store.doc.pendingJob.jobId).toBe('job-1');
    const failing = memoryStore();
    failing.createDoc.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 503 }));
    await expect(claimPendingJob(failing, null, { jobId: 'job-5', now: NOW })).rejects.toThrow('down');
  });

  it('is cleared by the job it names when that job takes the lease', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, pendingJob: LIVE });
    await expect(lease(store, { by: 'job', jobId: 'job-1' }).acquire()).resolves.toEqual({ ok: true });
    expect(store.doc).toMatchObject({ holder: 'run-a', jobId: 'job-1', pendingJob: null });
  });

  it('is kept when the timer or another job takes the lease, and through the budget and the release', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, pendingJob: LIVE });
    const held = lease(store);
    await held.acquire();
    expect(store.doc.pendingJob).toEqual(LIVE);
    await held.reserve(3);
    expect(store.doc.pendingJob).toEqual(LIVE);
    await held.release({ unused: 1 });
    expect(store.doc).toMatchObject({ holder: null, pendingJob: LIVE });
    await lease(store, { by: 'job', jobId: 'job-other' }).acquire();
    expect(store.doc.pendingJob).toEqual(LIVE);
  });

  it('is dropped when it has lapsed', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: null, pendingJob: { ...LIVE, expiresAt: '2026-11-09T00:00:00Z' } });
    await lease(store).acquire();
    expect(store.doc.pendingJob).toBeNull();
  });

  it('is cleared by its job when another run holds the lease, so Run now is not blocked until it lapses', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z', pendingJob: LIVE });
    await expect(lease(store, { by: 'job', jobId: 'job-1' }).acquire()).resolves.toEqual({ ok: false });
    expect(store.doc).toMatchObject({ holder: 'run-b', pendingJob: null });
    // A run whose job the marker does not name leaves it alone.
    const other = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z', pendingJob: LIVE });
    await expect(lease(other).acquire()).resolves.toEqual({ ok: false });
    expect(other.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('retries clearing its marker after a lost race, and passes on other failures', async () => {
    const store = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z', pendingJob: LIVE });
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw conflict(412);
    });
    await expect(lease(store, { jobId: 'job-1' }).acquire()).resolves.toEqual({ ok: false });
    expect(store.doc.pendingJob).toBeNull();
    const failing = memoryStore({ id: LEASE_DOC_ID, holder: 'run-b', expiresAt: '2026-11-09T00:40:00Z', pendingJob: LIVE });
    failing.replaceDocIfMatch.mockImplementation(async () => {
      throw new Error('down');
    });
    await expect(lease(failing, { jobId: 'job-1' }).acquire()).rejects.toThrow('down');
    store.replaceDocIfMatch.mockImplementation(real);
  });
});

describe('a run that reserves on two Pacific days', () => {
  it('hands nothing back, since what is unused cannot be told apart by day', async () => {
    let now = NOW;
    const store = memoryStore();
    const held = createRunLease({ store, now: () => now, holder: 'run-a' });
    await held.acquire();
    await held.reserve(200);
    now = new Date('2026-11-09T08:30:00Z');
    await held.reserve(1);
    expect(store.doc.budget).toEqual({ day: '2026-11-09', used: 1 });
    await held.release({ unused: 150 });
    expect(store.doc.budget).toEqual({ day: '2026-11-09', used: 1 });
  });
});
