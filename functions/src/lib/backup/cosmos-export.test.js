import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';

import { JOBS_CONTAINER } from '../jobs.js';
import { exportPlanFor, OPERATIONAL } from './export-classification.js';
import {
  EXPORT_JOB_TYPE,
  EXPORT_EVENT,
  EXPORT_ACTOR,
  runIdFor,
  modeFor,
  runPrefix,
  blobNames,
  parseExportPayload,
  createExportScheduler,
  createContainerExporter,
} from './cosmos-export.js';

const SUNDAY = new Date('2026-09-13T03:00:00.000Z');
const MONDAY = new Date('2026-09-14T03:00:00.000Z');

/** An in-memory export blob store: gzip uploads are collected and decoded on read. */
function memBlobs(initial = {}) {
  const blobs = new Map(Object.entries(initial));
  const uploads = [];
  return {
    blobs,
    uploads,
    async uploadGzipStream(name, stream, opts) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const gz = Buffer.concat(chunks);
      blobs.set(name, gz);
      uploads.push({ name, opts, bytes: gz.length, text: gunzipSync(gz).toString('utf8') });
    },
    putJson: vi.fn(async (name, value, { overwrite = true } = {}) => {
      if (!overwrite && blobs.has(name)) return false;
      blobs.set(name, JSON.stringify(value));
      return true;
    }),
    async readJson(name) {
      const raw = blobs.get(name);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async listNames(prefix) {
      return [...blobs.keys()].filter((n) => n.startsWith(prefix));
    },
  };
}

/** A Cosmos reader over fixed pages; records how it was asked. */
function memCosmos({ pages = [], feed = [], checkpoint = 'cp-now' } = {}) {
  const calls = { query: [], feed: [], checkpoint: [] };
  return {
    calls,
    async *queryPages(container, sql, opts) {
      calls.query.push({ container, sql, opts });
      for (const page of pages) yield page;
    },
    async *changeFeedPages(container, from, opts) {
      calls.feed.push({ container, from, opts });
      for (const page of feed) yield page;
    },
    async changeFeedCheckpoint(container) {
      calls.checkpoint.push(container);
      return checkpoint;
    },
  };
}

const ndjson = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('naming', () => {
  it('run id is the UTC date and Sunday is the full', () => {
    expect(runIdFor(SUNDAY)).toBe('2026-09-13');
    expect(modeFor(SUNDAY)).toBe('full');
    expect(modeFor(MONDAY)).toBe('delta');
    // 23:30 Saturday in Chicago is Sunday in UTC; the UTC clock decides.
    expect(modeFor(new Date('2026-09-13T04:30:00.000Z'))).toBe('full');
    expect(runPrefix('delta', '2026-09-14')).toBe('delta/2026-09-14/');
  });

  it('blob names follow the ADR layout', () => {
    expect(blobNames({ mode: 'full', runId: '2026-09-13', container: 'content' })).toEqual({
      prefix: 'full/2026-09-13/',
      data: 'full/2026-09-13/content.ndjson.gz',
      marker: 'full/2026-09-13/content.marker.json',
      manifest: 'full/2026-09-13/manifest.json',
      run: 'full/2026-09-13/run.json',
      state: 'state/content.json',
    });
  });
});

describe('parseExportPayload', () => {
  it('accepts a planned container and refuses everything else', () => {
    expect(parseExportPayload({ runId: '2026-09-13', mode: 'full', container: 'audits' })).toEqual({
      runId: '2026-09-13',
      mode: 'full',
      container: 'audits',
    });
    // Class C is full-only.
    expect(() =>
      parseExportPayload({ runId: '2026-09-14', mode: 'delta', container: 'audits' })
    ).toThrow(/not exported on a delta run/);
    // Excluded classes are never exported, whatever the message says.
    expect(() =>
      parseExportPayload({ runId: '2026-09-13', mode: 'full', container: 'jobs' })
    ).toThrow(/not exported/);
    expect(() =>
      parseExportPayload({ runId: '13-09-2026', mode: 'full', container: 'content' })
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parseExportPayload({ runId: '2026-09-13', mode: 'weekly', container: 'content' })
    ).toThrow(/mode must be/);
    expect(() => parseExportPayload(null)).toThrow(/mode must be/);
  });
});

