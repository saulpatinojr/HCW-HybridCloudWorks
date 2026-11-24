/**
 * The job that writes the yearly content archive (ADR 0046). Two in-memory
 * blob stores stand in for the backup's containers and for `content-archive`;
 * every record is made up.
 *
 * The tests that matter most are the ones named after a mistake: writing a
 * container nobody classified, writing a record or a field the list leaves
 * out, writing with the switch off, writing into a finished year, and
 * writing the manifest before every file is checked.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNotifier } from '../notify.js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  ARCHIVE_JOB_TYPE,
  ARCHIVE_LATE_HOURS,
  ARCHIVE_NOTIFY_SOURCES,
  AUTO_DRY_RUN_MAX_FAILURES,
  ARCHIVE_TIER,
  archiveNames,
  createArchiveScheduler,
  createArchiveWorker,
  parseArchivePayload,
  readArchiveProgress,
} from './archive-job.js';
import { archiveDecisionFor, archivePlan, classificationFingerprint, LEFT_OUT, UNCLASSIFIED } from './archive-classification.js';
import { REPORT_JOB_TYPE, createReportWorker, parseReportPayload, reportGate, reportNames } from './archive-report.js';
import { createArchiveHandlers } from './archive-handlers.js';

const SUNDAY = '2027-02-07'; // a Sunday
const MONDAY = new Date('2027-02-08T03:00:00Z');
const YEAR = 2026;
const ON = { CONTENT_ARCHIVE_ENABLED: 'true', FEATURE_FLAG_COSMOS_EXPORT: 'true' };

const ndjson = (docs) => gzipSync(Buffer.from(docs.map((doc) => (typeof doc === 'string' ? doc : JSON.stringify(doc))).join('\n') + (docs.length ? '\n' : '')));
const linesOf = (buffer) =>
  gunzipSync(buffer)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** A blob store in memory. Buffers are data files; everything else is JSON. */
function memoryStore(seed = {}, { exists = true } = {}) {
  const files = new Map(Object.entries(seed));
  const tiers = new Map();
  const log = [];
  // The version stamp storage gives every write of a file. A new one each time, as in storage.
  const etags = new Map();
  let writes = 0;
  const etagOf = (name) => (files.has(name) ? etags.get(name) || '"seeded"' : null);
  const store = {
    files,
    tiers,
    /** Every write, in order: `put <name>`, `upload <name>`, `tier <name>`. */
    log,
    exists,
    async containerExists() {
      return store.exists;
    },
    async putJson(name, value, { overwrite = true } = {}) {
      if (!overwrite && files.has(name)) return false;
      files.set(name, JSON.parse(JSON.stringify(value)));
      log.push(`put ${name}`);
      return true;
    },
    async readJson(name) {
      const value = files.get(name);
      return value === undefined || Buffer.isBuffer(value) ? null : value;
    },
    async listNames(prefix) {
      return [...files.keys()].filter((name) => name.startsWith(prefix));
    },
    async listDetails(prefix) {
      return [...files.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => ({ name, size: Buffer.isBuffer(value) ? value.length : 2, tier: tiers.get(name) || 'Hot', etag: etagOf(name) }));
    },
    async readGzipStream(name) {
      const value = files.get(name);
      return Buffer.isBuffer(value) ? Readable.from([value.subarray(0, 7), value.subarray(7)]) : null;
    },
    /** Like storage: the bytes are taken in first, and the condition is judged when the write is committed. */
    async uploadGzipStream(name, stream, { conditions } = {}) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      await store.beforeCommit?.(name);
      if (conditions?.ifNoneMatch === '*' && files.has(name)) return false;
      if (conditions?.ifMatch && conditions.ifMatch !== etagOf(name)) return false;
      files.set(name, Buffer.concat(chunks));
      etags.set(name, `"write-${(writes += 1)}"`);
      log.push(`upload ${name}`);
      return true;
    },
    async setTier(name, tier) {
      if (store.failTier?.(name)) throw new Error('refused');
      tiers.set(name, tier);
      log.push(`tier ${name}`);
    },
  };
  return store;
}

/** A complete weekly full backup of these containers. */
const backupSeed = (containers, runId = SUNDAY) => ({
  [`full/${runId}/manifest.json`]: {
    runId,
    mode: 'full',
    containers: Object.entries(containers).map(([container, docs]) => ({ container, docs: docs.length, bytes: 10 })),
  },
  ...Object.fromEntries(Object.entries(containers).map(([container, docs]) => [`full/${runId}/${container}.ndjson.gz`, ndjson(docs)])),
});

/**
 * A finished dry-run report that shows nothing to decide, as the newest
 * report: made from this backup, under today's rules, with one part for
 * every container an archive would write, each read whole and matching the
 * backup's own count. That is what a real clean report holds (the test "with
 * no report it starts a dry run" makes one with the real dry run).
 */
function cleanReport(runId, backupManifest, over = {}) {
  const reportId = '20270207T2000Z';
  const held = new Map((backupManifest?.containers || []).map((row) => [row.container, row.docs]));
  return {
    [reportNames(reportId).latest]: { reportId },
    [reportNames(reportId).report]: {
      reportId,
      sourceBackup: { mode: 'full', runId },
      rules: classificationFingerprint(),
      completedAt: '2027-02-07T20:05:00.000Z',
      totals: { mismatched: 0, unreadable: 0 },
      containers: archivePlan()
        .filter((name) => held.has(name))
        .map((container) => ({
          container,
          decision: archiveDecisionFor(container).decision,
          reason: null,
          read: held.get(container),
          backupDocs: held.get(container),
          matchesBackup: true,
          unreadable: 0,
          sensitive: { records: 0, keptRecords: 0, remaining: [], flagged: 0, cutShort: 0 },
        })),
      leftOutWhole: [],
      ...over,
    },
  };
}

/**
 * A scheduler, a worker and both stores, with jobs collected instead of
 * queued. Unless `report` is false, the newest dry-run report is a clean one
 * of the newest backup in the store, as it is when an archive may start.
 */
