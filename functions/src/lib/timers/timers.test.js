import { describe, it, expect, vi } from 'vitest';
import { createSnapshotPublishHandlers } from '../snapshots-publish.js';
import { mergeDigest, raiseAlert, writeSystemAudit, toMillis } from './workflow-records.js';
import { createReviewerDigest, createReviewerDigestManualHandler } from './reviewer-digest.js';
import {
  createContentCleanup,
  getRejectionReferenceDate,
  deletionOrigin,
} from './content-cleanup.js';
import { createPublishingWatchdog } from './publishing-watchdog.js';
import { createLinkCheck, collectLiveLinkTargets, probeUrl } from './link-check.js';
import { createCertReverify, parseExpiryMs, isCredlyUrl } from './cert-reverify.js';
import {
  createCertImageCleanup,
  isImageBlobName,
  blobNameFromUrl,
  collectReferencedBlobNames,
} from './cert-image-cleanup.js';
import { createSkillsHubScrape, buildCertEvent, extractExamCodes } from './skills-hub.js';
import { createPlaudTokenRefresh } from './plaud-token.js';
import {
  createAgentHealthCheck,
  STALE_AFTER_MS,
  AGENT_HEALTH_QUERY,
  AGENT_OFFLINE_SOURCE,
} from './agent-health.js';
import { createTempStorageCleanup, parsePrefixes } from './temp-storage.js';
import {
  createForgeScheduled,
  FORGE_SCHEDULER_ACTOR,
  forgedTodayCount,
  scoreCandidate,
  rankCandidates,
} from './forge-scheduled.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const now = () => NOW;
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const H = 60 * 60 * 1000;

/** A store over an in-memory map of containers; queries are dispatched by a `match` function per test. */
function memStore(containers = {}, match = () => []) {
  const data = Object.fromEntries(
    Object.entries(containers).map(([k, v]) => [k, new Map(v.map((d) => [d.id, d]))])
  );
  const get = (c) => (data[c] ||= new Map());
  return {
    data,
    readDoc: vi.fn(async (c, id) => get(c).get(id) || null),
    upsertDoc: vi.fn(async (c, doc) => {
      get(c).set(doc.id, doc);
      return doc;
    }),
    // mergeDigest's write-if-unchanged pair (workflow-records.js).
    createDoc: vi.fn(async (c, doc) => {
      if (get(c).has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      get(c).set(doc.id, doc);
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (c, doc) => {
      if (get(c).get(doc.id)?._etag !== doc._etag) {
        throw Object.assign(new Error('changed'), { code: 412 });
      }
      get(c).set(doc.id, doc);
      return doc;
    }),
    patchDoc: vi.fn(async (c, id, u) => {
      const next = { ...(get(c).get(id) || { id }), ...u };
      get(c).set(id, next);
      return next;
    }),
    deleteDoc: vi.fn(async (c, id) => {
      get(c).delete(id);
    }),
    queryDocs: vi.fn(async (c, q, p) => match(c, q, p, get(c))),
    countDocs: vi.fn(async () => 0),
  };
}

describe('workflow records', () => {
  it('merges digests by day, keeps firstSeenAt on alert refresh, writes system audits', async () => {
    const store = memStore({
      workflow_digests: [{ id: '2026-08-21', digestDate: '2026-08-21', linkRot: { broken: 1 } }],
    });
    await mergeDigest(store, '2026-08-21', { publishingWatchdog: { x: 1 } });
    expect(store.data.workflow_digests.get('2026-08-21')).toEqual({
      id: '2026-08-21',
      digestDate: '2026-08-21',
      linkRot: { broken: 1 },
      publishingWatchdog: { x: 1 },
    });
    await raiseAlert(store, 'a1', { severity: 'warning' }, () => new Date('2026-08-20T00:00:00Z'));
    await raiseAlert(store, 'a1', { severity: 'critical' }, now);
    expect(store.data.workflow_alerts.get('a1')).toMatchObject({
      active: true,
      severity: 'critical',
      firstSeenAt: '2026-08-20T00:00:00.000Z',
      updatedAt: NOW.toISOString(),
    });
    const audit = await writeSystemAudit(
      store,
      { action: 'x', source: 'y', details: { n: 1 } },
      { now, uuid: () => 'u1' }
    );
    expect(audit).toMatchObject({
      id: 'u1',
      actor: 'system',
      userId: null,
      timestamp: NOW.toISOString(),
      details: { n: 1 },
    });
    expect(toMillis('2026-08-21T12:00:00.000Z')).toBe(NOW.getTime());
    expect(toMillis('nope')).toBe(0);
  });

  it('keeps both timers’ blocks when two merge the same digest in the same second', async () => {
    // The watchdog and the scheduled publisher both fire at 00, 06, 12 and
    // 18:00 UTC. A plain read-then-upsert let the second writer erase the
    // first one's block; the guarded write makes the loser read again.
    const store = memStore({
      workflow_digests: [{ id: '2026-08-21', digestDate: '2026-08-21', _etag: 'e1' }],
    });
    const realRead = store.readDoc.getMockImplementation();
    let raced = false;
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await realRead(c, id);
      if (!raced) {
        // Another timer lands its block between this read and this write.
        raced = true;
        store.data.workflow_digests.set(id, {
          ...doc,
          publishingWatchdog: { overdueScheduledCount: 0 },
          _etag: 'e2',
        });
      }
      return doc;
    });
    await mergeDigest(store, '2026-08-21', { publishingOps: { status: 'success' } });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.data.workflow_digests.get('2026-08-21')).toMatchObject({
      publishingWatchdog: { overdueScheduledCount: 0 },
      publishingOps: { status: 'success' },
    });
  });

  it('creates the day’s digest, and gives up loudly when every write loses', async () => {
    const store = memStore();
    await mergeDigest(store, '2026-08-22', { linkRot: { broken: 0 } });
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    expect(store.data.workflow_digests.get('2026-08-22')).toMatchObject({ linkRot: { broken: 0 } });

    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('changed'), { code: 412 }));
    await expect(
      mergeDigest(store, '2026-08-22', { linkRot: { broken: 1 } }, { attempts: 3 })
    ).rejects.toThrow(/kept changing; linkRot was not written/);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3);
  });
});

