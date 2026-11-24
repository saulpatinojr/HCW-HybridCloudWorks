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
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  ARCHIVE_JOB_TYPE,
  ARCHIVE_LATE_HOURS,
  ARCHIVE_TIER,
  archiveNames,
  createArchiveScheduler,
  createArchiveWorker,
  parseArchivePayload,
  readArchiveProgress,
} from './archive-job.js';
import { archivePlan, LEFT_OUT, UNCLASSIFIED } from './archive-classification.js';
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
        .map(([name, value]) => ({ name, size: Buffer.isBuffer(value) ? value.length : 2, tier: tiers.get(name) || 'Hot' }));
    },
    async readGzipStream(name) {
      const value = files.get(name);
      return Buffer.isBuffer(value) ? Readable.from([value.subarray(0, 7), value.subarray(7)]) : null;
    },
    async uploadGzipStream(name, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      files.set(name, Buffer.concat(chunks));
      log.push(`upload ${name}`);
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

/** A scheduler, a worker and both stores, with jobs collected instead of queued. */
function rig({ backup = {}, env = ON, now = MONDAY, archive, seedBackupStore } = {}) {
  const backupBlobs = seedBackupStore || memoryStore(backupSeed(backup));
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

  it('refuses every container the owner has not classified and every container that is left out', () => {
    expect(UNCLASSIFIED).toHaveLength(21);
    for (const container of [...Object.keys(LEFT_OUT), 'not_a_container', '../blogs', '']) {
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
    expect(await blocked({ seedBackupStore: memoryStore({}) })).toMatchObject({ action: 'blocked', blockers: ['no-backup'] });
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
      backup: { ...SAMPLE, admins: [{ id: 'a1', email: 'made-up@example.com' }], tool_exports: [{ id: 't1' }], site_settings: [{ id: 's1' }] },
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
    expect(r.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'info', source: 'content_archive' });
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

  it('never writes a container the owner has not classified, or one that is left out, even when a job is queued by hand', async () => {
    const r = rig({ backup: { ...SAMPLE, tool_exports: [{ id: 't1', typed: 'made up' }], admins: [{ id: 'a1' }] } });
    await r.scheduler.run();
    // Someone edits the run so that it names them, and calls the worker directly.
    const run = await r.backupBlobs.readJson(archiveNames(YEAR).run);
    run.containers.push('tool_exports', 'admins');
    r.backupBlobs.files.set(archiveNames(YEAR).run, run);
    for (const container of ['tool_exports', 'admins', ...UNCLASSIFIED]) {
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

    // A note for this run whose file is gone, or is another size, does not count either.
    r.backupBlobs.files.set(archiveNames(YEAR, 'newsletters').note, {
      container: 'newsletters',
      year: YEAR,
      sourceRun: SUNDAY,
      records: 1,
      bytes: 10,
      sha256: 'a'.repeat(64),
    });
    expect(await r.worker.completeIfLast({ year: YEAR })).toEqual({ written: false, reason: 'file-missing' });
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
    expect(said).toMatchObject({ severity: 'warning', source: 'content_archive' });
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
    expect(await r.scheduler.run()).toMatchObject({ action: 'started', queued: 2, sourceRun: later });
    // A job of the old run that is still in the queue writes nothing.
    expect(await r.worker.archiveContainer(parseArchivePayload(blogsJob.payload))).toMatchObject({ written: false, skipped: 'not-this-run' });
    await r.drain();
    const manifest = await r.archiveBlobs.readJson('2026/manifest.json');
    expect(manifest.sourceBackup.runId).toBe(later);
    expect(linesOf(r.archiveBlobs.files.get('2026/cosmos/blogs.ndjson.gz'))).toEqual([{ id: 'b1', title: 'One, edited' }]);
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
      run: { year: YEAR, startedAt: MONDAY.toISOString(), sourceRun: SUNDAY, expected: 2, done: 1, missing: ['newsletters'], late: false },
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
