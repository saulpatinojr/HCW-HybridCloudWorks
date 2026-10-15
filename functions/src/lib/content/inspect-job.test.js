import { describe, it, expect, vi } from 'vitest';
import { createInspectBatch, STAGGER_MS, MAX_BATCH } from './inspect-job.js';

const NOW = new Date('2026-08-21T17:00:00.000Z');
const doc = (id, extra = {}) => ({
  id,
  contentStatus: 'ingested',
  sourceUrl: `https://s/${id}`,
  ...extra,
});

function makeStore(flagged, unflagged) {
  return {
    queryDocs: vi.fn(async (_c, query) =>
      query.includes('c.inspectTrigger = true') ? flagged : unflagged
    ),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
  };
}

describe('batch-inspect', () => {
  it('takes flagged documents first, tops up with unflagged ones, staggers, counts outcomes', async () => {
    const store = makeStore(
      [doc('f1', { inspectTrigger: true })],
      [doc('u1'), doc('u2'), doc('f1')]
    );
    const inspector = {
      executeInspection: vi.fn(async ({ docId }) => ({
        docId,
        contentStatus: docId === 'u2' ? 'needs_rework' : 'inspected',
      })),
    };
    const sleep = vi.fn(async () => {});
    const r = await createInspectBatch({ store, inspector, sleep, now: () => NOW }).run({
      limit: 3,
    });
    expect(r).toEqual({
      total: 3,
      inspected: 3,
      needsRework: 1,
      failed: 0,
      skipped: 0,
      ids: { inspected: ['f1', 'u1', 'u2'], failed: [] },
    });
    expect(inspector.executeInspection.mock.calls.map((c) => c[0].docId)).toEqual([
      'f1',
      'u1',
      'u2',
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(STAGGER_MS);
  });

  it('records a failure on the document and continues; skips documents without a URL', async () => {
    const store = makeStore(
      [
        doc('a', { inspectTrigger: true }),
        doc('b', { inspectTrigger: true, sourceUrl: '' }),
        doc('c', { inspectTrigger: true }),
      ],
      []
    );
    const inspector = {
      executeInspection: vi.fn(async ({ docId }) => {
        if (docId === 'a') throw new Error('Status code 403');
        return { docId, contentStatus: 'inspected' };
      }),
    };
    const r = await createInspectBatch({
      store,
      inspector,
      sleep: vi.fn(async () => {}),
      now: () => NOW,
    }).run({ limit: 10 });
    expect(r).toMatchObject({
      total: 3,
      inspected: 1,
      failed: 1,
      skipped: 1,
      ids: { inspected: ['c'], failed: ['a'] },
    });
    // A sentence with the code and the log line's reference (#945).
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'a', {
      inspectTrigger: false,
      inspectError: expect.stringMatching(/^The inspection failed \(Error; reference [\w.:-]+\)\.$/),
      inspectErrorAt: NOW.toISOString(),
    });
  });

  it('clamps the batch size and defaults it', async () => {
    const store = makeStore(
      Array.from({ length: 40 }, (_, i) => doc(`d${i}`, { inspectTrigger: true })),
      []
    );
    const inspector = {
      executeInspection: vi.fn(async ({ docId }) => ({ docId, contentStatus: 'inspected' })),
    };
    const sleep = vi.fn(async () => {});
    expect((await createInspectBatch({ store, inspector, sleep }).run({ limit: 999 })).total).toBe(
      MAX_BATCH
    );
    expect((await createInspectBatch({ store, inspector, sleep }).run({})).total).toBe(10);
    expect(store.queryDocs.mock.calls[0][1]).toMatch(/SELECT TOP 25 /);
  });

  it('honors an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    const store = makeStore([doc('f1', { inspectTrigger: true })], []);
    const inspector = { executeInspection: vi.fn() };
    await expect(
      createInspectBatch({ store, inspector, signal: controller.signal }).run()
    ).rejects.toThrow('timeout');
    expect(inspector.executeInspection).not.toHaveBeenCalled();
  });
});