function rig({ backup = {}, env = ON, now = MONDAY, archive, seedBackupStore, report = true } = {}) {
  const backupBlobs = seedBackupStore || memoryStore(backupSeed(backup));
  if (report) {
    const newest = [...backupBlobs.files.keys()]
      .map((name) => /^full\/(\d{4}-\d{2}-\d{2})\/manifest\.json$/.exec(name)?.[1])
      .filter(Boolean)
      .sort()
      .pop();
    if (newest) {
      const manifest = backupBlobs.files.get(`full/${newest}/manifest.json`);
      for (const [name, value] of Object.entries(cleanReport(newest, manifest, report === true ? {} : report))) backupBlobs.files.set(name, value);
    }
  }
  const archiveBlobs = archive || memoryStore();
  const clock = { now };
  const jobs = [];
  const messages = [];
  const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
  const lines = [];
  const log = { log: (line) => lines.push(line), warn: (line) => lines.push(line) };
  let n = 0;
  const deps = { backupBlobs, archiveBlobs, env, now: () => clock.now, log, notifier };
  const scheduler = createArchiveScheduler({
    ...deps,
    store: { upsertDoc: async (_container, doc) => jobs.push(doc) },
    enqueue: (message) => messages.push(message),
    uuid: () => `made-up-job-${(n += 1)}`,
  });
  const worker = createArchiveWorker(deps);
  /** Run every job that has been queued and not yet run, like the queue would. */
  const drain = async (workerEnv = env) => {
    const results = [];
    while (jobs.length) {
      const job = jobs.shift();
      if (job.type === REPORT_JOB_TYPE) {
        // A dry run the daily check started: read one container and write its part of the report.
        await createReportWorker({ blobs: backupBlobs, now: () => clock.now }).readContainer(parseReportPayload(job.payload));
        continue;
      }
      results.push(await createArchiveWorker({ ...deps, env: workerEnv }).archiveContainer(parseArchivePayload(job.payload)));
    }
    return results;
  };
  return { backupBlobs, archiveBlobs, scheduler, worker, jobs, messages, notifier, lines, clock, drain };
}

const SAMPLE = {
  blogs: [{ id: 'b1', title: 'One' }, { id: 'b2', title: 'Two' }],
  newsletters: [{ id: 'n1', title: 'Issue' }],
};

describe('the payload a job accepts', () => {
  it('takes a year, a backup date and a container the archive writes', () => {
    expect(parseArchivePayload({ year: 2026, runId: SUNDAY, container: 'blogs' })).toEqual({ year: 2026, runId: SUNDAY, container: 'blogs' });
    for (const bad of [{}, { year: 'x', runId: SUNDAY, container: 'blogs' }, { year: 26, runId: SUNDAY, container: 'blogs' }, { year: 2026, runId: 'today', container: 'blogs' }]) {
      expect(() => parseArchivePayload(bad)).toThrow();
    }
  });

  it('refuses every container that is left out or waiting, and every container the list does not name', () => {
    // Nothing is waiting since the owner's decision of 2026-11-24; a container the list does not name is refused all the same.
    expect(UNCLASSIFIED).toEqual([]);
    for (const container of [...Object.keys(LEFT_OUT), ...UNCLASSIFIED, 'a_new_container', '../blogs', '']) {
      expect(() => parseArchivePayload({ year: 2026, runId: SUNDAY, container }), container).toThrow(/not written by the content archive/);
    }
  });
});

describe('the daily check', () => {
  it('with the switch off it reads nothing, writes nothing and says so', async () => {
    for (const env of [{}, { CONTENT_ARCHIVE_ENABLED: 'false', FEATURE_FLAG_COSMOS_EXPORT: 'true' }, { CONTENT_ARCHIVE_ENABLED: 'TRUE', FEATURE_FLAG_COSMOS_EXPORT: 'true' }]) {
      const r = rig({ backup: SAMPLE, env });
      const read = vi.spyOn(r.backupBlobs, 'readJson');
      const asked = vi.spyOn(r.archiveBlobs, 'containerExists');
      expect(await r.scheduler.run()).toEqual({ action: 'off', year: YEAR, blockers: ['switch-off'] });
      expect(read).not.toHaveBeenCalled();
      expect(asked).not.toHaveBeenCalled();
      expect(r.jobs).toEqual([]);
      expect(r.messages).toEqual([]);
      expect(r.archiveBlobs.log).toEqual([]);
      expect(r.backupBlobs.log).toEqual([]);
      expect(r.lines.join(' ')).toContain('switched off');
    }
  });

  it('does not start in January, before a backup of 2 February, without a backup, or with the nightly export off', async () => {
    const blocked = async (over) => {
      const r = rig({ backup: SAMPLE, ...over });
      const result = await r.scheduler.run();
      expect(r.jobs, JSON.stringify(result)).toEqual([]);
      expect(r.archiveBlobs.log).toEqual([]);
      expect(r.backupBlobs.log).toEqual([]);
      return result;
    };
    expect(await blocked({ now: new Date('2027-01-25T03:00:00Z'), seedBackupStore: memoryStore(backupSeed(SAMPLE, '2027-01-24')) })).toMatchObject({
      action: 'blocked',
      blockers: ['before-1-february', 'backup-too-early'],
    });
    expect(await blocked({ now: new Date('2027-02-01T03:00:00Z'), seedBackupStore: memoryStore(backupSeed(SAMPLE, '2027-01-31')) })).toMatchObject({
      action: 'blocked',
      blockers: ['backup-too-early'],
    });
    expect(await blocked({ seedBackupStore: memoryStore({}) })).toMatchObject({ action: 'blocked', blockers: ['no-backup', 'report-missing'] });
    expect(await blocked({ env: { CONTENT_ARCHIVE_ENABLED: 'true' } })).toMatchObject({ action: 'blocked', blockers: ['export-off'] });
  });

  it('does not start while the archive container is missing or cannot be asked about', async () => {
    const missing = rig({ backup: SAMPLE, archive: memoryStore({}, { exists: false }) });
    expect(await missing.scheduler.run()).toEqual({ action: 'blocked', year: YEAR, blockers: ['archive-container-missing'] });
    const broken = memoryStore();
    broken.containerExists = async () => {
      throw new Error('secret words from storage');
    };
    const unreadable = rig({ backup: SAMPLE, archive: broken });
    expect(await unreadable.scheduler.run()).toEqual({ action: 'blocked', year: YEAR, blockers: ['archive-not-readable'] });
    expect(missing.jobs.concat(unreadable.jobs)).toEqual([]);
    expect(unreadable.lines.join(' ')).not.toContain('secret words');
  });

  it('starts one job per container the list archives and the backup holds, and none for any other', async () => {
    const r = rig({
      backup: { ...SAMPLE, admins: [{ id: 'a1', email: 'made-up@example.com' }], jobs: [{ id: 'j1' }], a_new_container: [{ id: 'x1' }] },
    });
    expect(await r.scheduler.run()).toEqual({ action: 'started', year: YEAR, queued: 2, sourceRun: SUNDAY });
    expect(r.jobs.map((job) => job.payload)).toEqual([
      { year: YEAR, runId: SUNDAY, container: 'blogs' },
      { year: YEAR, runId: SUNDAY, container: 'newsletters' },
    ]);
    expect(r.jobs.every((job) => job.type === ARCHIVE_JOB_TYPE)).toBe(true);
    expect(r.messages).toEqual([
      { jobId: 'made-up-job-1', type: ARCHIVE_JOB_TYPE },
      { jobId: 'made-up-job-2', type: ARCHIVE_JOB_TYPE },
    ]);
    const run = await r.backupBlobs.readJson(archiveNames(YEAR).run);
    expect(run.containers).toEqual(['blogs', 'newsletters']);
    expect(run.backup.runId).toBe(SUNDAY);
    expect(run.notInBackup).toEqual(archivePlan().filter((name) => !['blogs', 'newsletters'].includes(name)));
    // The start is logged without the backup's date or any id.
    expect(r.lines.join(' ')).not.toContain(SUNDAY);
    // Nothing is in content-archive yet.
    expect(r.archiveBlobs.log).toEqual([]);
  });

  it('a second check on the same day starts nothing new: it queues only what is still missing', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const first = r.jobs.splice(0);
    await createArchiveWorker({ backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, env: ON, now: () => MONDAY }).archiveContainer(
      parseArchivePayload(first[0].payload)
    );
    expect(await r.scheduler.run()).toMatchObject({ action: 'resumed', queued: 1, late: false });
    expect(r.jobs.map((job) => job.payload.container)).toEqual(['newsletters']);
    expect(r.notifier.notifyTelegram).not.toHaveBeenCalled();
  });
});