describe('createExportScheduler', () => {
  function scheduler(now, blobs = memBlobs()) {
    const store = { upsertDoc: vi.fn(async (_c, doc) => doc) };
    const messages = [];
    let n = 0;
    const s = createExportScheduler({
      store,
      blobs,
      enqueue: (m) => messages.push(m),
      now: () => now,
      uuid: () => `job-${++n}`,
    });
    return { s, store, messages, blobs };
  }

  // Ambassador added one authored container (ADR 0033 §4); Second Brain adds
  // brain_records, bringing the full/delta plans to 63/56 containers.
  it('Sunday: one job document and one queue message per container of the full plan, 63 of them', async () => {
    const { s, store, messages, blobs } = scheduler(SUNDAY);
    const result = await s.run();
    expect(result).toEqual({
      runId: '2026-09-13',
      mode: 'full',
      containers: 63,
      enqueued: 63,
      skipped: false,
    });
    expect(store.upsertDoc).toHaveBeenCalledTimes(63);
    expect(messages).toHaveLength(63);
    expect(messages[0]).toEqual({ jobId: 'job-1', type: EXPORT_JOB_TYPE });

    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe(JOBS_CONTAINER);
    expect(doc).toMatchObject({
      id: 'job-1',
      type: EXPORT_JOB_TYPE,
      status: 'queued',
      attempts: 0,
      requestedBy: EXPORT_ACTOR,
      payload: { runId: '2026-09-13', mode: 'full', container: exportPlanFor('full')[0] },
    });
    const enqueuedContainers = store.upsertDoc.mock.calls.map(([, d]) => d.payload.container);
    expect(enqueuedContainers).toEqual(exportPlanFor('full'));

    // The run record is claimed first, and names the containers the manifest will wait for.
    expect(blobs.putJson.mock.calls[0][0]).toBe('full/2026-09-13/run.json');
    expect(blobs.putJson.mock.calls[0][2]).toEqual({ overwrite: false });
    expect(await blobs.readJson('full/2026-09-13/run.json')).toMatchObject({
      runId: '2026-09-13',
      mode: 'full',
      containers: exportPlanFor('full'),
    });
  });

  it('a weekday: the delta plan, 56 containers, without class C', async () => {
    const { s, store } = scheduler(MONDAY);
    expect(await s.run()).toMatchObject({ mode: 'delta', containers: 56, enqueued: 56 });
    const containers = store.upsertDoc.mock.calls.map(([, d]) => d.payload.container);
    for (const name of OPERATIONAL) expect(containers).not.toContain(name);
  });

  it('a second firing on the same UTC date enqueues nothing', async () => {
    const blobs = memBlobs();
    const first = scheduler(MONDAY, blobs);
    await first.s.run();
    const second = scheduler(MONDAY, blobs);
    expect(await second.s.run()).toEqual({
      runId: '2026-09-14',
      mode: 'delta',
      containers: 56,
      enqueued: 0,
      skipped: true,
    });
    expect(second.store.upsertDoc).not.toHaveBeenCalled();
    expect(second.messages).toEqual([]);
  });
});