describe('reviewer digest', () => {
  it('counts the review queue (capped at 200), groups recent RSS by provider, writes the day', async () => {
    const store = memStore({}, (c, q) =>
      q.includes("c.source = 'rss'")
        ? [
            {
              id: 'r1',
              Title: 'A',
              cloudProvider: 'AWS',
              contentStatus: 'ingested',
              sourceFeed: 'f',
              sourceUrl: 'https://a',
            },
            { id: 'r2', title: 'B', 'Cloud Provider': 'AWS' },
            { id: 'r3' },
          ]
        : []
    );
    store.countDocs.mockImplementation(async (_c, _w, p) => (p[0].value === 'ingested' ? 999 : 3));
    const r = await createReviewerDigest({ store, now }).run();
    expect(r).toEqual({
      success: true,
      digestDate: '2026-08-21',
      totalQueued: 209,
      recentRssCount: 3,
      queueByStatus: { ingested: 200, inspected: 3, in_review: 3, approved: 3 },
    });
    const digest = store.data.workflow_digests.get('2026-08-21');
    expect(digest.byProvider).toEqual({ AWS: 2, Unknown: 1 });
    expect(digest.topItems[0]).toEqual({
      id: 'r1',
      title: 'A',
      provider: 'AWS',
      status: 'ingested',
      sourceFeed: 'f',
      sourceUrl: 'https://a',
    });
    expect(digest.topItems[2]).toMatchObject({
      title: 'Untitled',
      status: 'ingested',
    });
    expect(digest.generatedBy).toBe('scheduler');
  });

  it('the manual RPC runs the same snapshot, editor-guarded, stamped generatedBy manual', async () => {
    const store = memStore({}, () => []);
    store.countDocs.mockResolvedValue(2);
    const guard = {
      requireRole: vi.fn(async () => ({
        user: { oid: 'u1' },
        role: 'editor',
        error: null,
      })),
    };
    const handler = createReviewerDigestManualHandler({ guard, store, now });
    const res = await handler({ headers: { get: () => null } }, { error: vi.fn() });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      totalQueued: 8,
      recentRssCount: 0,
    });
    expect(store.data.workflow_digests.get('2026-08-21').generatedBy).toBe('manual');

    const denied = createReviewerDigestManualHandler({
      guard: {
        requireRole: vi.fn(async () => ({
          error: { status: 403, body: '{}' },
        })),
      },
      store,
      now,
    });
    expect((await denied({ headers: { get: () => null } }, { error: vi.fn() })).status).toBe(403);
  });
});

