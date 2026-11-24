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
  MAX_NAME_LENGTH,
  REPORT_JOB_TYPE,
  REPORT_KEEP_DAYS,
  RUN_STALE_MINUTES,
  isPlainName,
  listableNames,
  nameThreshold,
  reportIdTime,
  sensitiveNamesIn,
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
    deleted: [],
    async deleteReportFile(name) {
      if (!name.startsWith('state/archive-report/')) throw new Error('not a report file');
      files.delete(name);
      this.deleted.push(name);
    },
  };
}

/**
 * The archive's own blob container, as storage really answers. A file that
 * is not there reads as `null` whether or not the container exists (that is
 * what blob-storage.js readBlobForDelivery does with any "not found"), so
 * only `containerExists` can tell the two apart.
 */
function archiveStore({ exists = true, manifests = [], failExists = null, failRead = null } = {}) {
  return {
    async containerExists() {
      if (failExists) throw failExists;
      return exists;
    },
    async readJson(name) {
      if (failRead) throw failRead;
      return exists && manifests.includes(name) ? {} : null;
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
  const facts = (over = {}) => ({ env: on, now: new Date('2027-02-08T04:00:00Z'), containerExists: true, manifestExists: false, backupRunId: '2027-02-07', ...over });

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

  it('never starts while the archive container is missing or could not be asked about, whatever the manifest says', () => {
    // "No manifest" in a container that is not there is not "not archived yet".
    expect(archiveStartDecision(facts({ containerExists: false, manifestExists: false }))).toMatchObject({
      start: false,
      blockers: ['archive-container-missing'],
    });
    for (const containerExists of [null, undefined, 'yes', 1]) {
      expect(archiveStartDecision(facts({ containerExists, manifestExists: false }))).toMatchObject({
        start: false,
        blockers: ['archive-not-readable'],
      });
    }
  });

  it('lists every blocker at once', () => {
    const decision = archiveStartDecision({ env: {}, now: new Date('2027-01-15T00:00:00Z'), containerExists: true, manifestExists: true, backupRunId: null });
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
      { id: 'c1', docType: 'cfs-call', organizerName: 'Example Organizer' },
      { id: 'p1', docType: 'cfs-submission', speakerName: 'Example Speaker', speakerEmail: 'speaker@example.com', 'made-up-odd-field': 1 },
    ],
    admin_config: [{ id: 'reminders' }, { id: 'developer_api_key:k1', keyHash: 'made-up' }, { id: 'health_pulse' }, { id: 'added_later' }],
    tool_workspaces: [
      { id: 't1', visitorId: 'made-up-visitor', notes: 'typed by someone', _ts: 1, settings: { providers: [{ apiKey: 'made-up-nested-key' }] } },
      { id: 't2', notes: 'more', 'a name with spaces': 1, user_12345: { a: 1 }, 'jane.doe': 1, 'aaaaaaaa-0000-4000-8000-000000000001': 1 },
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
    expect(of('developer_events')).toMatchObject({ read: 2, kept: 2, changed: 2 });
    // A removed field is named only when this repository wrote the name; any other is "(other fields)".
    expect(of('developer_events').removed).toEqual({ organizerName: 1, speakerName: 1, speakerEmail: 1, '(other fields)': 1 });
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
      // Two names are in both records. The other six uses are names only one
      // record has, or names shaped like an id or typed text: counted, not printed.
      otherNames: 6,
      fieldNamesTruncated: false,
      fieldNames: [
        { name: 'id', records: 2 },
        { name: 'notes', records: 2 },
      ],
      sensitive: { records: 1, keptRecords: 0, names: [{ name: 'apiKey', records: 1 }], namesNotShown: 0, cutShort: 0 },
    });
    // Every container that was read carries field names and the count, not only the unclassified ones.
    for (const part of report.containers) {
      expect(Array.isArray(part.fieldNames), part.container).toBe(true);
      expect(part.sensitive, part.container).toMatchObject({ records: expect.any(Number), keptRecords: expect.any(Number) });
    }
    expect(of('blogs').fieldNames).toEqual([{ name: 'id', records: 2 }]);
    expect(of('admin_config').sensitive).toMatchObject({ records: 1, keptRecords: 0, names: [{ name: 'keyHash', records: 1 }] });
    expect(of('developer_events').sensitive).toMatchObject({ records: 1, keptRecords: 0, names: [{ name: 'speakerEmail', records: 1 }] });
    expect(report.leftOutWhole).toEqual([{ container: 'admins', reason: 'access-list', backupDocs: 1 }]);
    expect(report.notInBackup.map((c) => c.container)).toContain('jobs');
    expect(report.totals).toMatchObject({ containersRead: 6, read: 17, kept: 8, changed: 2, leftOut: 8, unreadable: 1, mismatched: 0, sensitiveRecords: 3, sensitiveKeptRecords: 0 });
    expect(report.sourceBackup).toEqual({ mode: 'full', runId: SUNDAY });
  });

  it('never stores a value, an id, or a field name that is shaped like one', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    await runAll(blobs);
    const everything = JSON.stringify([...blobs.files].filter(([name]) => name.startsWith('state/')));
    for (const value of [
      'made-up-visitor',
      'typed by someone',
      'Example Speaker',
      'Example Organizer',
      'speaker@example.com',
      'a name with spaces',
      'made-up-admin',
      'b1',
      'developer_api_key',
      'made-up-oid',
      'made-up-nested-key',
      // Field names that are ids, an address-like name, and a name only one record has.
      'user_12345',
      'jane.doe',
      'aaaaaaaa',
      'visitorId',
      'made-up-odd-field',
    ]) {
      expect(everything, value).not.toContain(value);
    }
  });

  it('prints no field name at all for a container with one record: it only counts', async () => {
    const blobs = memoryBlobs(backupSeed({ config_settings: [{ id: 'only', provider: 'x', 'made-up-visitor-key': 1 }] }));
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    expect(report.containers[0]).toMatchObject({ read: 1, fieldNames: [], otherNames: 3 });
  });

  it('prints a name only when at least 1 record in 100 carries it', async () => {
    const docs = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, ...(i < 3 ? { commonEnough: 1 } : {}), ...(i < 2 ? { tooRare: 1 } : {}) }));
    const blobs = memoryBlobs(backupSeed({ config_settings: docs }));
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    expect(report.containers[0].fieldNames).toEqual([
      { name: 'id', records: 300 },
      { name: 'commonEnough', records: 3 },
    ]);
    expect(report.containers[0].otherNames).toBe(2);
  });

  it('a record shaped as a list keyed by visitor id puts no id in the report', async () => {
    const byVisitor = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`visitor_${10000 + i}`, { note: 'typed' }]));
    const blobs = memoryBlobs(backupSeed({ tool_exports: [{ id: 'a', ...byVisitor(50) }, { id: 'b', ...byVisitor(50) }] }));
    await runAll(blobs);
    const { report } = await readLatestReport({ blobs });
    expect(report.containers[0].fieldNames).toEqual([{ name: 'id', records: 2 }]);
    expect(report.containers[0].otherNames).toBe(100);
    expect(JSON.stringify([...blobs.files].filter(([name]) => name.startsWith('state/')))).not.toContain('visitor_1');
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
    const blobs = memoryBlobs(backupSeed({ config_settings: [wide, wide] }));
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
    const young = await readLatestReport({ blobs, now: new Date('2027-02-08T04:10:00Z') });
    expect(young).toMatchObject({ complete: false, done: 1, expected: 6, sourceRun: SUNDAY, stalled: false });
    expect(young.missing).toHaveLength(5);
    expect(young.missing).not.toContain(jobs[0].payload.container);

    // A second press while that run is young starts nothing and writes nothing.
    const writesBefore = blobs.writes.length;
    const upsertDoc = vi.fn();
    const enqueue = vi.fn();
    const again = await createReportScheduler({ store: { upsertDoc }, blobs, enqueue, now: () => new Date('2027-02-08T04:29:00Z') }).start();
    expect(again).toEqual({ started: false, reason: 'in-progress', reportId: '20270208T0400Z' });
    expect(upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(blobs.writes.length).toBe(writesBefore);

    // Past the limit the run "did not finish": it says which containers are missing, and a new one may start.
    const late = new Date(Date.parse('2027-02-08T04:00:00Z') + RUN_STALE_MINUTES * 60 * 1000);
    expect(await readLatestReport({ blobs, now: late })).toMatchObject({ complete: false, stalled: true, done: 1 });
    const restart = await createReportScheduler({ store: { upsertDoc }, blobs, enqueue, now: () => late }).start();
    expect(restart).toMatchObject({ started: true, reportId: '20270208T0430Z', queued: 6 });
    expect((await readLatestReport({ blobs, now: late })).reportId).toBe('20270208T0430Z');
  });

  it('a start that breaks while the job rows are written leaves the report before it as the newest', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    await runAll(blobs, new Date('2027-02-08T04:00:30Z'));
    let rows = 0;
    const broken = createReportScheduler({
      store: {
        upsertDoc: async () => {
          rows += 1;
          if (rows === 3) throw new Error('the database refused');
        },
      },
      blobs,
      enqueue: vi.fn(),
      now: () => new Date('2027-02-08T06:00:00Z'),
    });
    await expect(broken.start()).rejects.toThrow('the database refused');
    // Nothing reads as "running": the card still shows the finished report.
    expect(await readLatestReport({ blobs, now: new Date('2027-02-08T06:00:30Z') })).toMatchObject({
      reportId: '20270208T0400Z',
      complete: true,
    });
    // And the button works again a minute later.
    const retry = await createReportScheduler({ store: { upsertDoc: vi.fn() }, blobs, enqueue: vi.fn(), now: () => new Date('2027-02-08T06:01:00Z') }).start();
    expect(retry).toMatchObject({ started: true, reportId: '20270208T0601Z' });
  });

  it('deletes reports older than the keep time when a new one starts, and nothing else', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    const old = reportNames('20261101T0000Z');
    const recent = reportNames('20270201T0000Z');
    blobs.files.set(old.run, { containers: [] });
    blobs.files.set(old.report, { reportId: '20261101T0000Z' });
    blobs.files.set(reportNames('20261101T0000Z', 'blogs').part, {});
    blobs.files.set(recent.report, { reportId: '20270201T0000Z' });
    blobs.files.set('state/archive-report/not-a-report/x.json', {});
    blobs.files.set('state/continuation/blogs.json', { token: 'made-up' });
    const at = new Date('2027-02-08T04:00:30Z');
    expect((at.getTime() - reportIdTime('20261101T0000Z')) / 86400000).toBeGreaterThan(REPORT_KEEP_DAYS);
    const { started } = await runAll(blobs, at);
    expect(started.removedReports).toBe(1);
    expect(blobs.deleted.sort()).toEqual([old.report, old.run, reportNames('20261101T0000Z', 'blogs').part].sort());
    for (const kept of [recent.report, 'state/archive-report/not-a-report/x.json', 'state/continuation/blogs.json', `full/${SUNDAY}/manifest.json`, reportNames('x').latest]) {
      expect(blobs.files.has(kept), kept).toBe(true);
    }
  });

  it('a failed clean-up of old reports does not fail the dry run that started', async () => {
    const blobs = memoryBlobs(backupSeed(containers));
    blobs.files.set(reportNames('20261101T0000Z').run, {});
    blobs.deleteReportFile = async () => {
      throw new Error('refused');
    };
    const { started } = await runAll(blobs);
    expect(started).toMatchObject({ started: true, removedReports: 0 });
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
      archiveBlobs: archiveStore(),
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
      archiveContainerExists: true,
      archived: false,
      wouldStart: false,
      blockers: ['switch-off'],
      latestBackup: { runId: SUNDAY, containers: 1 },
      classification: { asIs: 33, leftOut: 19, unclassified: expect.arrayContaining(['tool_exports', 'site_settings']) },
      latest: null,
      reports: { container: 'cosmos-export-state', prefix: 'state/archive-report/', keepDays: REPORT_KEEP_DAYS, staleMinutes: RUN_STALE_MINUTES },
    });
    expect(body(response).classification.unclassified).toHaveLength(21);
    expect(body(response).classification.changed.find((c) => c.container === 'mcp_servers').keeps).toContain('url');
  });

  it('GET: a container that does not exist yet is "not known", never "not archived", with every other condition met', async () => {
    // The realistic case: storage answers "not found" for the manifest, exactly as it would for a year with no archive.
    const missing = archiveStore({ exists: false });
    expect(await missing.readJson('2026/manifest.json')).toBeNull();
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true' }, archiveBlobs: missing });
    expect(body(await handlers.getStatus({}, {}))).toMatchObject({
      switchOn: true,
      archiveContainerExists: false,
      archived: null,
      wouldStart: false,
      blockers: ['archive-container-missing'],
    });
    // The same facts with the container there: the year really is not archived, and only then could a run start.
    const there = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true' }, archiveBlobs: archiveStore({ exists: true }) });
    expect(body(await there.handlers.getStatus({}, {}))).toMatchObject({ archiveContainerExists: true, archived: false, wouldStart: true, blockers: [] });
  });

  it('GET: an archive container that cannot be asked about or read is "not known", and the far end\'s words are not logged', async () => {
    const refused = Object.assign(new Error('secret words'), { code: 'AuthorizationFailure' });
    for (const archiveBlobs of [archiveStore({ failExists: refused }), archiveStore({ failRead: refused })]) {
      const warn = vi.fn();
      const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true' }, archiveBlobs });
      const answer = body(await handlers.getStatus({}, { warn }));
      expect(answer).toMatchObject({ switchOn: true, archived: null, wouldStart: false, blockers: ['archive-not-readable'] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('secret words');
    }
  });

  it('GET: a year that has its manifest is archived', async () => {
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true' }, archiveBlobs: archiveStore({ manifests: ['2026/manifest.json'] }) });
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

    // A second press while the first run is still reading: refused with a sentence the card shows.
    const twice = make();
    await twice.handlers.startDryRun({}, {}, { enqueue: vi.fn() });
    const second = await twice.handlers.startDryRun({}, {}, { enqueue: vi.fn() });
    expect(second.status).toBe(409);
    expect(body(second)).toMatchObject({ ok: false, error: 'in_progress', message: expect.stringContaining('still reading') });
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

describe('which field names may be printed', () => {
  it('a plain name is a short programmer’s name: no id, no address, no typed text', () => {
    for (const name of ['id', 'title', 'createdAt', 'speaker_name', 'content-type', 'v2Notes', 'x'.repeat(MAX_NAME_LENGTH)]) {
      expect(isPlainName(name), name).toBe(true);
    }
    for (const name of [
      'user_12345',
      'visitor2026',
      'jane.doe',
      'jane@example.com',
      'a name with spaces',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'abcdef0123456789abcdef',
      'deadbeefcafe',
      '_private',
      '9lives',
      '',
      'x'.repeat(MAX_NAME_LENGTH + 1),
      null,
      7,
    ]) {
      expect(isPlainName(name), String(name)).toBe(false);
    }
  });

  it('a name must be in at least 2 records, and at least 1 in 100', () => {
    expect([0, 1, 2, 100, 200, 201, 5000].map(nameThreshold)).toEqual([2, 2, 2, 2, 2, 3, 50]);
    const tally = new Map([['id', 5000], ['rare', 49], ['enough', 50]]);
    expect(listableNames(tally, 5000).names.map((n) => n.name)).toEqual(['id', 'enough']);
    expect(listableNames(new Map([['only', 1]]), 1)).toEqual({ names: [], truncated: false });
    const many = new Map(Array.from({ length: 7 }, (_, i) => [`n${i}`, 10 - i]));
    expect(listableNames(many, 10, 3)).toEqual({ names: [{ name: 'n0', records: 10 }, { name: 'n1', records: 9 }, { name: 'n2', records: 8 }], truncated: true });
  });
});

describe('sensitiveNamesIn: names that look like a secret, at any depth, and never a value', () => {
  it('finds a nested name inside objects and lists', () => {
    const found = sensitiveNamesIn({ id: 'x', a: { b: [{ c: { refreshToken: 'made-up-value-1' } }] }, list: [{ email: 'made-up-value-2' }], plain: 'made-up-value-3' });
    expect([...found.names].sort()).toEqual(['email', 'refreshToken']);
    expect(found.cutShort).toBe(false);
    expect(JSON.stringify([...found.names])).not.toContain('made-up-value');
  });

  it('reads names, not values: a value that looks like a secret is not a finding', () => {
    expect(sensitiveNamesIn({ note: 'my password is token secret' }).names.size).toBe(0);
    expect(sensitiveNamesIn('token').names.size).toBe(0);
    expect(sensitiveNamesIn(null).names.size).toBe(0);
  });

  it('stops at its limits on a very deep or very large record, and says so', () => {
    let deep = { token: 'made-up' };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(sensitiveNamesIn(deep)).toMatchObject({ cutShort: true });
    const wide = { items: Array.from({ length: 20000 }, () => ({ a: 1 })) };
    expect(sensitiveNamesIn(wide).cutShort).toBe(true);
  });

  it('the report counts a record once however many such names it has, and counts an id-shaped name without printing it', async () => {
    const docs = [
      { id: 'a', token: 'made-up-1', nested: { password: 'made-up-2' } },
      { id: 'b', token_12345678: 'made-up-3' },
      { id: 'c' },
    ];
    const blobs = memoryBlobs(backupSeed({ config_providers: docs }));
    const jobs = [];
    const at = new Date('2027-02-08T04:00:30Z');
    await createReportScheduler({ store: { upsertDoc: async (_c, doc) => jobs.push(doc) }, blobs, enqueue: () => {}, now: () => at }).start();
    await createReportWorker({ blobs, now: () => at }).readContainer(parseReportPayload(jobs[0].payload));
    const { report } = await readLatestReport({ blobs, now: at });
    expect(report.containers[0].sensitive).toEqual({
      records: 2,
      keptRecords: 0,
      names: [
        { name: 'password', records: 1 },
        { name: 'token', records: 1 },
      ],
      namesNotShown: 1,
      cutShort: 0,
    });
    expect(report.totals.sensitiveRecords).toBe(2);
    const stored = JSON.stringify([...blobs.files].filter(([name]) => name.startsWith('state/')));
    expect(stored).not.toContain('made-up-');
    expect(stored).not.toContain('token_12345678');
  });

  it('counts a kept record that still carries such a name, so the owner sees it before anything is archived', async () => {
    const blobs = memoryBlobs(backupSeed({ blogs: [{ id: 'b1', authorEmail: 'made-up@example.com' }, { id: 'b2' }] }));
    const jobs = [];
    const at = new Date('2027-02-08T04:00:30Z');
    await createReportScheduler({ store: { upsertDoc: async (_c, doc) => jobs.push(doc) }, blobs, enqueue: () => {}, now: () => at }).start();
    await createReportWorker({ blobs, now: () => at }).readContainer(parseReportPayload(jobs[0].payload));
    const { report } = await readLatestReport({ blobs, now: at });
    expect(report.containers[0].sensitive).toMatchObject({ records: 1, keptRecords: 1, names: [{ name: 'authorEmail', records: 1 }] });
    expect(report.totals.sensitiveKeptRecords).toBe(1);
  });
});