describe('createContainerExporter — full run', () => {
  const docs = [
    { id: 'a', _ts: 100, title: 'x' },
    { id: 'b', _ts: 250, title: 'y' },
    { id: 'c', _ts: 200, title: 'z' },
  ];

  it('pages SELECT * into gzip NDJSON at the Cool tier, writes state before the marker, no manifest while markers are missing', async () => {
    const cosmos = memCosmos({
      pages: [docs.slice(0, 2), docs.slice(2)],
      checkpoint: 'cp-at-start',
    });
    const blobs = memBlobs({
      'full/2026-09-13/run.json': JSON.stringify({ containers: ['content', 'blogs'] }),
    });
    const log = { log: vi.fn(), warn: vi.fn() };
    let tick = 0;
    const now = () => new Date(SUNDAY.getTime() + 1000 * tick++);
    const exporter = createContainerExporter({ cosmos, blobs, now, log });

    const marker = await exporter.exportContainer({
      runId: '2026-09-13',
      mode: 'full',
      container: 'content',
    });

    expect(cosmos.calls.query).toEqual([
      { container: 'content', sql: 'SELECT * FROM c', opts: { maxItemCount: 500 } },
    ]);
    expect(cosmos.calls.feed).toEqual([]);
    expect(cosmos.calls.checkpoint).toEqual(['content']);

    expect(blobs.uploads).toHaveLength(1);
    const [upload] = blobs.uploads;
    expect(upload.name).toBe('full/2026-09-13/content.ndjson.gz');
    expect(upload.opts).toEqual({
      tier: 'Cool',
      metadata: { runId: '2026-09-13', mode: 'full', container: 'content' },
    });
    expect(ndjson(upload.text)).toEqual(docs);

    expect(marker).toMatchObject({
      container: 'content',
      mode: 'full',
      runId: '2026-09-13',
      docs: 3,
      bytes: upload.bytes,
      tsHighWater: 250,
      blob: 'full/2026-09-13/content.ndjson.gz',
      manifestWritten: false,
    });
    expect(marker.durationMs).toBeGreaterThan(0);
    expect(await blobs.readJson('full/2026-09-13/content.marker.json')).toMatchObject({
      docs: 3,
      tsHighWater: 250,
    });

    // The full stores the checkpoint taken BEFORE paging, and only after the upload.
    expect(await blobs.readJson('state/content.json')).toMatchObject({
      container: 'content',
      continuation: 'cp-at-start',
      mode: 'full',
      runId: '2026-09-13',
    });
    const order = blobs.putJson.mock.calls.map(([name]) => name);
    expect(order.indexOf('state/content.json')).toBeLessThan(
      order.indexOf('full/2026-09-13/content.marker.json')
    );
    expect(order).not.toContain('full/2026-09-13/manifest.json');

    // Nothing logged names a document.
    const logged = [...log.log.mock.calls, ...log.warn.mock.calls].flat().join('\n');
    expect(logged).not.toMatch(/\btitle\b|"id"|\ba\b, \bb\b/);
    expect(logged).toContain('content full/2026-09-13: 3 docs');
  });

  it('an empty container still produces a blob and a marker with zero docs', async () => {
    const cosmos = memCosmos({ pages: [] });
    const blobs = memBlobs();
    const exporter = createContainerExporter({ cosmos, blobs, now: () => SUNDAY });
    const marker = await exporter.exportContainer({
      runId: '2026-09-13',
      mode: 'full',
      container: 'audits',
    });
    expect(marker).toMatchObject({ docs: 0, tsHighWater: 0 });
    expect(blobs.uploads[0].text).toBe('');
    expect(blobs.blobs.has('full/2026-09-13/audits.marker.json')).toBe(true);
  });

  it('a read failure fails the job and writes neither state nor marker', async () => {
    const cosmos = {
      async *queryPages() {
        yield [{ id: 'a' }];
        throw new Error('429 throttled');
      },
      async *changeFeedPages() {},
      async changeFeedCheckpoint() {
        return 'cp';
      },
    };
    const blobs = memBlobs({ 'state/content.json': JSON.stringify({ continuation: 'old' }) });
    const exporter = createContainerExporter({ cosmos, blobs, now: () => SUNDAY });
    await expect(
      exporter.exportContainer({ runId: '2026-09-13', mode: 'full', container: 'content' })
    ).rejects.toThrow('429 throttled');
    expect(await blobs.readJson('state/content.json')).toEqual({ continuation: 'old' });
    expect(blobs.blobs.has('full/2026-09-13/content.marker.json')).toBe(false);
  });
});

