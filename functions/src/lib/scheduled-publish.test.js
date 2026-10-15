/**
 * The scheduled publisher.
 *
 * The load-bearing assertions are about what it *doesn't* do: publish an
 * instant-publish document, publish something already live, clear a schedule
 * it failed to publish, or keep republishing the same document every fifteen
 * minutes forever. The feature it implements was accepted by the server and
 * confirmed by the UI for the whole migration while doing nothing at all
 * (T-301), so the tests are written against the silence, not the
 * happy path.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildDueQuery,
  buildPublishFailureAlert,
  createScheduledPublisher,
  PUBLISH_ALERT_ID,
  PUBLISH_ALERT_TYPE,
} from './scheduled-publish.js';

const context = { log: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-06-01T12:00:00.000Z');

const makeStore = (due = []) => ({
  queryDocs: vi.fn(async () => due),
  patchDoc: vi.fn(async () => ({})),
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async () => ({})),
  // The day's digest, where every run is recorded (mergeDigest).
  createDoc: vi.fn(async (_container, doc) => doc),
  replaceDocIfMatch: vi.fn(async (_container, doc) => doc),
});

/** The publishingOps block the run wrote onto the day's digest. */
const recordedRun = (store) => {
  const [container, doc] = store.createDoc.mock.calls.at(-1);
  expect(container).toBe('workflow_digests');
  expect(doc.id).toBe('2026-06-01');
  return doc.publishingOps;
};

const makePublish = (impl = async () => ({ contentId: 'a', slug: 's' })) => ({
  processPublishContent: vi.fn(impl),
});

const run = (store, publish, opts = {}) =>
  createScheduledPublisher({ store, publish, now: () => NOW, ...opts }).runScheduledPublish(
    context
  );

describe('buildDueQuery', () => {
  const query = buildDueQuery(25);

  it('requires the schedule to be a string, excluding the instant-publish null', () => {
    // `saveContentSchedule` writes `scheduledPublishDate: null` for an instant
    // publish, on a document that is also `approved` and not `Live`. Without
    // this clause every such document matches on every tick.
    expect(query).toContain('IS_STRING(c.scheduledPublishDate)');
  });

  it('matches only approved, not-yet-live documents whose date has passed', () => {
    expect(query).toContain("c.contentStatus = 'approved'");
    expect(query).toContain('c.scheduledPublishDate <= @now');
    expect(query).toContain('(NOT IS_DEFINED(c.Live) OR c.Live = false)');
  });

  it('orders by the field the WHERE clause already guarantees is present', () => {
    // The codebase-wide rule is never to ORDER BY a possibly-missing field,
    // because Cosmos drops the documents that lack it. The exemption holds
    // only alongside the IS_STRING filter above.
    expect(query).toContain('ORDER BY c.scheduledPublishDate ASC');
    expect(query).toContain('IS_STRING(c.scheduledPublishDate)');
  });

  it('bounds the batch', () => {
    expect(buildDueQuery(25)).toContain('SELECT TOP 25 ');
    expect(buildDueQuery(5)).toContain('SELECT TOP 5 ');
  });
});

