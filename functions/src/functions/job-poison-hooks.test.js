/**
 * A poisoned, reaped or timed-out job runs its type's real onComplete on the
 * whole job document (#942), end to end: the sweeper and runJob (lib/jobs.js)
 * read the jobs container the way Cosmos answers it, and the hooks registered
 * by forge-jobs.js and podcast-jobs.js write through the same in-memory store.
 *
 * #1198 made the sweeper hand the hooks the whole document (its queries used
 * to project `id, type, requeueCount, _etag`, so the hooks found no payload
 * and returned). That made the podcast publish hook live on the poison and
 * reap paths, where it ran late and wrote unconditionally: it could clear a
 * newer Publish's `host.podbean.pending` reservation. The follow-up holds it
 * to its own job's reservation under the `_etag` it read, here and on
 * runJob's timeout path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({}));

/** Fields a projection names, or the whole document for `*`, as Cosmos answers. */
const project = (sql, doc) => {
  const list = /^SELECT TOP \d+ (.+?) FROM c\b/.exec(sql)?.[1].trim();
  if (!list || list === '*') return structuredClone(doc);
  const fields = list.split(',').map((f) => f.trim().replace(/^c\./, ''));
  return Object.fromEntries(fields.filter((f) => f in doc).map((f) => [f, doc[f]]));
};

/**
 * When `on`, the next read of the transcript waits on `release` — the
 * worker's own read, outliving the job's budget — and later reads answer at
 * once, so the hook that runs after the timeout reads normally.
 */
const slowWorkerRead = vi.hoisted(() => ({ on: false, release: null }));

