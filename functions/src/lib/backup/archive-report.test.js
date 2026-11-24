/**
 * The archive dry run and the start rule (ADR 0046). An in-memory blob store
 * stands in for the two private containers; every record is made up.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import {
  ARCHIVE_SETTING,
  MAX_FIELD_NAMES,
  REPORT_JOB_TYPE,
  archiveStartDecision,
  archiveYearFor,
  createReportScheduler,
  createReportWorker,
  findLatestFullBackup,
  gzipLines,
  parseReportPayload,
  readLatestReport,
  reportContainers,
  reportIdFor,
  reportNames,
} from './archive-report.js';
import { archivePlan, UNCLASSIFIED } from './archive-classification.js';
import { createArchiveHandlers, DRY_RUN_AUDIT_ACTION } from './archive-handlers.js';

const ndjson = (docs) => gzipSync(Buffer.from(docs.map((doc) => (typeof doc === 'string' ? doc : JSON.stringify(doc))).join('\n') + '\n'));

/** A blob store in memory: JSON blobs and gzip blobs by name. */
function memoryBlobs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  return {
    files,
    writes,
    async putJson(name, value, { overwrite = true } = {}) {
      if (!overwrite && files.has(name)) return false;
      files.set(name, JSON.parse(JSON.stringify(value)));
      writes.push(name);
      return true;
    },
    async readJson(name) {
      const value = files.get(name);
      return value === undefined || Buffer.isBuffer(value) ? null : value;
    },
    async listNames(prefix) {
      return [...files.keys()].filter((name) => name.startsWith(prefix));
    },
    async readGzipStream(name) {
      const value = files.get(name);
      return Buffer.isBuffer(value) ? Readable.from([value.subarray(0, 7), value.subarray(7)]) : null;
    },
  };
}

const SUNDAY = '2027-02-07'; // a Sunday
const backupSeed = (containers) => ({
  [`full/${SUNDAY}/manifest.json`]: {
    runId: SUNDAY,
    mode: 'full',
    containers: Object.entries(containers).map(([container, docs]) => ({ container, docs: docs.length, bytes: 10 })),
  },
  ...Object.fromEntries(Object.entries(containers).map(([container, docs]) => [`full/${SUNDAY}/${container}.ndjson.gz`, ndjson(docs)])),
});

describe('archiveStartDecision: once a year, never in January, only when switched on', () => {
  const on = { [ARCHIVE_SETTING]: 'true' };
  const facts = (over = {}) => ({ env: on, now: new Date('2027-02-08T04:00:00Z'), manifestExists: false, backupRunId: '2027-02-07', ...over });

  it('starts when all four conditions hold, for the year before', () => {
    expect(archiveStartDecision(facts())).toEqual({ start: true, year: 2026, earliestBackup: '2027-02-02', blockers: [] });
    expect(archiveYearFor(new Date('2027-12-31T23:59:59Z'))).toBe(2026);
    expect(archiveYearFor(new Date('2028-01-01T00:00:00Z'))).toBe(2027);
  });

  it('does not start while the switch is off, absent, or anything but the exact text true', () => {
    for (const value of [undefined, 'false', '', 'TRUE', '1', 'true ']) {
      const decision = archiveStartDecision(facts({ env: { [ARCHIVE_SETTING]: value } }));
      expect(decision.start, String(value)).toBe(false);
      expect(decision.blockers).toEqual(['switch-off']);
    }
    expect(archiveStartDecision(facts({ env: {} })).start).toBe(false);
  });

  it('holds the date edges in UTC: 31 January no, 1 February yes', () => {
    const at = (iso) => archiveStartDecision(facts({ now: new Date(iso), backupRunId: '2027-02-07' }));
    expect(at('2027-01-31T23:59:59.999Z').blockers).toContain('before-1-february');
    expect(at('2027-02-01T00:00:00.000Z').blockers).not.toContain('before-1-february');
    // 31 January 20:00 in New York is already 1 February in UTC, and UTC is the clock.
    expect(at('2027-02-01T01:00:00.000Z').blockers).toEqual([]);
  });

  it('needs a complete full backup dated 2 February or later', () => {
    const with_ = (backupRunId) => archiveStartDecision(facts({ backupRunId })).blockers;
    expect(with_('2027-01-31')).toEqual(['backup-too-early']);
    expect(with_('2027-02-01')).toEqual(['backup-too-early']);
    expect(with_('2027-02-02')).toEqual([]);
    expect(with_(null)).toEqual(['no-backup']);
    expect(with_('not-a-date')).toEqual(['no-backup']);
  });

  it('never archives a year twice, and reads "could not tell" as no', () => {
    expect(archiveStartDecision(facts({ manifestExists: true })).blockers).toEqual(['already-archived']);
    expect(archiveStartDecision(facts({ manifestExists: null })).blockers).toEqual(['archive-not-readable']);
    expect(archiveStartDecision(facts({ manifestExists: undefined })).start).toBe(false);
  });

  it('lists every blocker at once', () => {
    const decision = archiveStartDecision({ env: {}, now: new Date('2027-01-15T00:00:00Z'), manifestExists: true, backupRunId: null });
    expect(decision.blockers).toEqual(['switch-off', 'before-1-february', 'already-archived', 'no-backup']);
  });
});