describe('the dry-run report stands between the switch and an archive', () => {
  it('with no report it starts a dry run instead of an archive, and the archive starts the day after if the report is clean', async () => {
    const r = rig({ backup: SAMPLE, report: false });
    expect(await r.scheduler.run()).toEqual({ action: 'blocked', year: YEAR, blockers: ['report-missing'], queued: 2, dryRunStarted: true });
    expect(r.jobs.every((job) => job.type === REPORT_JOB_TYPE)).toBe(true);
    expect(r.messages.every((message) => message.type === REPORT_JOB_TYPE)).toBe(true);
    // Nothing of an archive exists yet: no pinned run, no file.
    expect(await r.backupBlobs.readJson(archiveNames(YEAR).run)).toBeNull();
    expect(r.archiveBlobs.log).toEqual([]);

    // The same morning, before the dry run has finished: it waits, and starts no second one.
    const waiting = r.jobs.length;
    expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-running'], dryRunStarted: false });
    expect(r.jobs).toHaveLength(waiting);

    await r.drain();
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 2, sourceRun: SUNDAY });
    await r.drain();
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 2, records: 3 } });
  });

  it('a report made from an older backup is not enough: a new dry run is made first', async () => {
    const r = rig({ backup: SAMPLE, report: false });
    for (const [name, value] of Object.entries(cleanReport('2027-01-31'))) r.backupBlobs.files.set(name, value);
    expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-older-than-backup'], dryRunStarted: true });
    expect(r.archiveBlobs.log).toEqual([]);
  });

  it('does not start, and tells the owner, while the report shows a flagged container no decision covers', async () => {
    // authorEmail on newsletters: a container the owner's decision of 2026-11-24 does not cover.
    const r = rig({ backup: { ...SAMPLE, newsletters: [{ id: 'n1', title: 'Issue', authorEmail: 'made-up@example.com' }] }, report: false });
    await r.scheduler.run(); // starts the dry run
    await r.drain();
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toEqual({ action: 'blocked', year: YEAR, blockers: ['report-flagged'], queued: 0, dryRunStarted: false });
    expect(r.jobs).toEqual([]);
    expect(r.archiveBlobs.log).toEqual([]);
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const said = r.notifier.notifyTelegram.mock.calls[0][0];
    expect(said).toMatchObject({ severity: 'warning', source: 'content_archive_waiting' });
    expect(said.message).toContain('report-flagged');
    expect(said.message).not.toContain('made-up');
    expect(reportGate({ latest: null, backupRunId: SUNDAY })).toEqual(['report-missing']);
  });

  it('does not start while a container is waiting for the owner', async () => {
    const r = rig({ backup: { ...SAMPLE, a_new_container: [{ id: 'x1' }] }, report: false });
    await r.scheduler.run();
    await r.drain();
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-waiting'], dryRunStarted: false });
    expect(r.archiveBlobs.log).toEqual([]);
    expect(await r.backupBlobs.readJson(archiveNames(YEAR).run)).toBeNull();
  });

  it('starts no dry run while something else is also in the way', async () => {
    const r = rig({ backup: SAMPLE, report: false, now: new Date('2027-01-25T03:00:00Z') });
    const result = await r.scheduler.run();
    expect(result.blockers).toEqual(expect.arrayContaining(['before-1-february', 'report-missing']));
    expect(result.dryRunStarted).toBe(false);
    expect(r.jobs).toEqual([]);
  });

  it('a flagged container the owner decided to keep does not stop it', async () => {
    const r = rig({ backup: { blogs: [{ id: 'b1', email: 'made-up@example.com' }] }, report: false });
    await r.scheduler.run();
    await r.drain();
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 1 });
  });

  it('a run that has started is carried on whatever a later report says', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    r.jobs.splice(0);
    // The report is gone the next day; the pinned run still resumes.
    for (const name of [...r.backupBlobs.files.keys()]) if (name.startsWith('state/archive-report/')) r.backupBlobs.files.delete(name);
    expect(await r.scheduler.run()).toMatchObject({ action: 'resumed', queued: 2 });
  });
});