describe('content cleanup', () => {
  it('soft-deletes aged rejections once, by the rejection reference date, with an audit entry', async () => {
    const rejected = [
      { id: 'old', rejectedAt: iso(-48 * H) },
      { id: 'fresh', rejectedAt: iso(-1 * H) },
      { id: 'done', reviewedAt: iso(-72 * H), softDeletedAt: iso(-2 * H) },
      { id: 'viaUpdated', updatedAt: iso(-30 * H) },
    ];
    const store = memStore({ content: rejected }, (c) => (c === 'content' ? rejected : []));
    const r = await createContentCleanup({
      store,
      now,
      uuid: () => 'a1',
    }).softDeleteRejected({
      olderThanHours: 24,
    });
    expect(r).toEqual({
      deletedCount: 2,
      softDeletedCount: 2,
      examinedCount: 4,
      hasMore: false,
    });
    expect(store.data.content.get('old')).toMatchObject({
      softDeletedAt: NOW.toISOString(),
      softDeletedReason: 'rejected_aged_out',
    });
    expect(store.data.content.get('fresh').softDeletedAt).toBeUndefined();
    expect(store.data.admin_audit_logs.get('a1')).toMatchObject({
      action: 'cron_soft_deleted_rejected_content',
      details: {
        affectedCount: 2,
        affectedIds: ['old', 'viaUpdated'],
        olderThanHours: 24,
      },
    });
    expect(getRejectionReferenceDate({ updatedAt: 'x' })).toBeNull();
  });

  it('hard-deletes soft-deleted content with its blogs and version rows, best-effort on versions', async () => {
    const store = memStore(
      {
        content: [
          {
            id: 'c1',
            publishedBlogId: 'b1',
            softDeletedAt: iso(-8 * 24 * H),
            deletionRequestedBy: 'editor',
          },
        ],
        blogs: [{ id: 'b1' }, { id: 'b2', sourceContentId: 'c1' }],
        content_versions: [{ id: 'v1', contentId: 'c1' }],
      },
      (c, q) => {
        if (c === 'content')
          return q.includes('AND NOT (')
            ? []
            : [
                {
                  id: 'c1',
                  publishedBlogId: 'b1',
                  deletionRequestedBy: 'editor',
                },
              ];
        if (c === 'blogs') return [{ id: 'b2' }];
        if (c === 'content_versions') return [{ id: 'v1' }];
        return [];
      }
    );
    const env = { CONTENT_HARD_DELETE: 'true' };
    const onContentDeleted = vi.fn(async () => ({}));
    const r = await createContentCleanup({
      store,
      now,
      uuid: () => 'a2',
      env,
      onContentDeleted,
    }).hardDeleteSoftDeleted({ olderThanHours: 24 * 7 });
    expect(r).toEqual({
      dryRun: false,
      examinedCount: 1,
      eligibleCount: 1,
      userRequestedCount: 1,
      policyCount: 0,
      refusedCount: 0,
      deletedContentCount: 1,
      deletedBlogCount: 2,
      deletedVersionCount: 1,
      hasMore: false,
      refusedHasMore: false,
    });
    expect(store.deleteDoc.mock.calls).toEqual([
      ['blogs', 'b1', 'b1'],
      ['blogs', 'b2', 'b2'],
      ['content', 'c1', 'c1'],
      ['content_versions', 'v1', 'c1'],
    ]);
    // The purge moved the dashboard counters itself (ADR 0033 §1): the change
    // feed never sees a delete, and until 2026-10-03 nothing here did either.
    expect(onContentDeleted).toHaveBeenCalledWith('c1');
    expect(store.queryDocs.mock.calls[0][2]).toEqual([
      { name: '@cutoff', value: iso(-7 * 24 * H) },
    ]);
    expect(store.data.admin_audit_logs.get('a2').details).toMatchObject({
      deletedContentCount: 1,
      deletedBlogCount: 2,
      deletedVersionCount: 1,
      userRequestedCount: 1,
      refusedCount: 0,
    });
    const empty = memStore({}, () => []);
    const log = { log: vi.fn(), warn: vi.fn() };
    expect(
      await createContentCleanup({
        store: empty,
        now,
        env,
        log,
      }).hardDeleteSoftDeleted()
    ).toEqual({
      dryRun: false,
      examinedCount: 0,
      eligibleCount: 0,
      userRequestedCount: 0,
      policyCount: 0,
      refusedCount: 0,
      deletedContentCount: 0,
      deletedBlogCount: 0,
      deletedVersionCount: 0,
      hasMore: false,
      refusedHasMore: false,
    });
    // An idle run still says so: the host.json override for this timer (T-766)
    // witnesses this line, and silence would be indistinguishable from never firing.
    expect(log.log).toHaveBeenCalledWith(
      '[cleanupSoftDeletedContent] content=0 blogs=0 versions=0 refused=0 examined=0'
    );
  });

  it('moves the counters through the stats maintainer by default, and a counter failure does not stop the purge', async () => {
    const marker = { id: 'c1', bucket: 'rejected', type: 'blog' };
    const stats = { id: 'dashboard_stats_v1', rejected: 3, totalDocs: 10 };
    const store = memStore(
      {
        content: [
          {
            id: 'c1',
            softDeletedAt: iso(-8 * 24 * H),
            softDeletedReason: 'rejected_aged_out',
          },
        ],
        content_stats_markers: [marker],
        system: [stats],
      },
      (c, q) => {
        if (c === 'content')
          return q.includes('AND NOT (')
            ? []
            : [{ id: 'c1', softDeletedReason: 'rejected_aged_out' }];
        return [];
      }
    );
    const env = { CONTENT_HARD_DELETE: 'true' };
    const r = await createContentCleanup({
      store,
      now,
      uuid: () => 'a7',
      env,
    }).hardDeleteSoftDeleted();
    expect(r.deletedContentCount).toBe(1);
    // The marker is gone and the counters came down with the document.
    expect(store.data.content_stats_markers.has('c1')).toBe(false);
    expect(store.data.system.get('dashboard_stats_v1')).toMatchObject({
      rejected: 2,
      totalDocs: 9,
    });

    const log = { log: vi.fn(), warn: vi.fn() };
    const failing = vi.fn(async () => {
      throw new Error('stats offline');
    });
    const store2 = memStore(
      {
        content: [
          {
            id: 'c2',
            softDeletedAt: iso(-8 * 24 * H),
            deletionRequestedBy: 'editor',
          },
        ],
      },
      (c, q) =>
        c === 'content' && !q.includes('AND NOT (')
          ? [{ id: 'c2', deletionRequestedBy: 'editor' }]
          : []
    );
    const r2 = await createContentCleanup({
      store: store2,
      now,
      uuid: () => 'a8',
      env,
      log,
      onContentDeleted: failing,
    }).hardDeleteSoftDeleted();
    expect(r2.deletedContentCount).toBe(1);
    expect(store2.data.content.has('c2')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('counters not updated for c2: stats offline')
    );
  });

  it('is dry-run until CONTENT_HARD_DELETE=true: nothing is deleted, no audit is written, the plan is logged', async () => {
    const known = [
      { id: 'u1', deletionRequestedBy: 'editor' },
      { id: 'p1', softDeletedReason: 'rejected_aged_out' },
    ];
    const unknown = [{ id: 'x1' }];
    const rows = [...known, ...unknown];
    const store = memStore({ content: rows }, (c, q) =>
      c === 'content' ? (q.includes('AND NOT (') ? unknown : known) : []
    );
    const log = { log: vi.fn(), warn: vi.fn() };
    for (const env of [{}, { CONTENT_HARD_DELETE: 'false' }, { CONTENT_HARD_DELETE: 'TRUE' }]) {
      const r = await createContentCleanup({
        store,
        now,
        env,
        log,
      }).hardDeleteSoftDeleted();
      expect(r).toMatchObject({
        dryRun: true,
        eligibleCount: 2,
        userRequestedCount: 1,
        policyCount: 1,
        refusedCount: 1,
        deletedContentCount: 0,
      });
    }
    expect(store.deleteDoc).not.toHaveBeenCalled();
    expect(store.data.admin_audit_logs).toBeUndefined();
    expect(log.log).toHaveBeenLastCalledWith(
      '[cleanupSoftDeletedContent] dry-run: would delete content=2 (user=1, policy=1) refused=1 examined=3'
    );
    // Counts only — the refused document's id is an identifier and stays out of the trace.
    expect(log.warn).toHaveBeenLastCalledWith(
      '[cleanupSoftDeletedContent] refused 1 document(s) whose deletion mark has no recorded origin — left for review'
    );
  });

  it('never deletes a document whose deletion mark has no recorded origin, even when armed', async () => {
    // `drift` comes back from the eligible query but classifies unknown in
    // memory — the second guard must refuse it too.
    const known = [
      { id: 'u1', deletionRequestedBy: 'editor' },
      { id: 'p1', softDeletedReason: 'rejected_aged_out' },
      { id: 'drift', deletionRequestedBy: '' },
    ];
    const unknown = [{ id: 'migrated' }, { id: 'bare' }];
    const rows = [...known, ...unknown];
    const store = memStore({ content: rows }, (c, q) =>
      c === 'content' ? (q.includes('AND NOT (') ? unknown : known) : []
    );
    const env = { CONTENT_HARD_DELETE: 'true' };
    const r = await createContentCleanup({
      store,
      now,
      uuid: () => 'a3',
      env,
    }).hardDeleteSoftDeleted();
    expect(r).toMatchObject({
      dryRun: false,
      examinedCount: 5,
      eligibleCount: 2,
      refusedCount: 3,
      deletedContentCount: 2,
    });
    expect(store.deleteDoc.mock.calls.map((c) => c[1])).toEqual(['u1', 'p1']);
    for (const id of ['migrated', 'bare', 'drift']) expect(store.data.content.has(id)).toBe(true);
    expect(store.data.admin_audit_logs.get('a3').details).toMatchObject({
      affectedIds: ['u1', 'p1'],
      refusedIds: ['migrated', 'bare', 'drift'],
      refusedCount: 3,
    });
    // The eligible query never sees an unknown-origin row, so refused rows
    // cannot occupy its TOP window and starve the eligible ones.
    const [eligibleQuery, unknownQuery] = store.queryDocs.mock.calls.map((c) => c[1]);
    expect(eligibleQuery).toContain(
      'c.softDeletedAt <= @cutoff AND ((IS_STRING(c.deletionRequestedBy)'
    );
    expect(unknownQuery).toContain('AND NOT ((IS_STRING(c.deletionRequestedBy)');
    // Armed, everything refused: nothing is deleted, but the audit entry is
    // still written, because the refused ids are the record a human reviews.
    const onlyUnknown = [{ id: 'bare1' }, { id: 'bare2' }];
    const store2 = memStore({ content: onlyUnknown }, (c, q) =>
      c === 'content' && q.includes('AND NOT (') ? onlyUnknown : []
    );
    const log2 = { log: vi.fn(), warn: vi.fn() };
    const r2 = await createContentCleanup({
      store: store2,
      now,
      uuid: () => 'a4',
      env,
      log: log2,
    }).hardDeleteSoftDeleted();
    expect(r2).toMatchObject({
      dryRun: false,
      examinedCount: 2,
      eligibleCount: 0,
      refusedCount: 2,
      deletedContentCount: 0,
    });
    expect(store2.deleteDoc).not.toHaveBeenCalled();
    expect(store2.data.admin_audit_logs.get('a4').details).toMatchObject({
      deletedContentCount: 0,
      refusedCount: 2,
      refusedIds: ['bare1', 'bare2'],
      affectedIds: [],
    });
    expect(log2.log).toHaveBeenLastCalledWith(
      '[cleanupSoftDeletedContent] content=0 blogs=0 versions=0 refused=2 examined=2'
    );
    // Armed and idle: nothing examined, so nothing to record and no audit entry.
    const idle = memStore({}, () => []);
    await createContentCleanup({
      store: idle,
      now,
      uuid: () => 'a5',
      env,
    }).hardDeleteSoftDeleted();
    expect(idle.data.admin_audit_logs).toBeUndefined();

    // A full refused window reports hasMore even when the eligible window is not full.
    const manyUnknown = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}` }));
    const store3 = memStore({}, (c, q) =>
      c === 'content' && q.includes('AND NOT (') ? manyUnknown : []
    );
    const r3 = await createContentCleanup({
      store: store3,
      now,
      uuid: () => 'a6',
      env,
    }).hardDeleteSoftDeleted({ limit: 3 });
    expect(r3).toMatchObject({
      eligibleCount: 0,
      refusedCount: 3,
      hasMore: true,
      refusedHasMore: true,
    });

    expect(deletionOrigin({ deletionRequestedBy: 'x' })).toBe('user');
    expect(deletionOrigin({ softDeletedReason: 'rejected_aged_out' })).toBe('policy');
    expect(
      deletionOrigin({
        softDeletedReason: 'rejected_aged_out',
        deletionRequestedBy: 'x',
      })
    ).toBe('user');
    expect(deletionOrigin({})).toBe('unknown');
    expect(deletionOrigin(null)).toBe('unknown');
  });
});

describe('publishing watchdog', () => {
  it('records counts in the digest and raises a critical alert for overdue schedules', async () => {
    const store = memStore({}, (c, q) =>
      q.includes('scheduledPublishDate <= @threshold')
        ? [{ id: 's1' }]
        : [
            { id: 'p1', contentStatus: 'published', publishedAt: iso(-7 * H) },
            { id: 'p2', contentStatus: 'published', publishedAt: iso(-1 * H) },
            {
              id: 'p3',
              contentStatus: 'published',
              scheduledPublishDate: iso(1 * H),
              updatedAt: iso(-20 * H),
            },
            { id: 'p4', contentStatus: 'approved', updatedAt: iso(-20 * H) },
          ]
    );
    const r = await createPublishingWatchdog({ store, now }).run();
    expect(r).toEqual({ overdueScheduledCount: 1, stagedTooLongCount: 1 });
    expect(store.queryDocs.mock.calls[0][2][0].value).toBe(iso(-45 * 60 * 1000));
    expect(store.data.workflow_digests.get('2026-08-21').publishingWatchdog).toEqual({
      lastRunAt: NOW.toISOString(),
      overdueScheduledCount: 1,
      stagedTooLongCount: 1,
    });
    expect(store.data.workflow_alerts.get('publishing-watchdog-2026-08-21T12')).toMatchObject({
      alertType: 'publishing_pipeline_stalled_items',
      severity: 'critical',
      sampleOverdueIds: ['s1'],
      sampleStagedIds: ['p1'],
      active: true,
    });
    const healthy = memStore({}, () => []);
    await createPublishingWatchdog({ store: healthy, now }).run();
    expect(healthy.data.workflow_alerts).toBeUndefined();
  });
});

describe('link check', () => {
  it('collects page and source targets, confirms HEAD failures with GET, alerts on rot only', async () => {
    expect(
      collectLiveLinkTargets({ curatedSubpagePath: 'aws/x', sourceUrl: 'https://s' }, 'd')
    ).toEqual([
      { docId: 'd', kind: 'page', url: 'https://hybridcloudworks.com/aws/x' },
      { docId: 'd', kind: 'source', url: 'https://s' },
    ]);
    expect(collectLiveLinkTargets({ url: 'ftp://x' }, 'd')).toEqual([]);
    const fetch = vi.fn(async (url, { method }) => {
      if (url === 'https://gone') return { status: 404 };
      if (url === 'https://headhater') return { status: method === 'HEAD' ? 404 : 200 };
      if (url === 'https://flaky') return { status: 503 };
      if (url === 'https://dead') throw new Error('ECONNRESET');
      return { status: 200 };
    });
    expect(await probeUrl('https://headhater', fetch)).toBe(200);
    expect(await probeUrl('https://dead', fetch)).toBe(0);
    const store = memStore({}, () => [
      { id: 'a', slugPageUrl: 'https://ok', sourceUrl: 'https://gone' },
      { id: 'b', publicUrl: 'https://flaky' },
      { id: 'c', publishedUrl: 'https://dead' },
    ]);
    const r = await createLinkCheck({ store, fetch, now }).run();
    expect(r).toEqual({ checked: 4, broken: 2 });
    expect(store.data.workflow_alerts.get('link-rot-2026-08-21')).toMatchObject({
      alertType: 'link_rot_detected',
      brokenCount: 2,
      checkedCount: 4,
      sampleBroken: [
        { docId: 'a', kind: 'source', url: 'https://gone', status: 404 },
        { docId: 'c', kind: 'page', url: 'https://dead', status: 0 },
      ],
    });
  });
});

describe('certification re-verification', () => {
  it('retires expired and revoked certs, ignores Credly network errors, republishes once', async () => {
    expect(parseExpiryMs('2026-01-05')).toBe(Date.parse('2026-01-05T00:00:00Z'));
    expect(Number.isNaN(parseExpiryMs(''))).toBe(true);
    expect(isCredlyUrl('https://www.credly.com/badges/x')).toBe(true);
    expect(isCredlyUrl('http://credly.com/x')).toBe(false);
    const certs = [
      { id: 'expired', name: 'E', certState: true, expDate: '2026-01-01' },
      {
        id: 'revoked',
        name: 'R',
        certState: true,
        verifyUrl: 'https://credly.com/badges/r',
      },
      {
        id: 'fine',
        name: 'F',
        certState: true,
        expDate: '2099-01-01T00:00:00Z',
        verifyUrl: 'https://credly.com/badges/f',
      },
      {
        id: 'unreachable',
        name: 'U',
        certState: true,
        verifyUrl: 'https://credly.com/badges/u',
      },
      // Marked inactive at an earlier expiry, then renewed: the expiry is ahead
      // again, so it comes back (ADR 0033, Spotlight slice).
      { id: 'renewed', name: 'N', certState: false, expDate: '2099-06-01' },
      // Inactive with a future expiry but Credly still refuses it: stays off.
      {
        id: 'stillRevoked',
        name: 'S',
        certState: false,
        expDate: '2099-06-01',
        verifyUrl: 'https://credly.com/badges/r',
      },
      // Inactive and lapsed: nothing to reason from, left alone.
      { id: 'lapsed', name: 'L', certState: false, expDate: '2020-01-01' },
    ];
    const store = memStore({ certifications: certs }, () => certs);
    const fetch = vi.fn(async (url) => {
      if (url.endsWith('/u')) throw new Error('timeout');
      return {
        text: async () =>
          url.endsWith('/r') ? '<p>Unable to verify badge</p>' : '<p>Verified</p>',
      };
    });
    const publishSnapshots = vi.fn(async () => ({}));
    const r = await createCertReverify({
      store,
      fetch,
      publishSnapshots,
      now,
    }).run();
    expect(r).toEqual({
      examined: 7,
      expiredCount: 1,
      revokedCount: 1,
      renewedCount: 1,
    });
    expect(store.data.certifications.get('expired').certState).toBe(false);
    expect(store.data.certifications.get('expired')._updatedAt).toBeDefined();
    expect(store.data.certifications.get('revoked').certState).toBe(false);
    expect(store.data.certifications.get('fine').certState).toBe(true);
    expect(store.data.certifications.get('unreachable').certState).toBe(true);
    expect(store.data.certifications.get('renewed')).toMatchObject({
      certState: true,
      reverifyReason: 'renewed',
    });
    expect(store.data.certifications.get('stillRevoked').certState).toBe(false);
    expect(store.data.certifications.get('lapsed').certState).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4); // the expired, renewed and lapsed ones are not fetched
    expect(store.queryDocs.mock.calls[0][1]).not.toContain('certState'); // every cert, not only active
    expect(publishSnapshots).toHaveBeenCalledWith(['certifications']);
  });
});

describe('cert image cleanup', () => {
  // Returning null here does not mean "not a Google URL" — it means "this blob
  // is referenced by nothing", and the caller DELETES on that answer. A scheme
  // or host in the wrong case would quietly turn a referenced blob into an
  // unreferenced one (#518).
  it.each([
    'http://storage.googleapis.com/x/certifications/images/c.png?x=1',
    'HTTPS://Storage.GoogleAPIs.com/x/certifications/images/c.png?x=1',
  ])('still resolves a legacy GCS URL written as %s', (url) => {
    expect(blobNameFromUrl(url)).toBe('images/c.png');
  });

  it('resolves Firebase, GCS and blob URLs to the same blob name', () => {
    expect(
      blobNameFromUrl(
        'https://firebasestorage.googleapis.com/v0/b/x.appspot.com/o/certifications%2Fimages%2Fa%20b.png?alt=media&token=t'
      )
    ).toBe('images/a b.png');
    expect(
      blobNameFromUrl('https://storage.googleapis.com/x/certifications/images/c.png?x=1')
    ).toBe('images/c.png');
    expect(
      blobNameFromUrl('https://stsiteprodcus01.blob.core.windows.net/certifications/images/d.png')
    ).toBe('images/d.png');
    expect(blobNameFromUrl('https://example.com/images/e.png')).toBeNull();
    // The media delivery route, relative (what the editor stores) and
    // absolute, with an encoded segment: a re-pointed badge is referenced.
    expect(blobNameFromUrl('/api/public/media/certifications/c1/images/badge-1.png')).toBe(
      'c1/images/badge-1.png'
    );
    expect(
      blobNameFromUrl('https://api-azure.hybridcloudworks.com/api/public/media/certifications/c1/images/a%20b.png?v=2')
    ).toBe('c1/images/a b.png');
    expect(
      [
        ...collectReferencedBlobNames([
          {
            imageUrl: 'https://stsiteprodcus01.blob.core.windows.net/certifications/images/a.png',
            badge: { ref: 'certifications/images/b.png' },
            image: [
              {
                url: 'https://storage.googleapis.com/x/certifications/images/c.png',
              },
            ],
          },
        ]),
      ].sort()
    ).toEqual(['images/a.png', 'images/b.png', 'images/c.png']);
  });

  it('dry-runs by default and deletes only old, unreferenced images when enabled', async () => {
    const certs = [
      {
        id: 'c',
        imageUrl: 'https://stsiteprodcus01.blob.core.windows.net/certifications/images/keep.png',
      },
    ];
    const store = memStore({}, () => certs);
    const blobs = [
      { name: 'images/keep.png', lastModified: iso(-30 * 24 * H) },
      { name: 'images/recent.png', lastModified: iso(-2 * 24 * H) },
      { name: 'images/orphan.png', lastModified: iso(-30 * 24 * H) },
      // The editor's real path shape (CertEditor.jsx), which the old `images/`
      // prefix never listed.
      { name: 'cert-9/images/badge-1.png', lastModified: iso(-30 * 24 * H) },
      // Not an image path: never a candidate, whatever its age.
      { name: 'exports/old.json', lastModified: iso(-300 * 24 * H) },
    ];
    expect(isImageBlobName('cert-9/images/badge-1.png')).toBe(true);
    expect(isImageBlobName('images/a.png')).toBe(true);
    expect(isImageBlobName('exports/images.json')).toBe(false);
    const storage = {
      listBlobs: vi.fn(async () => blobs),
      deleteBlob: vi.fn(async () => {}),
    };
    const dry = await createCertImageCleanup({
      store,
      storage,
      env: {},
      now,
    }).run();
    expect(dry).toEqual({
      dryRun: true,
      examined: 4,
      referenced: 1,
      candidates: 2,
      deleted: 0,
      skipped: 2,
    });
    expect(storage.deleteBlob).not.toHaveBeenCalled();
    expect(storage.listBlobs).toHaveBeenCalledWith('certifications', '');
    const real = await createCertImageCleanup({
      store,
      storage,
      env: { CERT_IMAGE_CLEANUP_DELETE: 'true' },
      now,
    }).run();
    expect(real).toMatchObject({ dryRun: false, deleted: 2 });
    expect(storage.deleteBlob).toHaveBeenCalledWith('certifications', 'images/orphan.png');
    expect(storage.deleteBlob).toHaveBeenCalledWith('certifications', 'cert-9/images/badge-1.png');
  });
});

describe('skills hub scrape', () => {
  it('stores only lifecycle events, once each, with exam codes and mentioned dates', async () => {
    expect(extractExamCodes('AZ-104 and AZ-104 and AI-9000 and ab-1')).toEqual([
      'AZ-104',
      'AI-9000',
    ]);
    const items = [
      {
        guid: 'g1',
        title: 'AZ-305 exam retires June 30, 2026',
        contentSnippet: 'x',
        pubDate: 'Fri, 01 May 2026 09:00:00 GMT',
        link: 'https://l',
      },
      { guid: 'g2', title: 'Community spotlight', contentSnippet: 'nothing' },
      { guid: 'g3', title: 'New beta exam SC-100', pubDate: 'garbage' },
    ];
    expect(buildCertEvent(items[1], NOW)).toBeNull();
    expect(buildCertEvent(items[0], NOW)).toMatchObject({
      type: 'retirement',
      certCodes: ['AZ-305'],
      mentionedDates: ['June 30, 2026'],
      pubDate: '2026-05-01T09:00:00.000Z',
      source: 'skills-hub-rss',
      link: 'https://l',
    });
    expect(buildCertEvent(items[2], NOW).pubDate).toBe(NOW.toISOString());
    const first = buildCertEvent(items[0], NOW);
    const store = memStore({ certEvents: [first] });
    const parser = { parseURL: vi.fn(async () => ({ items })) };
    expect(await createSkillsHubScrape({ store, parser, now }).run()).toEqual({
      written: 1,
      skipped: 2,
    });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    const broken = {
      parseURL: vi.fn(async () => {
        throw new Error('503');
      }),
    };
    expect(await createSkillsHubScrape({ store, parser: broken, now }).run()).toMatchObject({
      written: 0,
      error: '503',
    });
  });
});

describe('plaud token refresh', () => {
  it('rotates the pair on success and disconnects on every failure shape', async () => {
    const store = memStore({
      mcp_servers: [{ id: 'plaud', oauthRefreshToken: 'r1', status: 'connected' }],
    });
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'a2',
          refresh_token: 'r2',
          expires_in: 3600,
        }),
    }));
    expect(await createPlaudTokenRefresh({ store, fetch, now }).run()).toEqual({
      ok: true,
      expiresInSec: 3600,
    });
    expect(store.data.mcp_servers.get('plaud')).toMatchObject({
      oauthToken: 'a2',
      oauthRefreshToken: 'r2',
      oauthExpiresAt: NOW.getTime() + 3600 * 1000,
      status: 'connected',
      lastTokenRefreshError: null,
    });
    expect(fetch.mock.calls[0][1].body).toBe('refresh_token=r1');
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'revoked',
    });
    expect(await createPlaudTokenRefresh({ store, fetch, now }).run()).toEqual({
      ok: false,
      reason: 'http_401',
    });
    // Plaud's status, and its OAuth code when the body carries one, never
    // the body itself (#945).
    expect(store.data.mcp_servers.get('plaud')).toMatchObject({
      status: 'disconnected',
      lastTokenRefreshError: 'Plaud refused the token refresh (HTTP 401).',
    });
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'token r1 expired' }),
    });
    await createPlaudTokenRefresh({ store, fetch, now }).run();
    expect(store.data.mcp_servers.get('plaud').lastTokenRefreshError).toBe(
      'Plaud refused the token refresh (HTTP 400 invalid_grant).'
    );
    fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:443'));
    await createPlaudTokenRefresh({ store, fetch, now }).run();
    expect(store.data.mcp_servers.get('plaud').lastTokenRefreshError).toMatch(
      /^The token refresh failed \(Error; reference [\w.:-]+\)\.$/
    );
    expect(await createPlaudTokenRefresh({ store: memStore({}), fetch, now }).run()).toEqual({
      ok: false,
      reason: 'missing_doc',
    });
    // An access token with no refresh token is the shape the Connect tab
    // stored until 2026-09-05. It is not a failure: the document must be left
    // exactly as it was, or arming the timer would break a working Library.
    const noToken = memStore({
      mcp_servers: [{ id: 'plaud', oauthToken: 'a1', status: 'connected' }],
    });
    const fetchCalls = fetch.mock.calls.length;
    expect(await createPlaudTokenRefresh({ store: noToken, fetch, now }).run()).toEqual({
      ok: false,
      reason: 'missing_refresh_token',
    });
    expect(noToken.data.mcp_servers.get('plaud')).toEqual({
      id: 'plaud',
      oauthToken: 'a1',
      status: 'connected',
    });
    expect(fetch.mock.calls).toHaveLength(fetchCalls);
  });
});

describe('agent health + temp storage', () => {
  it('marks stale agents offline from their last heartbeat, with the partition key, once', async () => {
    const store = memStore({}, () => [
      {
        id: 'agent-1',
        agentId: 'agent-1',
        status: 'idle',
        lastSeenAt: iso(-5 * 60 * 1000),
      },
    ]);
    expect(await createAgentHealthCheck({ store, now }).run()).toEqual({
      markedOffline: 1,
      heartbeatWon: 0,
      notifiedOffline: 0,
      notifiedBack: 0,
    });
    expect(store.queryDocs.mock.calls[0].slice(0, 2)).toEqual(['lab_agents', AGENT_HEALTH_QUERY]);
    // offlineSince is when it went quiet, not when this run noticed (#1009).
    expect(store.patchDoc).toHaveBeenCalledWith(
      'lab_agents',
      'agent-1',
      { status: 'offline', offlineSince: iso(-5 * 60 * 1000) },
      { partitionKey: 'agent-1' }
    );
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(STALE_AFTER_MS).toBe(90 * 1000);
  });

  it('tells the owner on Telegram once an agent has been offline five minutes, and stays silent when nothing changed (LAB-2, #1009)', async () => {
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
    const log = { warn: vi.fn(), log: vi.fn() };
    const store = memStore({}, () => [
      { id: 'agent-1', agentId: 'agent-1', active: true, status: 'idle', hostname: 'vps-hostinger-01', lastSeenAt: iso(-5 * 60 * 1000) },
    ]);
    await createAgentHealthCheck({ store, notifier, now, log }).run();
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const call = notifier.notifyTelegram.mock.calls[0][0];
    expect(call).toMatchObject({ severity: 'critical', source: AGENT_OFFLINE_SOURCE });
    expect(call.title).toMatch(/offline/i);
    expect(call.message).toContain('agent-1 (vps-hostinger-01)');
    expect(call.message).toContain('fails closed');
    expect(store.patchDoc).toHaveBeenCalledWith(
      'lab_agents',
      'agent-1',
      { offlineNotifiedAt: NOW.toISOString() },
      { partitionKey: 'agent-1' }
    );
    // Logged at warn: host.json holds Function logs at Warning (#1009).
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/marked 1 agent\(s\) offline/));
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/offline message sent for 1 agent\(s\)/));
    // Content-free: counts, never the document id (review of #1018).
    for (const [line] of log.warn.mock.calls) expect(line).not.toContain('agent-1');

    const quiet = memStore({}, () => []);
    await createAgentHealthCheck({ store: quiet, notifier, now }).run();
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
  });

  it('marks the agent offline even when the notifier is absent or throws, and leaves the message owed (LAB-2)', async () => {
    const stale = () => [{ id: 'agent-1', agentId: 'agent-1', active: true, status: 'busy', lastSeenAt: iso(-10 * 60 * 1000) }];
    const store = memStore({}, stale);
    expect(await createAgentHealthCheck({ store, now }).run()).toMatchObject({ markedOffline: 1 });

    const throwing = { notifyTelegram: vi.fn(async () => { throw new Error('telegram down'); }) };
    const store2 = memStore({}, stale);
    const log = { warn: vi.fn(), log: vi.fn() };
    expect(await createAgentHealthCheck({ store: store2, notifier: throwing, now, log }).run()).toEqual({
      markedOffline: 1,
      heartbeatWon: 0,
      notifiedOffline: 0,
      notifiedBack: 0,
    });
    expect(throwing.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(store2.patchDoc).toHaveBeenCalledTimes(1);
    expect(store2.data.lab_agents.get('agent-1')).not.toHaveProperty('offlineNotifiedAt');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/notification failed/));
  });

  it('temp storage: prefix + age only, dry-run by default, never a whole container', async () => {
    expect(parsePrefixes('content:uploads/, covers:tmp/x:y ,bad,:nope, content:')).toEqual([
      { container: 'content', prefix: 'uploads/' },
      { container: 'covers', prefix: 'tmp/x:y' },
    ]);
    const storage = {
      listBlobs: vi.fn(async () => [
        { name: 'uploads/old.bin', lastModified: iso(-10 * 24 * H) },
        { name: 'uploads/new.bin', lastModified: iso(-1 * 24 * H) },
      ]),
      deleteBlob: vi.fn(async () => {}),
    };
    const dry = await createTempStorageCleanup({ storage, env: {}, now }).run();
    expect(dry).toEqual({
      dryRun: true,
      maxAgeDays: 7,
      examined: 2,
      candidates: 1,
      deleted: 0,
      byPrefix: {
        'content:uploads/': { examined: 2, candidates: 1, deleted: 0 },
      },
    });
    expect(storage.deleteBlob).not.toHaveBeenCalled();
    const real = await createTempStorageCleanup({
      storage,
      env: {
        TEMP_STORAGE_CLEANUP_DELETE: 'true',
        TEMP_STORAGE_MAX_AGE_DAYS: '3',
      },
      now,
    }).run();
    expect(real).toMatchObject({ dryRun: false, maxAgeDays: 3, deleted: 1 });
    expect(storage.deleteBlob).toHaveBeenCalledWith('content', 'uploads/old.bin');
  });
});

describe('forge scheduled', () => {
  it('skips when auto-forge is off, otherwise forges unforged candidates up to the daily limit and tallies outcomes', async () => {
    const forge = {
      runForgePipeline: vi.fn(async ({ contentId }) =>
        contentId === 'dup'
          ? { ok: false, httpStatus: 409, error: 'dupe' }
          : contentId === 'bad'
            ? { ok: false, httpStatus: 502, error: 'gen failed' }
            : {
                ok: true,
                result: {
                  status: contentId === 'ed' ? 'editing' : 'forge_ready',
                },
              }
      ),
    };
    const off = {
      loadForgePrompts: async () => ({
        autoForge: { enabled: false, dailyLimit: 3 },
      }),
      loadForgeProfile: async () => ({ interestAreas: [] }),
    };
    expect(
      (
        await createForgeScheduled({
          store: memStore(),
          config: off,
          forge,
        }).run()
      ).skippedRun
    ).toBe(true);
    const on = {
      loadForgePrompts: async () => ({
        autoForge: { enabled: true, dailyLimit: 4 },
      }),
      loadForgeProfile: async () => ({ interestAreas: [] }),
    };
    const store = memStore({}, () => [
      { id: 'forged', forgeMeta: {} },
      { id: 'ok' },
      { id: 'ed' },
      { id: 'dup' },
      { id: 'bad' },
      { id: 'overflow' },
    ]);
    const r = await createForgeScheduled({
      store,
      config: on,
      forge,
      now,
    }).run();
    expect(r).toEqual({
      skippedRun: false,
      attempted: 4,
      staged: 1,
      editing: 1,
      skipped: 1,
      errors: 1,
      failures: [{ contentId: 'bad', error: 'gen failed' }],
    });
    expect(
      forge.runForgePipeline.mock.calls.every((c) => c[0].actor === FORGE_SCHEDULER_ACTOR)
    ).toBe(true);
    expect(forge.runForgePipeline).not.toHaveBeenCalledWith(
      expect.objectContaining({ contentId: 'overflow' })
    );
  });

  it("spends only the day's REMAINING budget and skips entirely at the limit (T-607)", async () => {
    const todayKey = NOW.toISOString().slice(0, 10);
    const forge = {
      runForgePipeline: vi.fn(async () => ({
        ok: true,
        result: { status: 'forge_ready' },
      })),
    };
    const config = {
      loadForgePrompts: async () => ({
        autoForge: { enabled: true, dailyLimit: 3 },
      }),
      loadForgeProfile: async () => ({ interestAreas: [] }),
    };
    // 2 of 3 already forged today (by /forge, forge-from-url, or an earlier run).
    const store = memStore(
      {
        admin_config: [{ id: 'forge_stats', today: { date: todayKey, forged: 2 } }],
      },
      () => [{ id: 'a' }, { id: 'b' }]
    );
    const r = await createForgeScheduled({ store, config, forge, now }).run();
    expect(r.attempted).toBe(1);
    expect(forge.runForgePipeline).toHaveBeenCalledTimes(1);

    // At the limit: no run at all.
    store.data.admin_config.set('forge_stats', {
      id: 'forge_stats',
      today: { date: todayKey, forged: 3 },
    });
    forge.runForgePipeline.mockClear();
    const full = await createForgeScheduled({
      store,
      config,
      forge,
      now,
    }).run();
    expect(full).toMatchObject({
      skippedRun: true,
      reason: 'daily_limit_reached',
      forgedToday: 3,
    });
    expect(forge.runForgePipeline).not.toHaveBeenCalled();

    // Yesterday's bucket does not count against today.
    expect(forgedTodayCount({ today: { date: '2020-01-01', forged: 9 } }, todayKey)).toBe(0);
    expect(forgedTodayCount(null, todayKey)).toBe(0);
  });

  it('ranks candidates by interest-area weight before the daily cut', async () => {
    const interestAreas = [
      { key: 'finops', weight: 90, keywords: ['cost', 'finops'] },
      { key: 'k8s', weight: 40, keywords: ['kubernetes', 'aks'] },
    ];
    expect(scoreCandidate({ Title: 'Cut AKS cost with spot nodes' }, interestAreas)).toBe(130);
    expect(scoreCandidate({ keyTopics: ['Kubernetes'] }, interestAreas)).toBe(40);
    expect(scoreCandidate({ Title: 'Unrelated' }, interestAreas)).toBe(0);
    // Already-forged rows drop out; ties keep query order.
    expect(
      rankCandidates(
        [
          { id: 'plain', Title: 'Networking notes' },
          { id: 'forged', Title: 'FinOps cost', forgeMeta: {} },
          { id: 'hot', Title: 'FinOps cost deep dive' },
          { id: 'warm', Title: 'AKS upgrade' },
        ],
        interestAreas
      ).map((c) => c.id)
    ).toEqual(['hot', 'warm', 'plain']);

    const forge = {
      runForgePipeline: vi.fn(async () => ({
        ok: true,
        result: { status: 'forge_ready' },
      })),
    };
    const config = {
      loadForgePrompts: async () => ({
        autoForge: { enabled: true, dailyLimit: 1 },
      }),
      loadForgeProfile: async () => ({ interestAreas }),
    };
    const store = memStore({}, () => [
      { id: 'plain', Title: 'Networking notes' },
      { id: 'hot', Title: 'FinOps cost deep dive' },
    ]);
    await createForgeScheduled({ store, config, forge, now }).run();
    // The one budget slot goes to the highest-scoring candidate, not the first row.
    expect(forge.runForgePipeline).toHaveBeenCalledTimes(1);
    expect(forge.runForgePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ contentId: 'hot' })
    );
  });
});

describe('reVerifyCertifications wiring (#868)', () => {
  it('the publish handlers carry the publishSnapshots the scheduler passes to the timer', () => {
    const snapshots = createSnapshotPublishHandlers({
      guard: { requireRole: vi.fn() },
      store: { queryDocs: vi.fn(), upsertDoc: vi.fn() },
    });
    // schedulers.js: createCertReverify({ publishSnapshots: snapshots.publishSnapshots })
    expect(typeof snapshots.publishSnapshots).toBe('function');
  });
});