describe('runScheduledPublish', () => {
  it('publishes nothing and touches no content when nothing is due, and records the run', async () => {
    const store = makeStore([]);
    const publish = makePublish();
    const summary = await run(store, publish);

    expect(summary).toEqual({ due: 0, published: 0, skipped: 0, failed: 0, hasMore: false });
    expect(publish.processPublishContent).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    // An idle run is still a run: its time is the scheduler's heartbeat.
    expect(recordedRun(store)).toEqual({
      lastRunAt: '2026-06-01T12:00:00.000Z',
      due: 0,
      published: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
      status: 'success',
    });
  });

  it('records each run on the day’s digest as the publishingOps every reader expects (#1010)', async () => {
    // ops-health's lastSchedulerSuccessAt, the Telegram /digest and the Health
    // Hub all read digest.publishingOps; until #1010 nothing wrote it.
    const partly = makeStore([{ id: 'c1' }, { id: 'c2' }]);
    await run(
      partly,
      makePublish(async (id) => (id === 'c1' ? { error: 'nope' } : { contentId: id }))
    );
    expect(recordedRun(partly)).toMatchObject({ due: 2, published: 1, failed: 1, status: 'degraded' });

    const none = makeStore([{ id: 'c1' }]);
    await run(none, makePublish(async () => ({ error: 'nope' })));
    expect(recordedRun(none)).toMatchObject({ due: 1, published: 0, failed: 1, status: 'failed' });

    const raced = makeStore([{ id: 'c1' }]);
    await run(raced, makePublish(async () => ({ skipped: true })));
    expect(recordedRun(raced)).toMatchObject({ skipped: 1, status: 'success' });
  });

  it('records a run that broke as failed, then still fails the invocation', async () => {
    const store = makeStore([]);
    store.queryDocs.mockRejectedValue(new Error('query refused'));
    await expect(run(store, makePublish())).rejects.toThrow('query refused');
    // A sentence with the code and the log line's reference; the store's own
    // words stay out of the digest (#945).
    expect(recordedRun(store)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^The scheduled publish run failed \(Error; reference [\w.:-]+\)\.$/),
    });
    expect(JSON.stringify(recordedRun(store))).not.toContain('query refused');
  });

  it('does not fail a run whose record could not be written', async () => {
    const store = makeStore([{ id: 'c1' }]);
    store.createDoc.mockRejectedValue(new Error('cosmos down'));
    await expect(run(store, makePublish())).resolves.toMatchObject({ published: 1 });
    expect(context.error).toHaveBeenCalledWith(
      '[publishScheduledContent] could not record the run on the digest:',
      expect.any(Error)
    );
  });

  it('compares against an ISO instant in UTC', async () => {
    const store = makeStore([]);
    await run(store, makePublish());
    const [, , parameters] = store.queryDocs.mock.calls[0];
    expect(parameters).toEqual([{ name: '@now', value: '2026-06-01T12:00:00.000Z' }]);
  });

  it('publishes through processPublishContent, not its own implementation', async () => {
    const store = makeStore([{ id: 'c1' }]);
    const publish = makePublish();
    const summary = await run(store, publish);

    expect(publish.processPublishContent).toHaveBeenCalledTimes(1);
    expect(publish.processPublishContent.mock.calls[0][0]).toBe('c1');
    expect(publish.processPublishContent.mock.calls[0][1]).toMatchObject({ markLive: true });
    expect(summary.published).toBe(1);
  });

  it('clears the schedule after publishing, or the same document republishes forever', async () => {
    const store = makeStore([{ id: 'c1' }]);
    await run(store, makePublish());

    const [container, id, updates] = store.patchDoc.mock.calls[0];
    expect(container).toBe('content');
    expect(id).toBe('c1');
    expect(updates.scheduledPublishDate).toBeNull();
    // `null`, not `undefined` — patchDoc reads `undefined` as a field deletion
    // and reroutes to read-modify-write, and null matches what the write side
    // stores for an instant publish.
    expect(Object.hasOwn(updates, 'scheduledPublishDate')).toBe(true);
    expect(updates.scheduledPublishDate).not.toBeUndefined();
  });

  it('leaves the schedule set when the publish failed', async () => {
    // Clearing it would silently cancel the operator's schedule — the post
    // would never publish and nothing would show it had been dropped.
    const store = makeStore([{ id: 'c1' }]);
    const publish = makePublish(async () => ({ error: 'Cannot publish from status ingested' }));
    const summary = await run(store, publish);

    expect(summary.failed).toBe(1);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('leaves the schedule set when the publish lost a race', async () => {
    // `skipped` is the ETag precondition firing. The next tick retries, which
    // is the right outcome for a lost race.
    const store = makeStore([{ id: 'c1' }]);
    const publish = makePublish(async () => ({ skipped: true, reason: 'changed' }));
    const summary = await run(store, publish);

    expect(summary.skipped).toBe(1);
    expect(summary.published).toBe(0);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('keeps going after one document throws', async () => {
    const store = makeStore([{ id: 'c1' }, { id: 'c2' }]);
    const publish = makePublish(async (id) => {
      if (id === 'c1') throw new Error('boom');
      return { contentId: id };
    });
    const summary = await run(store, publish);

    expect(summary.failed).toBe(1);
    expect(summary.published).toBe(1);
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(store.patchDoc.mock.calls[0][1]).toBe('c2');
  });

  it('reports a full batch as having more, and does not chase them', async () => {
    // A tick that keeps going until the queue drains can overrun its own
    // fifteen-minute schedule during a backlog.
    const store = makeStore([{ id: 'a' }, { id: 'b' }]);
    const summary = await run(store, makePublish(), { batchSize: 2 });

    expect(summary.hasMore).toBe(true);
    expect(store.queryDocs).toHaveBeenCalledTimes(1);
  });

  it('records failures where the ops dashboard already looks', async () => {
    const store = makeStore([{ id: 'c1' }]);
    const publish = makePublish(async () => ({ error: 'nope' }));
    await run(store, publish);

    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('workflow_alerts');
    expect(doc.id).toBe(PUBLISH_ALERT_ID);
    // ops-health.js counts exactly this string; it was written during the
    // migration and had no producer until now.
    expect(doc.alertType).toBe(PUBLISH_ALERT_TYPE);
    expect(doc.failures).toEqual([{ contentId: 'c1', error: 'nope' }]);
  });

  it('writes no alert when every document published', async () => {
    const store = makeStore([{ id: 'c1' }]);
    await run(store, makePublish());
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('does not fail the run when the alert write fails', async () => {
    // The publishes that succeeded still happened; losing the alert must not
    // turn a partial run into a failed invocation.
    const store = makeStore([{ id: 'c1' }]);
    store.upsertDoc = vi.fn(async () => {
      throw new Error('cosmos down');
    });
    const publish = makePublish(async () => ({ error: 'nope' }));

    await expect(run(store, publish)).resolves.toMatchObject({ failed: 1 });
    expect(context.error).toHaveBeenCalled();
  });
});

describe('buildPublishFailureAlert', () => {
  const failures = [{ contentId: 'c1', error: 'nope' }];
  const nowIso = '2026-06-01T12:00:00.000Z';

  it('opens an alert with the fields ops-health reads', () => {
    const alert = buildPublishFailureAlert({ existing: null, failures, nowIso });
    expect(alert).toMatchObject({
      id: PUBLISH_ALERT_ID,
      alertType: PUBLISH_ALERT_TYPE,
      status: 'open',
      active: true,
      firstSeenAt: nowIso,
      failureCount: 1,
    });
  });

  it('keeps firstSeenAt while the incident stays open', () => {
    const existing = { status: 'open', active: true, firstSeenAt: '2026-05-01T00:00:00.000Z' };
    expect(buildPublishFailureAlert({ existing, failures, nowIso }).firstSeenAt).toBe(
      '2026-05-01T00:00:00.000Z'
    );
  });

  it('starts a new incident after an operator resolved the last one', () => {
    // Otherwise firstSeenAt measures the first outage ever rather than this
    // one, and the dashboard's age column becomes meaningless.
    const existing = { status: 'resolved', active: false, firstSeenAt: '2025-01-01T00:00:00.000Z' };
    expect(buildPublishFailureAlert({ existing, failures, nowIso }).firstSeenAt).toBe(nowIso);
  });

  it('never resolves an alert on its own', () => {
    // Resolution goes through ops-health.js, which requires a note.
    const existing = { status: 'open', active: true, firstSeenAt: nowIso };
    const alert = buildPublishFailureAlert({ existing, failures: [], nowIso });
    expect(alert.status).toBe('open');
    expect(alert.active).toBe(true);
  });

  it('bounds the embedded failure list', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ contentId: `c${i}`, error: 'nope' }));
    const alert = buildPublishFailureAlert({ existing: null, failures: many, nowIso });
    expect(alert.failures).toHaveLength(25);
    expect(alert.failureCount).toBe(60);
  });
});