describe('writing one year', () => {
  it('writes each file online, checks it, then the manifest, and only then moves the files to the Archive tier', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const results = await r.drain();
    expect(results.map((result) => [result.container, result.written, result.records, result.manifestWritten])).toEqual([
      ['blogs', true, 2, false],
      ['newsletters', true, 1, true],
    ]);
    // The order of every write into content-archive.
    expect(r.archiveBlobs.log).toEqual([
      'upload 2026/cosmos/blogs.ndjson.gz',
      'upload 2026/cosmos/newsletters.ndjson.gz',
      'put 2026/manifest.json',
      'tier 2026/cosmos/blogs.ndjson.gz',
      'tier 2026/cosmos/newsletters.ndjson.gz',
    ]);
    expect(r.archiveBlobs.tiers.get('2026/manifest.json')).toBeUndefined();
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz'))).toEqual(SAMPLE.blogs);

    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    expect(manifest).toMatchObject({
      format: 1,
      year: YEAR,
      sourceBackup: { mode: 'full', runId: SUNDAY },
      totals: { files: 2, records: 3, recordsLeftOut: 0 },
    });
    expect(manifest.files.map((file) => file.name)).toEqual(['2026/cosmos/blogs.ndjson.gz', '2026/cosmos/newsletters.ndjson.gz']);
    for (const file of manifest.files) {
      const stored = r.archiveBlobs.files.get(file.name);
      expect(file.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(file.bytes).toBe(stored.length);
    }
    expect(manifest.totals.bytes).toBe(manifest.files.reduce((n, file) => n + file.bytes, 0));
    // The manifest holds no record and no id.
    const text = JSON.stringify(manifest);
    for (const secret of ['b1', 'b2', 'n1', 'One', 'Issue']) expect(text).not.toContain(`"${secret}"`);
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(r.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'info', source: 'content_archive_written' });
  });

  it('writes the same bytes when a job runs twice, and a job whose file is already checked skips it', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs;
    const job = parseArchivePayload(blogsJob.payload);
    await r.worker.archiveContainer(job);
    const first = Buffer.from(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz'));
    const again = await r.worker.archiveContainer(job);
    expect(again).toMatchObject({ written: false, skipped: 'already-written' });
    expect(r.archiveBlobs.log.filter((line) => line.startsWith('upload'))).toHaveLength(1);
    // A file that went missing is written again, byte for byte the same.
    r.archiveBlobs.files.delete('2026/cosmos/blogs.ndjson.gz');
    expect(await r.worker.archiveContainer(job)).toMatchObject({ written: true });
    expect(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz').equals(first)).toBe(true);
  });

  it('never writes a container the list does not name, or one that is left out, even when a job is queued by hand', async () => {
    const r = rig({ backup: { ...SAMPLE, a_new_container: [{ id: 't1', typed: 'made up' }], admins: [{ id: 'a1' }] } });
    await r.scheduler.run();
    // Someone edits the run so that it names them, and calls the worker directly.
    const run = await r.backupBlobs.readJson(archiveNames(YEAR).run);
    run.containers.push('a_new_container', 'admins');
    r.backupBlobs.files.set(archiveNames(YEAR).run, run);
    for (const container of ['a_new_container', 'admins', ...Object.keys(LEFT_OUT)]) {
      await expect(r.worker.archiveContainer({ year: YEAR, runId: SUNDAY, container }), container).rejects.toThrow(/not written by the content archive/);
    }
    expect(r.archiveBlobs.log).toEqual([]);
    // And the manifest is not written while the run names a container with no checked file.
    await r.drain();
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
    expect(r.archiveBlobs.log.filter((line) => line.startsWith('tier'))).toEqual([]);
  });

  it('leaves out the records the list leaves out, and the fields it does not keep', async () => {
    const backup = {
      content: [
        { id: 'c1', type: 'article', title: 'An article', status: 'published' },
        { id: 'c2', type: 'interview', title: 'A draft interview', status: 'draft', guestName: 'Made Up Guest' },
      ],
      content_versions: [
        { id: 'v1', contentId: 'c1', title: 'An earlier article' },
        { id: 'v2', contentId: 'c2', title: 'An earlier interview draft' },
        { id: 'v3', contentId: 'gone', title: 'A version of something deleted' },
      ],
      developer_events: [
        {
          id: 'p1',
          eventId: 'e1',
          docType: 'cfs-submission',
          status: 'accepted',
          title: 'A talk',
          abstract: 'About something',
          speakerName: 'Made Up Speaker',
          speakerEmail: 'speaker@example.com',
          speakerBio: 'A made-up bio',
          reviewNote: 'A made-up note',
        },
        { id: 'x1', eventId: 'e1', docType: 'something-new', secret: 'made-up-secret' },
      ],
      mcp_servers: [
        {
          id: 'm1',
          name: 'A server',
          url: 'https://tools.example.com/mcp?key=made-up-key',
          oauthToken: 'made-up-token',
          oauthRefreshToken: 'made-up-refresh',
          oauthClientSecret: 'made-up-client-secret',
          headers: { Authorization: 'Bearer made-up-bearer' },
        },
      ],
      doc_vault: [
        { id: 'd1', docType: 'document', title: 'A letter' },
        { id: 'vault-id-salt', docType: 'salt', salt: 'made-up-salt' },
      ],
      admin_config: [{ id: 'developer_api_key:made-up', keyHash: 'made-up-hash', organizerName: 'Made Up Organizer' }],
    };
    const r = rig({ backup });
    await r.scheduler.run();
    const results = await r.drain();
    expect(results.every((result) => result.written)).toBe(true);
    const everything = [...r.archiveBlobs.files.entries()]
      .filter(([, value]) => Buffer.isBuffer(value))
      .map(([, value]) => gunzipSync(value).toString('utf8'))
      .join('\n');
    for (const leaked of [
      'Made Up Guest',
      'A draft interview',
      'An earlier interview draft',
      'A version of something deleted',
      'Made Up Speaker',
      'speaker@example.com',
      'A made-up bio',
      'A made-up note',
      'made-up-secret',
      'made-up-key',
      'made-up-token',
      'made-up-refresh',
      'made-up-client-secret',
      'made-up-bearer',
      'made-up-salt',
      'made-up-hash',
      'Made Up Organizer',
    ]) {
      expect(everything, leaked).not.toContain(leaked);
    }
    for (const kept of ['An article', 'An earlier article', 'A talk', 'About something', 'A server', 'https://tools.example.com/mcp', 'A letter']) {
      expect(everything, kept).toContain(kept);
    }
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/content.ndjson.gz')).map((doc) => doc.id)).toEqual(['c1']);
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/content_versions.ndjson.gz')).map((doc) => doc.id)).toEqual(['v1']);
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/admin_config.ndjson.gz'))).toEqual([]);

    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    const file = (container) => manifest.files.find((entry) => entry.container === container);
    expect(file('content')).toMatchObject({ records: 1, recordsInBackup: 2, recordsLeftOut: 1, leftOutBy: { promise: 1 } });
    expect(file('developer_events')).toMatchObject({ records: 1, recordsLeftOut: 1, recordsWithFieldsRemoved: 1 });
    expect(file('developer_events').fieldsRemoved).toEqual(expect.arrayContaining(['speakerEmail', 'speakerName']));
    // Neither the manifest nor a working note names a record or holds a value.
    const notes = [...r.backupBlobs.files.entries()].filter(([name]) => name.startsWith('state/archive-run/')).map(([, value]) => JSON.stringify(value));
    for (const text of [JSON.stringify(manifest), ...notes]) {
      for (const leaked of ['made-up', 'Made Up', 'example.com', '"c1"', '"p1"', '"m1"']) expect(text).not.toContain(leaked);
    }
  });

  it('a job writes nothing when the switch has been turned off since it was queued', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const results = await r.drain({ CONTENT_ARCHIVE_ENABLED: 'false', FEATURE_FLAG_COSMOS_EXPORT: 'true' });
    expect(results).toEqual([
      { container: 'blogs', written: false, skipped: 'switch-off' },
      { container: 'newsletters', written: false, skipped: 'switch-off' },
    ]);
    expect(r.archiveBlobs.log).toEqual([]);
    expect([...r.backupBlobs.files.keys()].filter((name) => name.endsWith('.done.json'))).toEqual([]);
  });

  it('never writes into a year that has its manifest, and never replaces the manifest', async () => {
    const finished = { format: 1, year: YEAR, createdAt: '2027-02-08T03:30:00.000Z', files: [], totals: {} };
    const before = ndjson([{ id: 'old' }]);
    const archive = memoryStore({ '2026/manifest.json': finished, '2026/cosmos/blogs.ndjson.gz': before });
    const r = rig({ backup: SAMPLE, archive });
    // The daily check sees the year is archived and starts nothing.
    expect(await r.scheduler.run()).toMatchObject({ action: 'archived', blockers: ['already-archived'] });
    expect(r.jobs).toEqual([]);
    // A job left in the queue from before, with a run that still names it, writes nothing either.
    r.backupBlobs.files.set(archiveNames(YEAR).run, {
      year: YEAR,
      startedAt: MONDAY.toISOString(),
      rules: classificationFingerprint(),
      backup: { runId: SUNDAY, containers: [{ container: 'blogs', docs: 2 }] },
      containers: ['blogs'],
    });
    expect(await r.worker.archiveContainer({ year: YEAR, runId: SUNDAY, container: 'blogs' })).toEqual({ container: 'blogs', written: false, skipped: 'already-archived' });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'exists' });
    expect(archive.files.get('2026/cosmos/blogs.ndjson.gz').equals(before)).toBe(true);
    expect(await archive.readJson('2026/manifest.json')).toEqual(finished);
    expect(archive.log).toEqual([]);
  });

  it('does not write the manifest, or archive anything, before every file is written and checked', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0);
    const result = await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload));
    expect(result).toMatchObject({ written: true, manifestWritten: false });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'incomplete' });
    expect(await r.worker.moveToArchiveTier({ year: YEAR })).toMatchObject({ moved: 0, reason: 'no-manifest' });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
    expect(r.archiveBlobs.tiers.size).toBe(0);

    // A note left by an earlier run from another backup does not count.
    r.backupBlobs.files.set(archiveNames(YEAR, 'newsletters').note, {
      container: 'newsletters',
      year: YEAR,
      sourceRun: '2027-01-31',
      records: 1,
      bytes: 10,
      sha256: 'a'.repeat(64),
    });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'incomplete' });

    // A note for this run, under today's rules, whose file is gone does not count either...
    const note = { container: 'newsletters', year: YEAR, sourceRun: SUNDAY, rules: classificationFingerprint(), etag: '"write-99"', records: 1, bytes: 10, sha256: 'a'.repeat(64) };
    r.backupBlobs.files.set(archiveNames(YEAR, 'newsletters').note, note);
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'file-missing' });
    // ...nor one whose file is there in another version than the one that was checked, even at the same size.
    r.archiveBlobs.files.set('2026/cosmos/newsletters.ndjson.gz', Buffer.alloc(10));
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'file-missing' });
    // ...nor a note with no version stamp at all, or written under other rules.
    for (const bad of [{ ...note, etag: undefined }, { ...note, etag: '"seeded"', rules: 'other-rules' }]) {
      r.backupBlobs.files.set(archiveNames(YEAR, 'newsletters').note, bad);
      expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'incomplete' });
    }
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
    expect(r.archiveBlobs.tiers.size).toBe(0);
  });

  it('does not count a file when the backup has a line that is not a record, or a different number of records than it says', async () => {
    const unreadable = rig({ seedBackupStore: memoryStore(backupSeed({ blogs: [{ id: 'b1' }, 'this line is not JSON'] })) });
    await unreadable.scheduler.run();
    await expect(unreadable.drain()).rejects.toThrow(/could not be read as a record/);
    expect([...unreadable.backupBlobs.files.keys()].filter((name) => name.endsWith('.done.json'))).toEqual([]);
    expect(await unreadable.archiveBlobs.readJson('2026/manifest.json')).toBeNull();

    const seed = backupSeed({ blogs: [{ id: 'b1' }] });
    seed[`full/${SUNDAY}/manifest.json`].containers[0].docs = 5;
    const short = rig({ seedBackupStore: memoryStore(seed) });
    await short.scheduler.run();
    await expect(short.drain()).rejects.toThrow(/different number of records/);
    expect(await short.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
  });

  it('does not count a file that reads back differently from what was written', async () => {
    const r = rig({ backup: { blogs: SAMPLE.blogs } });
    await r.scheduler.run();
    // Storage hands back something else.
    r.archiveBlobs.readGzipStream = async () => Readable.from([ndjson([{ id: 'other' }])]);
    await expect(r.drain()).rejects.toThrow(/not the file that was written/);
    expect([...r.backupBlobs.files.keys()].filter((name) => name.endsWith('.done.json'))).toEqual([]);
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
  });

  it('stops when its time has run out', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(r.worker.archiveContainer({ ...parseArchivePayload(r.jobs[0].payload), signal: controller.signal })).rejects.toThrow('timeout');
    expect(r.archiveBlobs.log).toEqual([]);
  });
});