describe('findLatestFullBackup', () => {
  it('takes the newest Sunday whose manifest exists, and skips a Sunday that never finished', async () => {
    const blobs = memoryBlobs({
      'full/2027-01-31/manifest.json': { containers: [{ container: 'blogs', docs: 3, bytes: 9 }] },
      // 2027-02-07 has a run record and no manifest: not complete.
      'full/2027-02-07/run.json': { containers: ['blogs'] },
    });
    const found = await findLatestFullBackup({ blobs, now: new Date('2027-02-09T00:00:00Z') });
    expect(found).toEqual({ runId: '2027-01-31', containers: [{ container: 'blogs', docs: 3, bytes: 9 }] });
  });

  it('answers null when no full backup is within reach', async () => {
    const blobs = memoryBlobs({ 'full/2026-12-06/manifest.json': { containers: [] } });
    expect(await findLatestFullBackup({ blobs, now: new Date('2027-02-09T00:00:00Z') })).toBeNull();
  });
});

describe('gzipLines', () => {
  it('yields each line whole across chunk boundaries, with no trailing empty line', async () => {
    const body = gzipSync(Buffer.from('{"a":1}\n{"b":"é"}\n{"c":3}'));
    const lines = [];
    for await (const line of gzipLines(Readable.from([body.subarray(0, 5), body.subarray(5)]))) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":"é"}', '{"c":3}']);
  });

  it('fails on bytes that are not gzip instead of ending quietly', async () => {
    const read = async () => {
      for await (const line of gzipLines(Readable.from([Buffer.from('not gzip at all')]))) void line;
    };
    await expect(read()).rejects.toThrow();
  });
});

describe('parseReportPayload', () => {
  const ok = { reportId: '20270208T0400Z', runId: SUNDAY, container: 'blogs' };
  it('accepts a container the dry run reads and refuses everything else', () => {
    expect(parseReportPayload(ok)).toEqual(ok);
    expect(reportContainers()).toHaveLength(archivePlan().length + UNCLASSIFIED.length);
    for (const bad of [{ ...ok, container: 'admins' }, { ...ok, container: 'jobs' }, { ...ok, reportId: '../x' }, { ...ok, runId: 'full/../x' }, {}]) {
      expect(() => parseReportPayload(bad)).toThrow();
    }
    try {
      parseReportPayload({});
    } catch (error) {
      expect(error.status).toBe(400);
    }
  });
});