vi.mock('../lib/cosmos-client.js', async (importOriginal) => {
  const real = await importOriginal();
  let etag = 0;
  const table = (container) => (db[container] ||= {});
  return {
    ...real,
    readDoc: vi.fn(async (container, id) => {
      if (slowWorkerRead.on && container === 'podcast_transcripts') {
        slowWorkerRead.on = false;
        await new Promise((resolve) => {
          slowWorkerRead.release = resolve;
        });
      }
      return table(container)[id] ? structuredClone(table(container)[id]) : null;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      const current = table(container)[doc.id];
      if (!current || current._etag !== doc._etag) {
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      table(container)[doc.id] = { ...doc, _etag: `"e${(etag += 1)}"` };
      return structuredClone(table(container)[doc.id]);
    }),
    patchDoc: vi.fn(async (container, id, updates, options = {}) => {
      const current = table(container)[id];
      if (!current) throw Object.assign(new Error('not found'), { code: 404 });
      if (options.ifMatch && options.ifMatch !== current._etag) {
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      table(container)[id] = { ...current, ...updates, _etag: `"e${(etag += 1)}"` };
      return structuredClone(table(container)[id]);
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      table(container)[doc.id] = { ...doc, _etag: `"e${(etag += 1)}"` };
      return doc;
    }),
    queryDocs: vi.fn(async (container, sql) => {
      const status = /c\.status = '(\w+)'/.exec(sql)?.[1];
      return Object.values(table(container))
        .filter((doc) => !status || doc.status === status)
        .map((doc) => project(sql, doc));
    }),
  };
});
// The failure ping is Telegram; what is under test is the record each hook keeps.
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../lib/job-failure-notify.js', () => ({ createJobFailureOnComplete: () => notify }));

const cosmos = await import('../lib/cosmos-client.js');
const {
  createJobHandlers,
  createJobSweeper,
  getJobType,
  JOBS_CONTAINER,
  MAX_REQUEUE_COUNT,
  RUNNING_GRACE_MS,
} = await import('../lib/jobs.js');
await import('./forge-jobs.js');
await import('./podcast-jobs.js');

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const QUEUE_ID = 'forge_queue_item:q-1';

/** A queue entry still `forging` and a transcript still `pending`: what the hooks must clear. */
function seed() {
  for (const key of Object.keys(db)) delete db[key];
  db.admin_config = {
    [QUEUE_ID]: {
      id: QUEUE_ID,
      docType: 'forge_queue_item',
      configScope: 'admin_config',
      status: 'forging',
      jobId: 'j-forge',
      _etag: '"q0"',
    },
  };
  db.podcast_transcripts = {
    article_x: {
      id: 'article_x',
      status: 'published',
      host: { podbean: { pending: true, jobId: 'j-pod', queuedAt: LONG_AGO } },
      _etag: '"t0"',
    },
  };
}

/** A job document as enqueueJob writes it, aged past the sweeper's cutoffs. */
const jobDoc = (id, type, payload, extra) => ({
  id,
  type,
  payload,
  createdAt: LONG_AGO,
  requestedBy: { oid: 'u1', email: 'e@hcw.dev' },
  result: null,
  error: null,
  _etag: `"${id}"`,
  ...extra,
});

/** The real sweeper over the in-memory jobs container, with the real registry. */
const sweeper = () =>
  createJobSweeper({
    store: { queryDocs: cosmos.queryDocs, patchDoc: cosmos.patchDoc },
    now: () => NOW,
    log: { warn: vi.fn(), log: vi.fn() },
  });

beforeEach(() => {
  seed();
  notify.mockClear();
});

describe('a poisoned job’s real onComplete keeps its record (#942)', () => {
  const poisoned = { status: 'queued', requeueCount: MAX_REQUEUE_COUNT };

  it('forge-from-url marks its Forge Studio queue entry failed instead of leaving it forging', async () => {
    db[JOBS_CONTAINER] = {
      'j-forge': jobDoc(
        'j-forge',
        'forge-from-url',
        { url: 'https://a.test/post', queueItemId: QUEUE_ID },
        poisoned
      ),
    };
    await sweeper().sweep();

    expect(db[JOBS_CONTAINER]['j-forge'].status).toBe('failed');
    expect(db.admin_config[QUEUE_ID].status).toBe('failed');
    expect(db.admin_config[QUEUE_ID].error).toMatch(/poison/);
  });

  it('publish-podcast-transcript clears host.podbean.pending and says why', async () => {
    db[JOBS_CONTAINER] = {
      'j-pod': jobDoc('j-pod', 'publish-podcast-transcript', { transcriptId: 'article_x' }, poisoned),
    };
    await sweeper().sweep();

    const podbean = db.podcast_transcripts.article_x.host.podbean;
    expect(podbean.pending).toBeUndefined();
    expect(podbean.error).toMatchObject({ code: 'JOB_FAILED', retryable: true });
    expect(podbean.error.message).toMatch(/poison/);
  });

  it('publish-podcast-transcript leaves a newer Publish’s reservation alone', async () => {
    // The transcript was published again after this job went stale: its
    // marker names the newer job, which must not be cleared from under it.
    db.podcast_transcripts.article_x.host.podbean.jobId = 'j-newer';
    db[JOBS_CONTAINER] = {
      'j-pod': jobDoc('j-pod', 'publish-podcast-transcript', { transcriptId: 'article_x' }, poisoned),
    };
    await sweeper().sweep();

    expect(db[JOBS_CONTAINER]['j-pod'].status).toBe('failed');
    expect(db.podcast_transcripts.article_x.host.podbean).toMatchObject({
      pending: true,
      jobId: 'j-newer',
    });
    expect(db.podcast_transcripts.article_x.host.podbean.error).toBeUndefined();
  });
});

describe('runJob’s timeout path runs the same hook under the same rule (#942)', () => {
  /** runJob with the real publish type, its budget cut to 20 ms, over the in-memory store. */
  const timedOutPublish = async () => {
    const types = new Map([
      ['publish-podcast-transcript', { ...getJobType('publish-podcast-transcript'), timeoutMs: 20 }],
    ]);
    db[JOBS_CONTAINER] = {
      'j-pod': jobDoc('j-pod', 'publish-podcast-transcript', { transcriptId: 'article_x' }, {
        status: 'queued',
        attempts: 0,
      }),
    };
    const handlers = createJobHandlers({
      guard: { requireRole: vi.fn() },
      store: {
        readDoc: cosmos.readDoc,
        patchDoc: cosmos.patchDoc,
        replaceDocIfMatch: cosmos.replaceDocIfMatch,
      },
      now: () => NOW,
      types,
    });
    // The worker's own read of the transcript outlives the budget; it is
    // never released here, so the worker writes nothing of its own.
    slowWorkerRead.on = true;
    try {
      return await handlers.runJob({ jobId: 'j-pod' }, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    } finally {
      slowWorkerRead.on = false;
    }
  };

  it('clears its own reservation with JOB_TIMEOUT', async () => {
    expect(await timedOutPublish()).toEqual({ jobId: 'j-pod', outcome: 'timeout' });
    const podbean = db.podcast_transcripts.article_x.host.podbean;
    expect(podbean.pending).toBeUndefined();
    expect(podbean.error).toMatchObject({ code: 'JOB_TIMEOUT', retryable: true });
  });

  it('leaves a newer Publish’s reservation alone', async () => {
    db.podcast_transcripts.article_x.host.podbean.jobId = 'j-newer';
    expect(await timedOutPublish()).toEqual({ jobId: 'j-pod', outcome: 'timeout' });
    expect(db.podcast_transcripts.article_x.host.podbean).toMatchObject({
      pending: true,
      jobId: 'j-newer',
    });
  });
});

describe('a reaped job’s real onComplete keeps its record too (#942)', () => {
  it('publish-podcast-transcript clears the pending flag of a job whose host died', async () => {
    const startedAt = new Date(NOW.getTime() - 10 * 60_000 - RUNNING_GRACE_MS - 1000).toISOString();
    db[JOBS_CONTAINER] = {
      'j-pod': jobDoc(
        'j-pod',
        'publish-podcast-transcript',
        { transcriptId: 'article_x' },
        { status: 'running', startedAt, attempts: 1 }
      ),
    };
    const { reaped } = await sweeper().sweep();

    expect(reaped).toEqual([{ jobId: 'j-pod', type: 'publish-podcast-transcript' }]);
    const podbean = db.podcast_transcripts.article_x.host.podbean;
    expect(podbean.pending).toBeUndefined();
    expect(podbean.error).toMatchObject({ code: 'JOB_TIMEOUT' });
  });
});