describe('a run that stopped half-way', () => {
  it('the next day queues only the missing containers, says it is late, and finishes', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0); // the newsletters job is lost
    await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload));

    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toEqual({ action: 'resumed', year: YEAR, queued: 1, late: true });
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const said = r.notifier.notifyTelegram.mock.calls[0][0];
    expect(said).toMatchObject({ severity: 'warning', source: 'content_archive_late' });
    expect(said.message).toContain(`more than ${ARCHIVE_LATE_HOURS} hours`);
    expect(said.message).toContain('1 of 2 files');
    await r.drain();
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 2, records: 3 } });
    expect(r.archiveBlobs.log.filter((line) => line.startsWith('upload'))).toEqual([
      'upload 2026/cosmos/blogs.ndjson.gz',
      'upload 2026/cosmos/newsletters.ndjson.gz',
    ]);
  });

  it('when every file is written but the manifest is not, the daily check writes it', async () => {
    const r = rig({ backup: { blogs: SAMPLE.blogs } });
    await r.scheduler.run();
    const put = r.archiveBlobs.putJson;
    r.archiveBlobs.putJson = async () => {
      throw new Error('storage was away');
    };
    await expect(r.drain()).rejects.toThrow('storage was away');
    r.archiveBlobs.putJson = put;
    expect(await r.scheduler.run()).toMatchObject({ action: 'completed', queued: 0 });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 1 } });
    expect(r.archiveBlobs.tiers.get('2026/cosmos/blogs.ndjson.gz')).toBe(ARCHIVE_TIER);
  });

  it('a file that could not be moved to the Archive tier is moved by a later check, and the manifest is left alone', async () => {
    const r = rig({ backup: SAMPLE });
    r.archiveBlobs.failTier = (name) => name.includes('newsletters');
    await r.scheduler.run();
    await r.drain();
    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    expect(manifest).not.toBeNull();
    expect(r.archiveBlobs.tiers.get('2026/cosmos/newsletters.ndjson.gz')).toBeUndefined();
    r.archiveBlobs.failTier = null;
    expect(await r.scheduler.run()).toMatchObject({ action: 'archived', moved: 1, failed: 0 });
    expect(r.archiveBlobs.tiers.get('2026/cosmos/newsletters.ndjson.gz')).toBe(ARCHIVE_TIER);
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toEqual(manifest);
    // A third check finds nothing to do and writes nothing.
    const writes = r.archiveBlobs.log.length;
    expect(await r.scheduler.run()).toMatchObject({ action: 'archived', moved: 0 });
    expect(r.archiveBlobs.log).toHaveLength(writes);
  });

  it('when the backup it started from has been deleted, it starts again from the newest one and old files do not count', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0);
    await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload));
    // Five weeks on: the first backup has been deleted and a newer one exists.
    for (const name of [...r.backupBlobs.files.keys()]) if (name.startsWith(`full/${SUNDAY}/`)) r.backupBlobs.files.delete(name);
    const later = '2027-03-14';
    for (const [name, value] of Object.entries(backupSeed({ blogs: [{ id: 'b1', title: 'One, edited' }], newsletters: SAMPLE.newsletters }, later))) {
      r.backupBlobs.files.set(name, value);
    }
    r.clock.now = new Date('2027-03-15T03:00:00Z');
    // The report on file describes the deleted backup, so the first check makes a dry run of the new one...
    expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-older-than-backup'], dryRunStarted: true, queued: 2 });
    await r.drain();
    // ...and the next day's check starts the archive from it.
    r.clock.now = new Date('2027-03-16T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 2, sourceRun: later });
    // A job of the old run that is still in the queue writes nothing.
    expect(await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload))).toMatchObject({ written: false, skipped: 'not-this-run' });
    await r.drain();
    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    expect(manifest.sourceBackup.runId).toBe(later);
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz'))).toEqual([{ id: 'b1', title: 'One, edited' }]);
  });
});