describe('a dry run, end to end', () => {
  const containers = {
    blogs: [{ id: 'b1' }, { id: 'b2' }],
    content: [
      { id: 'a1', type: 'article' },
      { id: 'i1', type: 'interview', Live: true },
      { id: 'i2', type: 'interview', contentStatus: 'draft' },
    ],
    content_versions: [
      { id: 'v1', contentId: 'a1' },
      { id: 'v2', contentId: 'i2' },
      { id: 'v3', contentId: 'gone' },
    ],
    developer_events: [
      { id: 'c1', docType: 'cfs-call' },
      { id: 'p1', docType: 'cfs-submission', speakerName: 'Example Speaker', speakerEmail: 'speaker@example.com' },
    ],
    admin_config: [{ id: 'reminders' }, { id: 'developer_api_key:k1', keyHash: 'made-up' }, { id: 'health_pulse' }, { id: 'added_later' }],
    tool_workspaces: [
      { id: 't1', visitorId: 'made-up-visitor', notes: 'typed by someone', _ts: 1 },
      { id: 't2', notes: 'more', 'a name with spaces': 1 },
      'this line is not JSON',
    ],
    admins: [{ id: 'made-up-admin' }],
  };

  async function runAll(blobs, at = new Date('2027-02-08T04:00:30Z')) {
    const jobs = [];
    const queued = [];
    const scheduler = createReportScheduler({
      store: { upsertDoc: async (_container, doc) => jobs.push(doc) },
      blobs,
      enqueue: (messages) => queued.push(...messages),
      now: () => at,
    });
    const started = await scheduler.start({ requestedBy: { oid: 'made-up-oid' } });
    const worker = createReportWorker({ blobs, now: () => at });
    const results = [];
    for (const job of jobs) results.push(await worker.readContainer(parseReportPayload(job.payload)));
    return { started, jobs, queued, results };
  }

  it('queues one job per container to read, and none for one left out for a known reason', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    const { started, jobs, queued } = await runAll(blobs);
    expect(started).toMatchObject({ started: true, sourceRun: SUNDAY, queued: 6, reportId: '20270208T0400Z' });
    expect(jobs.map((job) => job.payload.container).sort()).toEqual([
      'admin_config',
      'blogs',
      'content',
      'content_versions',
      'developer_events',
      'tool_workspaces',
    ]);
    expect(jobs.every((job) => job.type === REPORT_JOB_TYPE)).toBe(true);
    expect(queued).toHaveLength(6);
  });

  it('writes a report of counts that match the classification', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    const { results } = await runAll(blobs);
    expect(results.filter((r) => r.reportWritten)).toHaveLength(1);
    const latest = await readLatestReport({ blobs });
    expect(latest.complete).toBe(true);
    const report = latest.report;
    const of = (name) => report.containers.find((c) => c.container === name);

    expect(of('blogs')).toMatchObject({ read: 2, kept: 2, changed: 0, leftOut: 0, matchesBackup: true });
    expect(of('content')).toMatchObject({ read: 3, kept: 2, leftOut: 1, leftOutBy: { promise: 1 } });
    expect(of('content_versions')).toMatchObject({ read: 3, kept: 1, leftOut: 2, leftOutBy: { promise: 1, orphan: 1 } });
    expect(of('developer_events')).toMatchObject({ read: 2, kept: 2, changed: 1, removed: { speakerName: 1, speakerEmail: 1 } });
    expect(of('admin_config')).toMatchObject({
      read: 4,
      kept: 1,
      leftOut: 3,
      leftOutBy: { secret: 1, 'working-state': 1, unlisted: 1 },
    });
    expect(of('tool_workspaces')).toMatchObject({
      decision: 'leave-out',
      reason: 'unclassified',
      read: 3,
      kept: 0,
      leftOut: 2,
      unreadable: 1,
      otherNames: 1,
      fieldNamesTruncated: false,
      fieldNames: [
        { name: 'id', records: 2 },
        { name: 'notes', records: 2 },
        { name: 'visitorId', records: 1 },
      ],
    });
    expect(report.leftOutWhole).toEqual([{ container: 'admins', reason: 'access-list', backupDocs: 1 }]);
    expect(report.notInBackup.map((c) => c.container)).toContain('jobs');
    expect(report.totals).toMatchObject({ containersRead: 6, read: 17, kept: 8, changed: 1, leftOut: 8, unreadable: 1, mismatched: 0 });
    expect(report.sourceBackup).toEqual({ mode: 'full', runId: SUNDAY });
  });

  it('carries field names only for unclassified containers, and never a value', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    expect(report.containers.filter((c) => c.fieldNames).map((c) => c.container)).toEqual(['tool_workspaces']);
    const everything = JSON.stringify([...blobs.files].filter(([name]) => name.startsWith('state/')));
    for (const value of ['made-up-visitor', 'typed by someone', 'Example Speaker', 'speaker@example.com', 'a name with spaces', 'made-up-admin', 'b1', 'developer_api_key', 'made-up-oid']) {
      expect(everything, value).not.toContain(value);
    }
  });

  it('writes nothing to the archive and changes no backup file', async () => {
    const seed = backupSeed(containers);
    const blobs = memoryBlobs(seed);
    await runAll(blobs);
    expect(blobs.writes.length).toBeGreaterThan(0);
    expect(blobs.writes.every((name) => name.startsWith('state/archive-report/'))).toBe(true);
    for (const [name, value] of Object.entries(seed)) expect(blobs.files.get(name)).toBe(value);
  });

  it('stops listing field names past the limit and says so', async () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_FIELD_NAMES + 5 }, (_, i) => [`field${i}`, i]));
    const blobs = memoryBlobs(backupSeed({ config_settings: [wide] }));
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    const part = report.containers[0];
    expect(part.fieldNames).toHaveLength(MAX_FIELD_NAMES);
    expect(part.fieldNamesTruncated).toBe(true);
  });

  it('flags a container whose file holds a different number of records than the backup says', async () => {
    const seed = backupSeed({ blogs: [{ id: 'b1' }] });
    seed[`full/${SUNDAY}/manifest.json`].containers[0].docs = 5;
    const blobs = memoryBlobs(seed);
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    expect(report.containers[0]).toMatchObject({ read: 1, backupDocs: 5, matchesBackup: false });
    expect(report.totals.mismatched).toBe(1);
  });

  it('a second press in the same minute starts nothing; a rerun of a job rewrites its part and not the report', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    const first = await runAll(blobs);
    const again = await createReportScheduler({
      store: { upsertDoc: vi.fn() },
      blobs,
      enqueue: vi.fn(),
      now: () => new Date('2027-02-08T04:00:59Z'),
    }).start();
    expect(again).toEqual({ started: false, reason: 'already-started', reportId: '20270208T0400Z' });

    const before = JSON.stringify(blobs.files.get(reportNames('20270208T0400Z').report));
    const worker = createReportWorker({ blobs, now: () => new Date('2027-02-08T05:00:00Z') });
    const rerun = await worker.readContainer(parseReportPayload(first.jobs[0].payload));
    expect(rerun.reportWritten).toBe(false);
    expect(JSON.stringify(blobs.files.get(reportNames('20270208T0400Z').report))).toBe(before);
  });

  it('reports progress while parts are still missing', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    const jobs = [];
    await createReportScheduler({
      store: { upsertDoc: async (_c, doc) => jobs.push(doc) },
      blobs,
      enqueue: () => {},
      now: () => new Date('2027-02-08T04:00:00Z'),
    }).start();
    const worker = createReportWorker({ blobs });
    const result = await worker.readContainer(parseReportPayload(jobs[0].payload));
    expect(result.reportWritten).toBe(false);
    expect(await readLatestReport({ blobs })).toMatchObject({ complete: false, done: 1, expected: 6, sourceRun: SUNDAY });
  });

  it('says so when a container’s file is not in the backup, and stops when the job is cancelled', async () => {
    const seed = backupSeed(containers);
    delete seed[`full/${SUNDAY}/blogs.ndjson.gz`];
    const blobs = memoryBlobs(seed);
    blobs.files.set(reportNames('20270208T0400Z').run, { containers: ['blogs'], backup: { runId: SUNDAY, containers: [] } });
    const worker = createReportWorker({ blobs });
    await worker.readContainer({ reportId: '20270208T0400Z', runId: SUNDAY, container: 'blogs' });
    expect(blobs.files.get(reportNames('20270208T0400Z', 'blogs').part)).toMatchObject({ inBackup: false, read: 0 });

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      worker.readContainer({ reportId: '20270208T0400Z', runId: SUNDAY, container: 'content', signal: controller.signal })
    ).rejects.toThrow('cancelled');
  });

  it('answers no-backup, and queues nothing, when there is no full backup', async () => {
    const enqueue = vi.fn();
    const result = await createReportScheduler({ store: { upsertDoc: vi.fn() }, blobs: memoryBlobs(), enqueue, now: () => new Date('2027-02-08T04:00:00Z') }).start();
    expect(result).toEqual({ started: false, reason: 'no-backup' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('the two admin routes', () => {
  const allow = { requireRole: vi.fn(async () => ({ user: { oid: 'made-up-oid', email: 'owner@example.com' } })) };
  const refuse = { requireRole: vi.fn(async () => ({ error: { status: 403 } })) };
  const at = new Date('2027-02-08T04:00:00Z');
  const make = (over = {}) => {
    const audit = [];
    const blobs = over.blobs || memoryBlobs(backupSeed({ blogs: [{ id: 'b1' }] }));
    const handlers = createArchiveHandlers({
      guard: allow,
      store: { upsertDoc: async (container, doc) => audit.push({ container, doc }) },
      blobs,
      archiveBlobs: { readJson: async () => null },
      env: {},
      now: () => at,
      uuid: () => 'made-up-uuid',
      ...over,
    });
    return { handlers, audit, blobs };
  };
  const body = (response) => JSON.parse(response.body);

  it('asks for super_admin on both, and does nothing when refused', async () => {
    const enqueue = vi.fn();
    const { handlers, audit, blobs } = make({ guard: refuse });
    expect((await handlers.getStatus({}, {})).status).toBe(403);
    expect((await handlers.startDryRun({}, {}, { enqueue })).status).toBe(403);
    expect(refuse.requireRole).toHaveBeenCalledWith({}, 'super_admin');
    expect(enqueue).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
    expect(blobs.writes).toEqual([]);
  });

  it('GET: switch off, the job not built, the blockers and the classification in numbers', async () => {
    const response = await make().handlers.getStatus({}, {});
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    expect(body(response)).toMatchObject({
      ok: true,
      setting: 'CONTENT_ARCHIVE_ENABLED',
      switchOn: false,
      jobBuilt: false,
      year: 2026,
      archived: false,
      wouldStart: false,
      blockers: ['switch-off'],
      latestBackup: { runId: SUNDAY, containers: 1 },
      classification: { asIs: 50, leftOut: 18, unclassified: expect.arrayContaining(['tool_exports']) },
      latest: null,
    });
  });

  it('GET: an archive container that cannot be read is "not known", never "not archived"', async () => {
    const warn = vi.fn();
    const { handlers } = make({
      env: { CONTENT_ARCHIVE_ENABLED: 'true' },
      archiveBlobs: { readJson: async () => Promise.reject(Object.assign(new Error('secret words'), { code: 'AuthorizationFailure' })) },
    });
    const answer = body(await handlers.getStatus({}, { warn }));
    expect(answer).toMatchObject({ switchOn: true, archived: null, wouldStart: false, blockers: ['archive-not-readable'] });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret words');
  });

  it('GET: a year that has its manifest is archived', async () => {
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true' }, archiveBlobs: { readJson: async (name) => (name === '2026/manifest.json' ? {} : null) } });
    expect(body(await handlers.getStatus({}, {}))).toMatchObject({ archived: true, blockers: ['already-archived'] });
  });

  it('POST: queues the jobs in one message list and writes one audit row of numbers', async () => {
    const enqueue = vi.fn();
    const { handlers, audit } = make();
    const response = await handlers.startDryRun({}, {}, { enqueue });
    expect(response.status).toBe(202);
    expect(body(response)).toEqual({ ok: true, started: true, sourceBackup: SUNDAY, queued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual([{ jobId: 'made-up-uuid', type: REPORT_JOB_TYPE }]);
    const rows = audit.filter((row) => row.container === 'admin_audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0].doc).toMatchObject({ action: DRY_RUN_AUDIT_ACTION, details: { sourceBackup: SUNDAY, containersQueued: 1 } });
  });

  it('POST: 409 with a sentence when there is no backup or the minute is taken; 500 with no queue', async () => {
    const none = make({ blobs: memoryBlobs() });
    const noBackup = await none.handlers.startDryRun({}, {}, { enqueue: vi.fn() });
    expect(noBackup.status).toBe(409);
    expect(body(noBackup).error).toBe('no_backup');
    expect(none.audit).toEqual([]);

    const twice = make();
    await twice.handlers.startDryRun({}, {}, { enqueue: vi.fn() });
    const second = await twice.handlers.startDryRun({}, {}, { enqueue: vi.fn() });
    expect(second.status).toBe(409);
    expect(body(second).error).toBe('already_started');
    expect(twice.audit.filter((row) => row.container === 'admin_audit_logs')).toHaveLength(1);

    expect((await make().handlers.startDryRun({}, { error: vi.fn() }, {})).status).toBe(500);
  });

  it('a failure answers 500 without the store’s words', async () => {
    const { handlers } = make({ blobs: { readJson: async () => Promise.reject(new Error('account stsecretname refused')) } });
    const response = await handlers.getStatus({ headers: new Map() }, { error: vi.fn(), warn: vi.fn(), log: vi.fn() });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('stsecretname');
  });
});

it('reportIdFor is the UTC minute', () => {
  expect(reportIdFor(new Date('2027-02-08T04:00:59.999Z'))).toBe('20270208T0400Z');
});