describe('createContainerExporter — delta run', () => {
  it('reads the change feed from the stored continuation and stores the new one after the upload', async () => {
    const cosmos = memCosmos({
      feed: [
        { items: [{ id: 'a', _ts: 300 }], continuationToken: 'tok-1' },
        { items: [], continuationToken: 'tok-2' },
      ],
    });
    const blobs = memBlobs({ 'state/blogs.json': JSON.stringify({ continuation: 'tok-0' }) });
    const log = { log: vi.fn(), warn: vi.fn() };
    const exporter = createContainerExporter({ cosmos, blobs, now: () => MONDAY, log });

    const marker = await exporter.exportContainer({
      runId: '2026-09-14',
      mode: 'delta',
      container: 'blogs',
    });

    expect(cosmos.calls.feed).toEqual([
      { container: 'blogs', from: { continuation: 'tok-0' }, opts: { maxItemCount: 500 } },
    ]);
    expect(cosmos.calls.checkpoint).toEqual([]);
    expect(ndjson(blobs.uploads[0].text)).toEqual([{ id: 'a', _ts: 300 }]);
    expect(marker).toMatchObject({ mode: 'delta', docs: 1, tsHighWater: 300 });
    expect(await blobs.readJson('state/blogs.json')).toMatchObject({
      continuation: 'tok-2',
      mode: 'delta',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('exports every item across an empty mid-feed page and stores the final (304) continuation', async () => {
    const cosmos = memCosmos({
      feed: [
        { items: [{ id: 'a', _ts: 1 }], continuationToken: 't1' },
        { items: [], continuationToken: 't2' },
        {
          items: [
            { id: 'b', _ts: 2 },
            { id: 'c', _ts: 3 },
          ],
          continuationToken: 't3',
        },
        { items: [], continuationToken: 't4' },
      ],
    });
    const blobs = memBlobs({ 'state/blogs.json': JSON.stringify({ continuation: 'tok-0' }) });
    const exporter = createContainerExporter({ cosmos, blobs, now: () => MONDAY });
    const marker = await exporter.exportContainer({
      runId: '2026-09-14',
      mode: 'delta',
      container: 'blogs',
    });
    expect(ndjson(blobs.uploads[0].text).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(marker).toMatchObject({ docs: 3, tsHighWater: 3 });
    expect(await blobs.readJson('state/blogs.json')).toMatchObject({ continuation: 't4' });
  });

  it('with no stored state it reads from the beginning and says so', async () => {
    const cosmos = memCosmos({ feed: [{ items: [{ id: 'a' }], continuationToken: 'tok-1' }] });
    const blobs = memBlobs();
    const log = { log: vi.fn(), warn: vi.fn() };
    const exporter = createContainerExporter({ cosmos, blobs, now: () => MONDAY, log });
    await exporter.exportContainer({ runId: '2026-09-14', mode: 'delta', container: 'blogs' });
    expect(cosmos.calls.feed[0].from).toEqual({ continuation: null });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('blogs: no stored continuation'));
    expect(await blobs.readJson('state/blogs.json')).toMatchObject({ continuation: 'tok-1' });
  });

  it('a feed that hands back no token leaves the old continuation in place', async () => {
    const cosmos = memCosmos({ feed: [{ items: [], continuationToken: undefined }] });
    const blobs = memBlobs({
      'state/blogs.json': JSON.stringify({ continuation: 'tok-0', mode: 'full' }),
    });
    const exporter = createContainerExporter({ cosmos, blobs, now: () => MONDAY });
    const marker = await exporter.exportContainer({
      runId: '2026-09-14',
      mode: 'delta',
      container: 'blogs',
    });
    expect(marker.docs).toBe(0);
    expect(await blobs.readJson('state/blogs.json')).toEqual({
      continuation: 'tok-0',
      mode: 'full',
    });
  });

  it('a failed upload leaves the old continuation so the next delta re-reads the same changes', async () => {
    const cosmos = memCosmos({ feed: [{ items: [{ id: 'a' }], continuationToken: 'tok-1' }] });
    const blobs = memBlobs({ 'state/blogs.json': JSON.stringify({ continuation: 'tok-0' }) });
    blobs.uploadGzipStream = async (_name, stream) => {
      for await (const _chunk of stream) {
        // drain, then fail as the service would
      }
      throw new Error('503 ServerBusy');
    };
    const exporter = createContainerExporter({ cosmos, blobs, now: () => MONDAY });
    await expect(
      exporter.exportContainer({ runId: '2026-09-14', mode: 'delta', container: 'blogs' })
    ).rejects.toThrow('503 ServerBusy');
    expect(await blobs.readJson('state/blogs.json')).toEqual({ continuation: 'tok-0' });
  });
});

describe('run completion', () => {
  const run = { runId: '2026-09-14', mode: 'delta' };
  const markerFor = (container, docs, bytes) => ({
    [`delta/2026-09-14/${container}.marker.json`]: JSON.stringify({
      container,
      docs,
      bytes,
      tsHighWater: 10,
      durationMs: 5,
    }),
  });

  it('the worker that finds every marker writes the manifest once and emits cosmosExportCompleted', async () => {
    const blobs = memBlobs({
      'delta/2026-09-14/run.json': JSON.stringify({ containers: ['blogs', 'content'] }),
      ...markerFor('blogs', 2, 100),
    });
    const tracker = { trackEvent: vi.fn(async () => true) };
    const cosmos = memCosmos({ feed: [{ items: [{ id: 'x' }], continuationToken: 't' }] });
    const exporter = createContainerExporter({ cosmos, blobs, tracker, now: () => MONDAY });

    const marker = await exporter.exportContainer({ ...run, container: 'content' });
    expect(marker.manifestWritten).toBe(true);

    const manifest = await blobs.readJson('delta/2026-09-14/manifest.json');
    expect(manifest).toMatchObject({
      runId: '2026-09-14',
      mode: 'delta',
      docs: 3,
      bytes: 100 + marker.bytes,
      completedAt: MONDAY.toISOString(),
    });
    expect(manifest.containers.map((c) => c.container)).toEqual(['blogs', 'content']);
    expect(manifest.containers[0]).toEqual({
      container: 'blogs',
      docs: 2,
      bytes: 100,
      tsHighWater: 10,
      durationMs: 5,
    });

    expect(tracker.trackEvent).toHaveBeenCalledTimes(1);
    const [name, props] = tracker.trackEvent.mock.calls[0];
    expect(name).toBe(EXPORT_EVENT);
    expect(props).toEqual({
      mode: 'delta',
      runId: '2026-09-14',
      containers: 2,
      docs: 3,
      bytes: manifest.bytes,
      durationMs: manifest.durationMs,
    });
    // Written with overwrite off, so a racing worker cannot write it twice.
    const manifestPut = blobs.putJson.mock.calls.find(
      ([n]) => n === 'delta/2026-09-14/manifest.json'
    );
    expect(manifestPut[2]).toEqual({ overwrite: false });
  });

  it('with a marker still missing nothing is written and no event is sent', async () => {
    const blobs = memBlobs({
      'delta/2026-09-14/run.json': JSON.stringify({ containers: ['blogs', 'content', 'system'] }),
    });
    const tracker = { trackEvent: vi.fn(async () => true) };
    const exporter = createContainerExporter({
      cosmos: memCosmos(),
      blobs,
      tracker,
      now: () => MONDAY,
    });
    await exporter.exportContainer({ ...run, container: 'content' });
    expect(await exporter.completeRunIfLast(run)).toEqual({
      written: false,
      reason: 'incomplete',
      missing: 2,
    });
    expect(blobs.blobs.has('delta/2026-09-14/manifest.json')).toBe(false);
    expect(tracker.trackEvent).not.toHaveBeenCalled();
  });

  it('a manifest already present is left alone; losing the write race is silent', async () => {
    const blobs = memBlobs({
      'delta/2026-09-14/run.json': JSON.stringify({ containers: ['blogs'] }),
      ...markerFor('blogs', 1, 1),
      'delta/2026-09-14/manifest.json': JSON.stringify({ docs: 1 }),
    });
    const tracker = { trackEvent: vi.fn(async () => true) };
    const exporter = createContainerExporter({
      cosmos: memCosmos(),
      blobs,
      tracker,
      now: () => MONDAY,
    });
    expect(await exporter.completeRunIfLast(run)).toEqual({ written: false, reason: 'exists' });

    const racing = memBlobs({
      'delta/2026-09-14/run.json': JSON.stringify({ containers: ['blogs'] }),
      ...markerFor('blogs', 1, 1),
    });
    racing.putJson = vi.fn(async () => false);
    const loser = createContainerExporter({
      cosmos: memCosmos(),
      blobs: racing,
      tracker,
      now: () => MONDAY,
    });
    expect(await loser.completeRunIfLast(run)).toEqual({ written: false, reason: 'lost-race' });
    expect(tracker.trackEvent).not.toHaveBeenCalled();
  });

  it('without a run record it waits for the plan of that mode', async () => {
    const blobs = memBlobs(
      Object.assign({}, ...exportPlanFor('delta').map((c) => markerFor(c, 1, 1)))
    );
    const tracker = { trackEvent: vi.fn(async () => true) };
    const exporter = createContainerExporter({
      cosmos: memCosmos(),
      blobs,
      tracker,
      now: () => MONDAY,
    });
    const result = await exporter.completeRunIfLast(run);
    expect(result).toEqual({ written: true, tracked: true });
    expect((await blobs.readJson('delta/2026-09-14/manifest.json')).containers).toHaveLength(56);
  });
});