describe('the keep list is asked again while a run is in progress', () => {
  /** As if a deploy changed the list of what is kept after this was written. */
  const underOlderRules = (store, name) => store.files.set(name, { ...store.files.get(name), rules: 'the-rules-of-last-week' });

  it('a run pinned under other rules is not carried on: it starts again and every file is written again', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0);
    await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload));
    const first = r.archiveBlobs.log.length;

    // The rules change. The run and the file's note were written under the old ones.
    underOlderRules(r.backupBlobs, archiveNames(YEAR).run);
    underOlderRules(r.backupBlobs, archiveNames(YEAR, 'blogs').note);
    // A job of the old run that is still in the queue writes nothing, and no manifest can come of the old run.
    expect(await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload))).toMatchObject({ written: false, skipped: 'not-this-run' });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'no-run' });

    // The next check does not resume: it pins a new run under today's rules and queues every container again.
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 2 });
    expect((await r.backupBlobs.readJson(archiveNames(YEAR).run)).rules).toBe(classificationFingerprint());
    await r.drain();
    // blogs was written a second time: the old note did not count.
    expect(r.archiveBlobs.log.slice(first).filter((line) => line === 'upload 2026/cosmos/blogs.ndjson.gz')).toHaveLength(1);
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 2 } });
  });

  it('a file’s note written under other rules than the run’s does not count', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    await r.drain();
    r.archiveBlobs.files.delete('2026/manifest.json');
    underOlderRules(r.backupBlobs, archiveNames(YEAR, 'blogs').note);
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'incomplete' });
    // The daily check queues that container again.
    expect(await r.scheduler.run()).toMatchObject({ action: 'resumed', queued: 1 });
    expect(r.jobs.map((job) => job.payload.container)).toEqual(['blogs']);
  });

  it('never names a container the list does not archive today, even when the run and a checked file say so', async () => {
    // The reviewer's case: a run note, under today's rules, that lists `admins`, with a file and a matching note for it.
    const r = rig({ backup: { ...SAMPLE, admins: [{ id: 'a1', email: 'made-up@example.com' }] } });
    await r.scheduler.run();
    await r.drain();
    r.archiveBlobs.files.delete('2026/manifest.json');
    r.archiveBlobs.files.set('2026/cosmos/admins.ndjson.gz', ndjson([{ id: 'a1', email: 'made-up@example.com' }]));
    const run = await r.backupBlobs.readJson(archiveNames(YEAR).run);
    r.backupBlobs.files.set(archiveNames(YEAR).run, { ...run, containers: [...run.containers, 'admins'] });
    r.backupBlobs.files.set(archiveNames(YEAR, 'admins').note, {
      container: 'admins',
      year: YEAR,
      sourceRun: SUNDAY,
      rules: classificationFingerprint(),
      etag: '"seeded"',
      records: 1,
      bytes: 10,
      sha256: 'a'.repeat(64),
    });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'not-in-plan' });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
    expect(r.archiveBlobs.tiers.has('2026/cosmos/admins.ndjson.gz')).toBe(false);
    // The daily check does not write one either, however often it looks.
    expect(await r.scheduler.run()).toMatchObject({ action: 'waiting', reason: 'not-in-plan' });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
  });

  it('does not finish while the year’s folder holds a file its list would not name, and tells the owner once', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    // A file left by an earlier run, of a container that has since been taken off the list.
    r.archiveBlobs.files.set('2026/cosmos/tool_exports.ndjson.gz', ndjson([{ id: 't1' }]));
    const results = await r.drain();
    expect(results.every((result) => result.written && result.manifestWritten === false)).toBe(true);
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'unlisted-file', unlisted: 1 });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();
    expect(r.archiveBlobs.tiers.size).toBe(0);

    r.notifier.notifyTelegram.mockClear();
    for (const day of ['2027-02-09', '2027-02-10', '2027-02-11']) {
      r.clock.now = new Date(`${day}T03:00:00Z`);
      expect(await r.scheduler.run()).toMatchObject({ action: 'waiting', reason: 'unlisted-file', queued: 0 });
    }
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(r.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'warning', source: ARCHIVE_NOTIFY_SOURCES.blocked });
    expect(r.notifier.notifyTelegram.mock.calls[0][0].message).not.toContain('tool_exports');
    // The card is told how many.
    const progress = await readArchiveProgress({ backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, year: YEAR, archived: false, now: r.clock.now });
    expect(progress.run).toMatchObject({ unlistedFiles: 1, done: 2, expected: 2 });

    // Once the owner has cleared the file by hand, the next check finishes the archive.
    r.archiveBlobs.files.delete('2026/cosmos/tool_exports.ndjson.gz');
    expect(await r.scheduler.run()).toMatchObject({ action: 'completed' });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 2 } });
  });
});

