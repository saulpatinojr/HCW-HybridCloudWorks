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
  sensitiveFieldsIn,
  sensitiveNamesIn,
  valueKind,
  archiveStartDecision,
  archiveYearFor,
  createReportScheduler,
  createReportWorker,
  findLatestFullBackup,
  isUnnamedContainer,
  gzipLines,
  parseReportPayload,
  readLatestReport,
  reportContainers,
  reportGate,
  reportIdFor,
  reportNames,
} from './archive-report.js';
import {
  AI_PROVIDER_KEEP,
  MCP_SERVER_KEEP,
  SENSITIVE_KEPT_ON_PURPOSE,
  archiveDocumentLabel,
  archivePlan,
  classificationFingerprint,
  UNCLASSIFIED,
} from './archive-classification.js';
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
    async listDetails() {
      if (failRead) throw failRead;
      return exists ? manifests.map((name) => ({ name, size: 2, tier: 'Hot' })) : [];
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
  const on = { [ARCHIVE_SETTING]: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' };
  const facts = (over = {}) => ({ env: on, now: new Date('2027-02-08T04:00:00Z'), containerExists: true, manifestExists: false, backupRunId: '2027-02-07', reportBlockers: [], ...over });

  it('starts when every condition holds, for the year before', () => {
    expect(archiveStartDecision(facts())).toEqual({ start: true, year: 2026, earliestBackup: '2027-02-02', blockers: [] });
    expect(archiveYearFor(new Date('2027-12-31T23:59:59Z'))).toBe(2026);
    expect(archiveYearFor(new Date('2028-01-01T00:00:00Z'))).toBe(2027);
  });

  it('does not start while the switch is off, absent, or anything but the exact text true', () => {
    for (const value of [undefined, 'false', '', 'TRUE', '1', 'true ']) {
      const decision = archiveStartDecision(facts({ env: { ...on, [ARCHIVE_SETTING]: value } }));
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

  it('does not start while the nightly export is off: its timer makes the daily check, and its backup is what is read', () => {
    for (const env of [{ ...on, FEATURE_FLAG_COSMOS_EXPORT: 'false' }, { [ARCHIVE_SETTING]: 'true' }, { ...on, FEATURE_FLAG_SCHEDULERS: 'false' }]) {
      expect(archiveStartDecision(facts({ env }))).toMatchObject({ start: false, blockers: ['export-off'] });
    }
  });

  it('lists every blocker at once', () => {
    const decision = archiveStartDecision({ env: {}, now: new Date('2027-01-15T00:00:00Z'), containerExists: true, manifestExists: true, backupRunId: null });
    expect(decision.blockers).toEqual(['switch-off', 'export-off', 'before-1-february', 'already-archived', 'no-backup', 'report-missing']);
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
    // A container the classification does not name at all is read too, as one that is waiting,
    // but only when its name is shaped like a container's name (it becomes part of a file name).
    expect(parseReportPayload({ ...ok, container: 'a_new_container' }).container).toBe('a_new_container');
    expect(isUnnamedContainer('a_new_container')).toBe(true);
    for (const container of ['../blogs', 'a/b', 'a.b', '', 'x'.repeat(80), 'blogs', 'admins']) {
      expect(isUnnamedContainer(container), container).toBe(false);
    }
    for (const container of ['../x', 'a/b', 'state/x']) expect(() => parseReportPayload({ ...ok, container })).toThrow();
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
    made_up_waiting: [
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
      'made_up_waiting',
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
    expect(of('made_up_waiting')).toMatchObject({
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

  it('GET: switch off, the blockers and the classification in numbers', async () => {
    const response = await make().handlers.getStatus({}, {});
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    expect(body(response)).toMatchObject({
      ok: true,
      setting: 'CONTENT_ARCHIVE_ENABLED',
      switchOn: false,
      jobBuilt: true,
      exportOn: false,
      year: 2026,
      archiveContainerExists: true,
      archived: false,
      wouldStart: false,
      blockers: ['switch-off', 'export-off', 'report-missing'],
      progressKnown: true,
      lastArchive: null,
      run: null,
      latestBackup: { runId: SUNDAY, containers: 1 },
      classification: { asIs: 54, leftOut: 19, unclassified: [], ownerAccepted: { date: '2026-11-24', wereWaiting: 21 } },
      latest: null,
      reports: { container: 'cosmos-export-state', prefix: 'state/archive-report/', keepDays: REPORT_KEEP_DAYS, staleMinutes: RUN_STALE_MINUTES },
    });
    expect(body(response).classification.ownerAccepted.containers).toEqual(expect.arrayContaining(['tool_exports', 'site_settings', 'blogs']));
    expect(body(response).classification.changed.find((c) => c.container === 'mcp_servers').keeps).toContain('url');
  });

  it('GET: a container that does not exist yet is "not known", never "not archived", with every other condition met', async () => {
    // The realistic case: storage answers "not found" for the manifest, exactly as it would for a year with no archive.
    const missing = archiveStore({ exists: false });
    expect(await missing.readJson('2026/manifest.json')).toBeNull();
    // A finished dry-run report of the same backup that shows nothing to decide.
    const withReport = () => {
      const blobs = memoryBlobs(backupSeed({ blogs: [{ id: 'b1' }] }));
      const id = '20270207T2000Z';
      blobs.files.set(reportNames(id).latest, { reportId: id });
      blobs.files.set(reportNames(id).report, {
        reportId: id,
        sourceBackup: { runId: SUNDAY },
        rules: classificationFingerprint(),
        totals: {},
        // One part for the one container the backup holds that an archive would write.
        containers: [{ container: 'blogs', decision: 'archive', reason: null, read: 1, matchesBackup: true, sensitive: { remaining: [], flagged: 0, cutShort: 0 } }],
        leftOutWhole: [],
      });
      return blobs;
    };
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs: missing, blobs: withReport() });
    expect(body(await handlers.getStatus({}, {}))).toMatchObject({
      switchOn: true,
      archiveContainerExists: false,
      archived: null,
      wouldStart: false,
      blockers: ['archive-container-missing'],
    });
    // The same facts with the container there: the year really is not archived, and only then could a run start.
    const there = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs: archiveStore({ exists: true }), blobs: withReport() });
    // Without that report, the same facts do not start: the report is its own condition.
    const noReport = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs: archiveStore({ exists: true }) });
    expect(body(await noReport.handlers.getStatus({}, {}))).toMatchObject({ wouldStart: false, blockers: ['report-missing'] });
    expect(body(await there.handlers.getStatus({}, {}))).toMatchObject({ archiveContainerExists: true, archived: false, wouldStart: true, blockers: [], cutShort: [] });
  });

  it('GET: a report that met a record too large to search whole names the container and the count, and nothing else', async () => {
    const blobs = memoryBlobs(backupSeed({ blogs: [{ id: 'b1' }] }));
    const id = '20270207T2000Z';
    blobs.files.set(reportNames(id).latest, { reportId: id });
    blobs.files.set(reportNames(id).report, {
      reportId: id,
      sourceBackup: { runId: SUNDAY },
      rules: classificationFingerprint(),
      totals: {},
      containers: [{ container: 'blogs', decision: 'archive', reason: null, read: 1, matchesBackup: true, sensitive: { remaining: [], flagged: 0, cutShort: 1 } }],
      leftOutWhole: [],
    });
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs: archiveStore({ exists: true }), blobs });
    expect(body(await handlers.getStatus({}, {}))).toMatchObject({ wouldStart: false, blockers: ['report-cut-short'], cutShort: [{ container: 'blogs', records: 1 }] });
  });

  it('GET: an archive container that cannot be asked about or read is "not known", and the far end\'s words are not logged', async () => {
    const refused = Object.assign(new Error('secret words'), { code: 'AuthorizationFailure' });
    for (const archiveBlobs of [archiveStore({ failExists: refused }), archiveStore({ failRead: refused })]) {
      const warn = vi.fn();
      const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs });
      const answer = body(await handlers.getStatus({}, { warn }));
      expect(answer).toMatchObject({ switchOn: true, archived: null, wouldStart: false, blockers: ['archive-not-readable', 'report-missing'] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('secret words');
    }
  });

  it('GET: a year that has its manifest is archived', async () => {
    const { handlers } = make({ env: { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, archiveBlobs: archiveStore({ manifests: ['2026/manifest.json'] }) });
    expect(body(await handlers.getStatus({}, {}))).toMatchObject({ archived: true, blockers: ['already-archived', 'report-missing'] });
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

  it('stops at its limits on a very deep or very large record, and says so (the exact edges are in archive-report-limits.test.js)', () => {
    let deep = { token: 'made-up' };
    for (let i = 0; i < 200; i += 1) deep = { next: deep };
    expect(sensitiveNamesIn(deep)).toMatchObject({ cutShort: true });
    const wide = { items: Array.from({ length: 800000 }, () => ({})) };
    expect(sensitiveNamesIn(wide).cutShort).toBe(true);
  });

  it('the report counts a record once however many such names it has, and counts an id-shaped name without printing it', async () => {
    const docs = [
      // The nested value is a number on purpose: only the NAME is read, and a
      // secret scanner reads a quoted word beside the name `password` as a real one.
      { id: 'a', token: 'made-up-1', nested: { password: 2 } },
      { id: 'b', token_12345678: 'made-up-3' },
      { id: 'c' },
    ];
    const blobs = memoryBlobs(backupSeed({ made_up_waiting: docs }));
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
      // The container is left out, so every name is taken out and none remains.
      takenOut: [
        { name: 'password', records: 1 },
        { name: 'token', records: 1 },
      ],
      takenOutNotShown: { notPlain: 1, tooMany: 0 },
      remaining: [],
      remainingNotShown: { notPlain: 0, tooMany: 0 },
      flagged: 0,
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

describe('names that look like a secret: which are taken out, which would remain, and what kind of value they hold', () => {
  const at = new Date('2027-02-08T04:00:30Z');
  /** The dry run's part for one container, and everything the run stored. */
  async function partFor(container, docs) {
    const blobs = memoryBlobs(backupSeed({ [container]: docs }));
    const jobs = [];
    await createReportScheduler({ store: { upsertDoc: async (_c, doc) => jobs.push(doc) }, blobs, enqueue: () => {}, now: () => at }).start();
    await createReportWorker({ blobs, now: () => at }).readContainer(parseReportPayload(jobs[0].payload));
    const { report } = await readLatestReport({ blobs, now: at });
    const stored = JSON.stringify([...blobs.files].filter(([name]) => name.startsWith('state/')));
    return { part: report.containers[0], report, stored };
  }
  const entry = (part, path, document) => part.sensitive.remaining.find((e) => e.path === path && (document === undefined || e.document === document));

  it('valueKind names the kind and never the value', () => {
    expect(valueKind(12)).toBe('number');
    expect(valueKind(true)).toBe('yes-no');
    expect(valueKind('2026-11-24')).toBe('date');
    expect(valueKind('2026-11-24T10:00:00.000Z')).toBe('date');
    expect(valueKind('x'.repeat(63))).toBe('short-text');
    expect(valueKind('x'.repeat(64))).toBe('long-text');
    expect(valueKind([1])).toBe('list');
    expect(valueKind({ a: 1 })).toBe('object');
    for (const nothing of [null, undefined, '']) expect(valueKind(nothing)).toBe('empty');
  });

  it('sensitiveFieldsIn gives the path as parent field names, with (id) for a part that is not a plain name', () => {
    const { fields } = sensitiveFieldsIn({
      email: 'made-up@example.com',
      profile: { contact: { phone: 'made-up-phone' } },
      people: [{ email: 'made-up-1@example.com' }, { email: 7 }],
      'visitor_12345678': { token: 'made-up-token' },
      byVisitor: { '11111111-0000-0000-0000-000000000001': { apiKey: 'made-up-key' } },
      note: 'the word password in a value is not a field name',
    });
    expect([...fields.values()]).toEqual([
      { name: 'email', path: 'email', plain: true, kinds: { 'short-text': 1 } },
      { name: 'apiKey', path: 'byVisitor.(id).apiKey', plain: true, kinds: { 'short-text': 1 } },
      { name: 'token', path: '(id).token', plain: true, kinds: { 'short-text': 1 } },
      { name: 'email', path: 'people.email', plain: true, kinds: { 'short-text': 1, number: 1 } },
      { name: 'phone', path: 'profile.contact.phone', plain: true, kinds: { 'short-text': 1 } },
    ]);
    const text = JSON.stringify([...fields.values()]);
    for (const leaked of ['made-up', 'visitor_12345678', '11111111']) expect(text).not.toContain(leaked);
    // A sensitive name that is itself shaped like an id is marked, so the report counts it and does not print it.
    expect([...sensitiveFieldsIn({ token_12345678: 'x' }).fields.values()]).toEqual([{ name: 'token_12345678', path: '(id)', plain: false, kinds: { 'short-text': 1 } }]);
  });

  it('a kept container: names that would remain come with their path, record count and kinds, and drive the flag', async () => {
    const { part, report, stored } = await partFor('blogs', [
      { id: 'b1', email: 'made-up-1@example.com', emailVerified: true, usage: { totalTokens: 12 }, author: { requestHash: 'made-up-hash' } },
      { id: 'b2', email: 'made-up-2@example.com', emailVerified: false, usage: { totalTokens: 40 }, author: { requestHash: 'x'.repeat(80) } },
      { id: 'b3', emailVerified: null },
    ]);
    expect(part.sensitive.takenOut).toEqual([]);
    expect(entry(part, 'email')).toEqual({ document: null, path: 'email', name: 'email', records: 2, kinds: { 'short-text': 2 }, quiet: false, keptOnPurpose: null, flagged: true });
    expect(entry(part, 'author.requestHash')).toMatchObject({ records: 2, kinds: { 'short-text': 1, 'long-text': 1 }, flagged: true });
    // Only numbers, or only true/false (an empty one beside them does not change that): listed, not flagged.
    expect(entry(part, 'usage.totalTokens')).toMatchObject({ records: 2, kinds: { number: 2 }, quiet: true, flagged: false });
    expect(entry(part, 'emailVerified')).toMatchObject({ records: 3, kinds: { 'yes-no': 2, empty: 1 }, quiet: true, flagged: false });
    expect(part.sensitive.flagged).toBe(2);
    // Flagged names come first.
    expect(part.sensitive.remaining.slice(0, 2).every((e) => e.flagged)).toBe(true);
    expect(report.totals.flaggedContainers).toBe(1);
    for (const leaked of ['made-up', 'xxxxxxxx']) expect(stored).not.toContain(leaked);
  });

  it('a kept container whose only such names hold numbers or true/false is not flagged at all', async () => {
    const { part, report } = await partFor('ai_usage', [
      { id: 'u1', promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      { id: 'u2', promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    ]);
    expect(part.sensitive.keptRecords).toBe(2);
    expect(part.sensitive.remaining.map((e) => [e.path, e.quiet, e.flagged])).toEqual([
      ['completionTokens', true, false],
      ['promptTokens', true, false],
      ['totalTokens', true, false],
    ]);
    expect(part.sensitive.flagged).toBe(0);
    expect(report.totals.flaggedContainers).toBe(0);
  });

  it('separates what is taken out from what would remain, in a container kept in part', async () => {
    const { part, stored } = await partFor('mcp_servers', [
      { id: 'm1', name: 'A server', apiKeyEnvVar: 'SOME_SETTING_NAME', oauthToken: 'made-up-token', headers: { Authorization: 'Bearer made-up-bearer' } },
      { id: 'm2', name: 'Another', apiKeyEnvVar: 'made-up-real-key-not-a-setting-name', oauthRefreshToken: 'made-up-refresh' },
    ]);
    expect(part.sensitive.takenOut).toEqual([
      // m2's apiKeyEnvVar was not shaped like a setting's name, so it was dropped.
      { name: 'apiKeyEnvVar', records: 1 },
      { name: 'Authorization', records: 1 },
      { name: 'oauthRefreshToken', records: 1 },
      { name: 'oauthToken', records: 1 },
    ]);
    expect(part.sensitive.remaining).toEqual([
      {
        document: null,
        path: 'apiKeyEnvVar',
        name: 'apiKeyEnvVar',
        records: 1,
        kinds: { 'short-text': 1 },
        quiet: false,
        keptOnPurpose: SENSITIVE_KEPT_ON_PURPOSE.mcp_servers.apiKeyEnvVar,
        flagged: false,
      },
    ]);
    expect(part.sensitive.flagged).toBe(0);
    expect(stored).not.toContain('made-up');
    expect(stored).not.toContain('SOME_SETTING_NAME');
  });

  it('a name is "kept on purpose" only where the keep list shape-checks it as a setting’s name, and only at the top level', async () => {
    expect(Object.keys(SENSITIVE_KEPT_ON_PURPOSE).sort()).toEqual(['ai_providers', 'mcp_servers']);
    expect(MCP_SERVER_KEEP.apiKeyEnvVar).toBe('name');
    expect(AI_PROVIDER_KEEP.apiKeyEnvVar).toBe('name');
    for (const names of Object.values(SENSITIVE_KEPT_ON_PURPOSE)) expect(Object.keys(names)).toEqual(['apiKeyEnvVar']);
    // The same name in a container that does not shape-check it is flagged like any other.
    const { part } = await partFor('blogs', [{ id: 'b1', apiKeyEnvVar: 'made-up-key' }]);
    expect(entry(part, 'apiKeyEnvVar')).toMatchObject({ keptOnPurpose: null, flagged: true });
  });

  it('a name that would remain and cannot be printed is counted with the reason, and still raises the flag', async () => {
    const { part, stored } = await partFor('blogs', [{ id: 'b1', token_12345678: 'made-up-value' }, { id: 'b2', inner: { 'secret for jane@example.com': 1 } }]);
    expect(part.sensitive.remaining).toEqual([]);
    expect(part.sensitive.remainingNotShown).toEqual({ notPlain: 2, tooMany: 0 });
    expect(part.sensitive.flagged).toBe(1);
    expect(stored).not.toContain('token_12345678');
    expect(stored).not.toContain('jane@example.com');
  });

  it('every plain name that would remain is listed, however many there are', async () => {
    const doc = { id: 'b1' };
    for (let i = 0; i < 60; i += 1) doc[`secret${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`] = 'made-up';
    const { part } = await partFor('blogs', [doc]);
    expect(part.sensitive.remaining).toHaveLength(60);
    expect(part.sensitive.remainingNotShown).toEqual({ notPlain: 0, tooMany: 0 });
  });

  it('for admin_config and admin_settings a remaining name says which settings document it is in, when the code names that document', async () => {
    expect(archiveDocumentLabel('admin_config', 'credential_register')).toBe('credential_register');
    expect(archiveDocumentLabel('admin_config', 'community_days_event_made-up-id')).toBe('community_days_event_*');
    expect(archiveDocumentLabel('admin_config', 'developer_api_key:made-up')).toBe('(other)');
    expect(archiveDocumentLabel('admin_config', undefined)).toBe('(other)');
    expect(archiveDocumentLabel('admin_settings', 'integrations')).toBe('integrations');
    expect(archiveDocumentLabel('admin_settings', 'blog-source-made-up')).toBe('blog-source-*');
    expect(archiveDocumentLabel('blogs', 'made-up-id')).toBeNull();

    const { part, stored } = await partFor('admin_config', [
      { id: 'credential_register', rotated: { 'made-up-api-token': '2026-11-01', 'another-client-secret': '2026-10-01T08:00:00Z' } },
      { id: 'community_days_event_made-up-id', contactEmail: 'made-up@example.com' },
      { id: 'developer_api_key:made-up', keyHash: 'made-up-hash' },
    ]);
    expect(entry(part, 'rotated.made-up-api-token', 'credential_register')).toMatchObject({ records: 1, kinds: { date: 1 }, flagged: true });
    expect(entry(part, 'rotated.another-client-secret', 'credential_register')).toMatchObject({ kinds: { date: 1 } });
    expect(entry(part, 'contactEmail', 'community_days_event_*')).toMatchObject({ records: 1, kinds: { 'short-text': 1 } });
    // The key record is left out whole, so its name is taken out, not remaining.
    expect(part.sensitive.takenOut).toEqual([{ name: 'keyHash', records: 1 }]);
    expect(part.sensitive.remaining.every((e) => e.document !== '(other)')).toBe(true);
    for (const leaked of ['made-up-id', 'made-up-hash', 'made-up@example.com', 'developer_api_key:made-up']) expect(stored).not.toContain(leaked);
  });
});

describe('after the owner’s decision of 2026-11-24: nothing is waiting, and a new container still would be', () => {
  const at = new Date('2027-02-08T04:00:30Z');
  async function reportFor(containers) {
    const blobs = memoryBlobs(backupSeed(containers));
    const jobs = [];
    await createReportScheduler({ store: { upsertDoc: async (_c, doc) => jobs.push(doc) }, blobs, enqueue: () => {}, now: () => at }).start();
    for (const job of jobs) await createReportWorker({ blobs, now: () => at }).readContainer(parseReportPayload(job.payload));
    return (await readLatestReport({ blobs, now: at })).report;
  }

  it('the 21 that were waiting are read as kept, whole, and marked with the date the owner chose', async () => {
    const report = await reportFor({ tool_exports: [{ id: 't1', email: 'made-up@example.com', sessionId: 'made-up-session' }], site_settings: [{ id: 's1' }] });
    const part = report.containers.find((c) => c.container === 'tool_exports');
    expect(part).toMatchObject({ decision: 'archive', reason: null, read: 1, kept: 1, leftOut: 0, ownerAccepted: '2026-11-24' });
    // The name is still listed, with its kind, and still counted as flagged: the card does not go silent.
    expect(part.sensitive.remaining).toEqual([
      { document: null, path: 'email', name: 'email', records: 1, kinds: { 'short-text': 1 }, quiet: false, keptOnPurpose: null, flagged: true },
    ]);
    expect(part.sensitive.flagged).toBe(1);
    // ...but it is not counted among what is still to look at.
    expect(report.totals).toMatchObject({ flaggedContainers: 1, flaggedNotAccepted: 0 });
    expect(report.containers.every((c) => c.reason !== 'unclassified')).toBe(true);
  });

  it('a flagged container the decision does not cover is still to look at', async () => {
    const report = await reportFor({ newsletters: [{ id: 'n1', authorEmail: 'made-up@example.com' }] });
    expect(report.containers[0]).toMatchObject({ container: 'newsletters', ownerAccepted: null });
    expect(report.totals).toMatchObject({ flaggedContainers: 1, flaggedNotAccepted: 1 });
  });

  it('a container nobody has classified is read, left out whole, and reported as waiting', async () => {
    const report = await reportFor({ blogs: [{ id: 'b1' }], a_new_container: [{ id: 'x1', title: 'made up' }, { id: 'x2', title: 'made up too', apiKey: 'made-up-key' }] });
    const part = report.containers.find((c) => c.container === 'a_new_container');
    expect(part).toMatchObject({
      decision: 'leave-out',
      reason: 'unclassified',
      ownerAccepted: null,
      read: 2,
      kept: 0,
      leftOut: 2,
      leftOutBy: { unclassified: 2 },
      fieldNames: [
        { name: 'id', records: 2 },
        { name: 'title', records: 2 },
      ],
    });
    expect(part.sensitive.takenOut).toEqual([{ name: 'apiKey', records: 1 }]);
    expect(part.sensitive.remaining).toEqual([]);
    expect(report.leftOutWhole).toEqual([]);
  });
});

describe('reportGate: an archive never starts from a state no finished report describes', () => {
  // The backup holds two containers an archive would write, and one it leaves out.
  const BACKUP = ['blogs', 'newsletters', 'admins'];
  const clean = { remaining: [], flagged: 0, keptRecords: 0, cutShort: 0 };
  const part = (container, over = {}) => ({ container, decision: 'archive', reason: null, read: 3, matchesBackup: true, unreadable: 0, sensitive: clean, ...over });
  /** A finished report as a real clean one is: today's rules, and a part for each container the archive would write. */
  const done = (report = {}) => ({
    reportId: 'x',
    complete: true,
    report: { sourceBackup: { runId: SUNDAY }, rules: classificationFingerprint(), totals: {}, containers: [part('blogs'), part('newsletters')], leftOutWhole: [], ...report },
  });
  const gate = (latest, backupRunId = SUNDAY, backupContainers = BACKUP) => reportGate({ latest, backupRunId, backupContainers });
  const flaggedOnce = { remaining: [{ path: 'authorEmail', flagged: true }], flagged: 1, keptRecords: 1, cutShort: 0 };

  it('lets a finished, clean report of the same backup and the same rules through', () => {
    expect(gate(done())).toEqual([]);
  });

  it('stops when there is no report, one is still reading, or the newest did not finish', () => {
    expect(gate(null)).toEqual(['report-missing']);
    expect(gate(undefined)).toEqual(['report-missing']);
    expect(gate({ reportId: 'x', complete: false, stalled: false })).toEqual(['report-running']);
    expect(gate({ reportId: 'x', complete: false, stalled: true })).toEqual(['report-stalled']);
  });

  it('stops when the report was made from another backup than the one the archive would read', () => {
    expect(gate(done(), '2027-02-14')).toEqual(['report-older-than-backup']);
    expect(gate(done({ sourceBackup: {} }))).toEqual(['report-older-than-backup']);
    expect(gate(done(), null)).toEqual(['report-older-than-backup']);
  });

  it('stops when the report was made under other rules than today’s, or does not say which', () => {
    expect(gate(done({ rules: 'the-rules-of-last-week' }))).toEqual(['report-older-rules']);
    expect(gate(done({ rules: undefined }))).toEqual(['report-older-rules']);
    expect(gate(done({ rules: null }))).toEqual(['report-older-rules']);
  });

  it('stops when the report does not cover every container the archive would write', () => {
    // A finished report with no containers at all says nothing: it is not "nothing to decide".
    expect(gate(done({ containers: [] }))).toEqual(['report-incomplete']);
    expect(gate(done({ containers: [part('blogs')] }))).toEqual(['report-incomplete']);
    // In the report, but with another decision than the list gives it today.
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { decision: 'leave-out', reason: 'unclassified' })] }))).toContain('report-incomplete');
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { decision: 'archive-changed' })] }))).toEqual(['report-incomplete']);
    // Without the backup's own list of containers, no report can be called complete.
    expect(reportGate({ latest: done(), backupRunId: SUNDAY })).toEqual(['report-incomplete']);
    // A container the backup does not hold is not asked for.
    expect(gate(done({ containers: [part('blogs')] }), SUNDAY, ['blogs', 'admins'])).toEqual([]);
  });

  it('stops when a container the archive would write was not read whole', () => {
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { matchesBackup: false })] }))).toEqual(['report-mismatch']);
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { matchesBackup: null })] }))).toEqual(['report-mismatch']);
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { unreadable: 1 })] }))).toEqual(['report-mismatch']);
    expect(gate(done({ totals: { unreadable: 2 } }))).toEqual(['report-mismatch']);
  });

  it('stops when a record was too large to be searched whole for names that look like a secret', () => {
    expect(gate(done({ containers: [part('blogs', { sensitive: { ...clean, cutShort: 1 } }), part('newsletters')] }))).toEqual(['report-cut-short']);
  });

  it('stops for a flagged container no owner decision covers, and not for one the decision covers', () => {
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { sensitive: flaggedOnce })] }))).toEqual(['report-flagged']);
    // blogs is on the owner's list of 2026-11-24.
    expect(gate(done({ containers: [part('blogs', { sensitive: flaggedOnce }), part('newsletters')] }))).toEqual([]);
    // What the report stored does not decide it: the list as it is now does.
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { sensitive: flaggedOnce, ownerAccepted: '2026-11-24' })] }))).toEqual(['report-flagged']);
    // A report from before the lists were split cannot say what would remain, so a kept record with such a name counts.
    expect(gate(done({ containers: [part('blogs'), part('newsletters', { sensitive: { records: 2, keptRecords: 2, names: [] } })] }))).toEqual(['report-flagged']);
    // A container that is left out is never a reason: nothing of it would be archived.
    expect(gate(done({ containers: [part('blogs'), part('newsletters'), { container: 'admins', decision: 'leave-out', reason: 'access-list', sensitive: flaggedOnce }] }))).toEqual([]);
  });

  it('stops while a container is waiting for the owner, read or not, and stops stopping once the list has an answer for it', () => {
    const base = [part('blogs'), part('newsletters')];
    expect(gate(done({ containers: [...base, { container: 'a_new_container', decision: 'leave-out', reason: 'unclassified' }] }))).toEqual(['report-waiting']);
    expect(gate(done({ leftOutWhole: [{ container: 'a_new_container', reason: 'unclassified', backupDocs: 3 }] }))).toEqual(['report-waiting']);
    // The report called it waiting, and the list has since been given an answer for it: it is no longer waiting.
    expect(gate(done({ leftOutWhole: [{ container: 'admins', reason: 'unclassified', backupDocs: 3 }] }))).toEqual([]);
    expect(gate(done({ leftOutWhole: [{ container: 'tool_exports', reason: 'unclassified', backupDocs: 0 }] }))).toEqual([]);
  });

  it('lists every reason at once', () => {
    expect(
      gate(
        done({
          containers: [part('blogs', { matchesBackup: false }), part('newsletters', { sensitive: { ...flaggedOnce, cutShort: 2 } }), { container: 'a_new_container', decision: 'leave-out', reason: 'unclassified' }],
        })
      )
    ).toEqual(['report-mismatch', 'report-cut-short', 'report-flagged', 'report-waiting']);
  });

  it('a real dry run of a clean backup passes the gate, and says which rules it was made under', async () => {
    const at = new Date('2027-02-08T04:00:30Z');
    const blobs = memoryBlobs(backupSeed({ blogs: [{ id: 'b1' }], newsletters: [{ id: 'n1' }], admins: [{ id: 'a1' }] }));
    const jobs = [];
    await createReportScheduler({ store: { upsertDoc: async (_c, doc) => jobs.push(doc) }, blobs, enqueue: () => {}, now: () => at }).start();
    for (const job of jobs) await createReportWorker({ blobs, now: () => at }).readContainer(parseReportPayload(job.payload));
    const latest = await readLatestReport({ blobs, now: at });
    expect(latest.report.rules).toBe(classificationFingerprint());
    expect(gate(latest)).toEqual([]);
  });

  it('the start rule adds the gate’s answer to its own, and counts a gate that was not asked as "no report"', () => {
    const facts = { env: { [ARCHIVE_SETTING]: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, now: new Date('2027-02-08T04:00:00Z'), containerExists: true, manifestExists: false, backupRunId: SUNDAY };
    expect(archiveStartDecision({ ...facts, reportBlockers: [] }).start).toBe(true);
    expect(archiveStartDecision({ ...facts, reportBlockers: ['report-flagged'] })).toMatchObject({ start: false, blockers: ['report-flagged'] });
    expect(archiveStartDecision(facts)).toMatchObject({ start: false, blockers: ['report-missing'] });
  });
});