describe('two jobs, a late job, and the switch', () => {
  it('of two jobs writing one container at once, storage lets one finish, and the other writes nothing over it', async () => {
    const r = rig({ backup: { blogs: SAMPLE.blogs } });
    await r.scheduler.run();
    const job = parseArchivePayload(r.jobs[0].payload);
    // While the first job is still uploading, a second job for the same container runs from start to finish.
    let second = null;
    r.archiveBlobs.beforeCommit = async () => {
      if (second !== null) return;
      second = 'running';
      second = await r.worker.archiveContainer(job);
    };
    const first = await r.worker.archiveContainer(job);
    expect(second).toMatchObject({ written: true });
    expect(first).toEqual({ container: 'blogs', written: false, skipped: 'another-job-wrote-it' });
    expect(r.archiveBlobs.log.filter((line) => line.startsWith('upload'))).toEqual(['upload 2026/cosmos/blogs.ndjson.gz']);
    // The file in storage is the one the note vouches for, and the archive finished on it.
    const note = await r.backupBlobs.readJson(archiveNames(YEAR, 'blogs').note);
    expect((await r.archiveBlobs.listDetails('2026/cosmos/'))[0].etag).toBe(note.etag);
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toMatchObject({ totals: { files: 1, records: 2 } });
  });

  it('a job that is late cannot write over a file another job wrote since it looked', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0);
    const job = parseArchivePayload(blogsJob.payload);
    // An unverified file is there (a job died after uploading). Job A sees it and starts to replace it...
    r.archiveBlobs.files.set('2026/cosmos/blogs.ndjson.gz', ndjson([{ id: 'half-written' }]));
    let b = null;
    r.archiveBlobs.beforeCommit = async () => {
      if (b !== null) return;
      b = 'running';
      // ...and job B replaces and verifies it first.
      b = await r.worker.archiveContainer(job);
    };
    const a = await r.worker.archiveContainer(job);
    expect(b).toMatchObject({ written: true });
    expect(a).toMatchObject({ written: false, skipped: 'another-job-wrote-it' });
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz'))).toEqual(SAMPLE.blogs);
  });

  it('a file that fails a check before the upload is finished is never left in the archive', async () => {
    const unreadable = rig({ seedBackupStore: memoryStore(backupSeed({ blogs: [{ id: 'b1' }, 'this line is not JSON'] })) });
    await unreadable.scheduler.run();
    await expect(unreadable.drain()).rejects.toThrow(/could not be read as a record/);
    expect([...unreadable.archiveBlobs.files.keys()]).toEqual([]);

    const seed = backupSeed({ blogs: [{ id: 'b1' }] });
    seed[`full/${SUNDAY}/manifest.json`].containers[0].docs = 5;
    const short = rig({ seedBackupStore: memoryStore(seed) });
    await short.scheduler.run();
    await expect(short.drain()).rejects.toThrow(/different number of records/);
    expect([...short.archiveBlobs.files.keys()]).toEqual([]);
  });

  it('nothing is noted, and no manifest is written, once the switch is off or the year has its manifest, even mid-job', async () => {
    // The switch goes off while a job is reading its file back.
    const env = { ...ON };
    const r = rig({ backup: { blogs: SAMPLE.blogs }, env });
    await r.scheduler.run();
    const job = parseArchivePayload(r.jobs[0].payload);
    const read = r.archiveBlobs.readGzipStream;
    r.archiveBlobs.readGzipStream = async (name) => {
      env.CONTENT_ARCHIVE_ENABLED = 'false';
      return read(name);
    };
    expect(await r.worker.archiveContainer(job)).toEqual({ container: 'blogs', written: false, skipped: 'switch-off' });
    expect(await r.backupBlobs.readJson(archiveNames(YEAR, 'blogs').note)).toBeNull();
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'switch-off' });
    expect(await r.archiveBlobs.readJson('2026/manifest.json')).toBeNull();

    // A manifest appears while another job is reading its file back: that job notes nothing.
    const other = rig({ backup: { blogs: SAMPLE.blogs } });
    await other.scheduler.run();
    const readOther = other.archiveBlobs.readGzipStream;
    other.archiveBlobs.readGzipStream = async (name) => {
      other.archiveBlobs.files.set('2026/manifest.json', { format: 1, year: YEAR, files: [] });
      return readOther(name);
    };
    expect(await other.worker.archiveContainer(parseArchivePayload(other.jobs[0].payload))).toEqual({ container: 'blogs', written: false, skipped: 'already-archived' });
    expect(await other.backupBlobs.readJson(archiveNames(YEAR, 'blogs').note)).toBeNull();
  });
});

describe('the automatic dry run is capped, and the owner is told once', () => {
  it('starts at most one dry run by itself per backup: if that one does not finish, it tells the owner once and starts no other', async () => {
    const r = rig({ backup: SAMPLE, report: false });
    expect(await r.scheduler.run()).toMatchObject({ dryRunStarted: true });
    r.jobs.splice(0); // the dry run's jobs are lost: it never finishes
    r.messages.splice(0);
    for (const day of ['2027-02-09', '2027-02-10', '2027-02-11']) {
      r.clock.now = new Date(`${day}T03:00:00Z`);
      expect(await r.scheduler.run(), day).toMatchObject({ action: 'blocked', blockers: ['report-stalled'], dryRunStarted: false, queued: 0 });
    }
    expect(r.jobs).toEqual([]);
    expect(r.messages).toEqual([]);
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(r.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'warning', source: ARCHIVE_NOTIFY_SOURCES.blocked });
    expect(r.notifier.notifyTelegram.mock.calls[0][0].title).toContain('the dry run did not finish');
  });

  it('a new backup gets one new automatic dry run, until several in a row have failed; then none, and the owner is told once', async () => {
    const r = rig({ backup: SAMPLE, report: false });
    const sundays = ['2027-02-07', '2027-02-14', '2027-02-21', '2027-02-28', '2027-03-07'];
    const started = [];
    for (const [week, sunday] of sundays.entries()) {
      if (week > 0) for (const [name, value] of Object.entries(backupSeed(SAMPLE, sunday))) r.backupBlobs.files.set(name, value);
      r.clock.now = new Date(new Date(`${sunday}T03:00:00Z`).getTime() + 24 * 60 * 60 * 1000);
      const result = await r.scheduler.run();
      started.push(result.dryRunStarted);
      r.jobs.splice(0); // every one of them is lost
    }
    // One per backup for the first three failures in a row, then no more.
    expect(AUTO_DRY_RUN_MAX_FAILURES).toBe(3);
    expect(started).toEqual([true, true, true, false, false]);
    const titles = r.notifier.notifyTelegram.mock.calls.map(([message]) => message.title);
    expect(titles.filter((title) => title.includes('no more automatic dry runs'))).toHaveLength(1);
  });

  it('says "waiting for you" once for one report, not every morning', async () => {
    const r = rig({ backup: { ...SAMPLE, newsletters: [{ id: 'n1', title: 'Issue', authorEmail: 'made-up@example.com' }] }, report: false });
    await r.scheduler.run();
    await r.drain();
    for (const day of ['2027-02-09', '2027-02-10', '2027-02-11']) {
      r.clock.now = new Date(`${day}T03:00:00Z`);
      expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-flagged'], dryRunStarted: false });
    }
    expect(r.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(r.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ source: ARCHIVE_NOTIFY_SOURCES.waiting });
  });

  it('a report made under older rules gets a new dry run by itself, even for a backup that already had one', async () => {
    // What happens after the owner has decided and the list has been changed: the same backup, new rules.
    const r = rig({ backup: SAMPLE, report: false });
    await r.scheduler.run();
    await r.drain();
    const reportName = [...r.backupBlobs.files.keys()].find((name) => name.endsWith('/report.json'));
    r.backupBlobs.files.set(reportName, { ...r.backupBlobs.files.get(reportName), rules: 'the-rules-of-last-week' });
    const memo = await r.backupBlobs.readJson(archiveNames(YEAR).memo);
    r.backupBlobs.files.set(archiveNames(YEAR).memo, { ...memo, autoDryRun: { ...memo.autoDryRun, key: `${SUNDAY}:the-rules-of-last-week` } });
    r.clock.now = new Date('2027-02-09T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'blocked', blockers: ['report-older-rules'], dryRunStarted: true });
    await r.drain();
    r.clock.now = new Date('2027-02-10T03:00:00Z');
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 2 });
  });
});

describe('the three kinds of message do not swallow each other', () => {
  /** The notifier as it runs, over an in-memory `system` container and a fake Telegram. */
  function realNotifier() {
    const docs = new Map();
    let etag = 0;
    const store = {
      async readDoc(_container, id) {
        return docs.get(id) || null;
      },
      async upsertDoc(_container, doc) {
        const saved = { ...doc, _etag: `e${(etag += 1)}` };
        docs.set(doc.id, saved);
        return saved;
      },
      async createDoc(container, doc) {
        return store.upsertDoc(container, doc);
      },
      async patchDoc(_container, id, patch, { ifMatch } = {}) {
        const current = docs.get(id) || { id };
        if (ifMatch && current._etag !== ifMatch) throw Object.assign(new Error('precondition'), { code: 412 });
        const saved = { ...current, ...patch, _etag: `e${(etag += 1)}` };
        docs.set(id, saved);
        return saved;
      },
    };
    const sent = [];
    const fetch = vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body).text);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    });
    const notifier = createNotifier({ store, env: { TELEGRAM_BOT_TOKEN: 'made-up-token', TELEGRAM_CHAT_ID: '1' }, fetch, now: () => new Date('2027-02-09T03:00:00Z') });
    return { notifier, sent };
  }

  it('each has its own source, so "not finished" a minute earlier does not swallow "written"', async () => {
    expect(new Set(Object.values(ARCHIVE_NOTIFY_SOURCES)).size).toBe(4);
    const { notifier, sent } = realNotifier();
    const say = (source, title) => notifier.notifyTelegram({ title, message: 'made up', severity: 'info', source });
    expect(await say(ARCHIVE_NOTIFY_SOURCES.late, 'not finished')).toMatchObject({ sent: true });
    expect(await say(ARCHIVE_NOTIFY_SOURCES.waiting, 'waiting for you')).toMatchObject({ sent: true });
    expect(await say(ARCHIVE_NOTIFY_SOURCES.written, 'written')).toMatchObject({ sent: true });
    expect(sent).toHaveLength(3);
    // The same source twice inside the cooldown is one message: that is what a shared source would have done to "written".
    expect(await say(ARCHIVE_NOTIFY_SOURCES.late, 'not finished, again')).toMatchObject({ sent: false, reason: 'cooldown' });
    expect(sent).toHaveLength(3);
  });

  it('a late run that finishes in the same check sends both messages, through the real notifier', async () => {
    const { notifier, sent } = realNotifier();
    const r = rig({ backup: SAMPLE });
    const deps = { backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, env: ON, notifier };
    await r.scheduler.run();
    const [blogsJob, newslettersJob] = r.jobs.splice(0);
    await createArchiveWorker({ ...deps, now: () => MONDAY }).archiveContainer(parseArchivePayload(blogsJob.payload));
    // The next morning: the check says it is late and queues the missing container...
    const tuesday = new Date('2027-02-09T03:00:00Z');
    const scheduler = createArchiveScheduler({ ...deps, now: () => tuesday, store: { upsertDoc: async () => {} }, enqueue: () => {}, uuid: () => 'made-up' });
    expect(await scheduler.run()).toMatchObject({ action: 'resumed', late: true });
    // ...and that job finishes the archive a minute later.
    await createArchiveWorker({ ...deps, now: () => tuesday }).archiveContainer(parseArchivePayload(newslettersJob.payload));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('is not finished');
    expect(sent[1]).toContain('written');
  });
});

describe('what the card is told', () => {
  it('nothing written: no last archive and no run', async () => {
    const r = rig({ backup: SAMPLE });
    expect(await readArchiveProgress({ backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, year: YEAR, archived: false, now: MONDAY })).toEqual({
      lastArchive: null,
      run: null,
    });
  });

  it('a run in progress: how far it is, what is missing, and late after six hours', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    const [blogsJob] = r.jobs.splice(0);
    await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload));
    const ask = (now) => readArchiveProgress({ backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, year: YEAR, archived: false, now });
    expect(await ask(new Date('2027-02-08T03:10:00Z'))).toEqual({
      lastArchive: null,
      run: { year: YEAR, unlistedFiles: 0, startedAt: MONDAY.toISOString(), sourceRun: SUNDAY, expected: 2, done: 1, missing: ['newsletters'], late: false },
    });
    expect((await ask(new Date('2027-02-08T09:00:00Z'))).run.late).toBe(true);
  });

  it('a finished archive: year, when, files, records, bytes and how many files are in the Archive tier', async () => {
    const r = rig({ backup: SAMPLE });
    await r.scheduler.run();
    await r.drain();
    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    const progress = await readArchiveProgress({ backupBlobs: r.backupBlobs, archiveBlobs: r.archiveBlobs, year: YEAR, archived: true, now: MONDAY });
    expect(progress).toEqual({
      lastArchive: {
        year: YEAR,
        createdAt: manifest.createdAt,
        sourceRun: SUNDAY,
        containers: 2,
        records: 3,
        bytes: manifest.totals.bytes,
        inArchiveTier: 2,
        missingFiles: 0,
      },
      run: null,
    });

    // The status route hands the same thing to the card, to the owner only.
    const guard = { requireRole: vi.fn(async () => ({ user: { oid: 'made-up-oid' } })) };
    const handlers = createArchiveHandlers({
      guard,
      store: { upsertDoc: async () => {} },
      blobs: r.backupBlobs,
      archiveBlobs: r.archiveBlobs,
      env: ON,
      now: () => MONDAY,
    });
    const answer = JSON.parse((await handlers.getStatus({}, {})).body);
    expect(guard.requireRole).toHaveBeenCalledWith({}, 'super_admin');
    expect(answer).toMatchObject({
      jobBuilt: true,
      exportOn: true,
      switchOn: true,
      archived: true,
      wouldStart: false,
      blockers: ['already-archived'],
      progressKnown: true,
      lastArchive: progress.lastArchive,
      run: null,
    });
  });

  it('a failure to read the progress is "not known", with the far end’s words kept out of the log', async () => {
    const r = rig({ backup: SAMPLE });
    r.archiveBlobs.listDetails = async () => {
      throw new Error('secret words from storage');
    };
    const warn = vi.fn();
    const handlers = createArchiveHandlers({
      guard: { requireRole: async () => ({ user: {} }) },
      store: { upsertDoc: async () => {} },
      blobs: r.backupBlobs,
      archiveBlobs: r.archiveBlobs,
      env: ON,
      now: () => MONDAY,
    });
    const answer = JSON.parse((await handlers.getStatus({}, { warn })).body);
    expect(answer).toMatchObject({ progressKnown: false, lastArchive: null, run: null, archived: false });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret words');
  });
});
