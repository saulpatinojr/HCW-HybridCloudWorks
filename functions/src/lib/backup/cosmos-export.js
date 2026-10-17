/**
 * cosmos-export.js — the out-of-account Cosmos export (ADR 0028, issue #231).
 *
 * WHAT IT DOES. Once a day a timer decides `full` (Sunday) or `delta` (every
 * other day), mints a run id from the UTC date, and enqueues one platform job
 * per exported container (`export-classification.js` says which). Each job
 * reads ONE container — a full run pages `SELECT * FROM c`, a delta run reads
 * the change feed from the continuation stored by the previous run — and
 * streams every document as one line of gzip-compressed NDJSON into a block
 * blob under `full/<run>/` or `delta/<run>/` in the private `cosmos-export`
 * container on the RA-GRS content account. The job ends by writing a marker
 * blob beside the data; the worker that finds every marker of its run present
 * writes the run manifest and emits one `cosmosExportCompleted` event, which
 * is what the missing-run alert counts.
 *
 * WHY THE CONTINUATION IS STORED ONLY AFTER THE BLOB. A delta that advanced
 * its continuation and then failed to write would skip those documents on
 * every later run — silently, forever. The state blob is written after the
 * upload resolves, so a failed upload leaves the old continuation in place and
 * the next delta re-reads the same changes. Re-reading is harmless: a restore
 * upserts by id, and a document exported twice restores once.
 *
 * WHY A FULL RUN ALSO STORES A CONTINUATION. Deltas need a point to read
 * from, and "since the last delta" is the wrong point after a full: the full
 * IS the baseline, so the first delta after it should carry what changed since
 * the full began. The full run takes a change-feed checkpoint at `Now()`
 * before it starts paging, and stores that as the continuation once the blob
 * is written. A document written while the full was paging is either in the
 * full or in the next delta or both; never in neither.
 *
 * WHY A DELTA WITH NO STORED STATE READS FROM THE BEGINNING. It happens once:
 * the first run of the exporter on a weekday, or a container newly added to
 * the classification. Reading the change feed from the beginning costs one
 * full read of that container and guarantees nothing is skipped; starting
 * from `Now()` would guarantee the opposite. The run logs it.
 *
 * WHAT IS NEVER LOGGED. Container names, counts, byte totals, durations and
 * status codes. Never a document id, never a field. The marker carries the
 * `_ts` high-water mark, which is a time, not an identifier.
 *
 * Pure core over injected edges: `cosmos` (page readers) and `blobs`
 * (upload, JSON put/get, list) are constructed in `cosmos-export-edges.js`
 * from `cosmos-client.js` and `blob-storage.js`; the tests below hand in
 * in-memory fakes and read the gzip back.
 */
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { EXPORT_MODES, exportPlanFor } from './export-classification.js';

/** The private blob container on `stsiteprodcus01` (Terraform: infra/storage.tf). */
export const EXPORT_CONTAINER = 'cosmos-export';
/** The private blob container for change-feed continuation tokens (PLAT-8, #968). */
export const EXPORT_STATE_CONTAINER = 'cosmos-export-state';
/** The platform job type one message per container is enqueued as. */
export const EXPORT_JOB_TYPE = 'cosmos-export-container';
/** The Application Insights custom event the missing-run alert counts. */
export const EXPORT_EVENT = 'cosmosExportCompleted';
/** Stamped on the job documents the scheduler creates. */
export const EXPORT_ACTOR = Object.freeze({ oid: null, email: 'cosmos-export@system' });
/** Documents per page on both the query and the change feed. */
export const PAGE_SIZE = 500;

const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;

// ── Naming ───────────────────────────────────────────────────────────────────

/** UTC calendar date, `YYYY-MM-DD` — the run id. */
export function runIdFor(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Sunday (UTC) is the weekly full; every other day is a delta. */
export function modeFor(date) {
  return new Date(date).getUTCDay() === 0 ? 'full' : 'delta';
}

/** `full/2026-09-13/` or `delta/2026-09-14/`. */
export function runPrefix(mode, runId) {
  return `${mode}/${runId}/`;
}

/**
 * Every blob one container job touches.
 * @param {{ mode: string, runId: string, container: string }} args
 */
export function blobNames({ mode, runId, container }) {
  const prefix = runPrefix(mode, runId);
  return {
    prefix,
    data: `${prefix}${container}.ndjson.gz`,
    marker: `${prefix}${container}.marker.json`,
    manifest: `${prefix}manifest.json`,
    run: `${prefix}run.json`,
    state: `state/${container}.json`,
  };
}

/**
 * Validate a queue payload into `{ runId, mode, container }`. Throws on
 * anything else — including a container that is not in this mode's plan, so
 * a hand-enqueued job cannot export a container the classification excludes.
 */
export function parseExportPayload(payload = {}) {
  const mode = String(payload?.mode || '');
  const runId = String(payload?.runId || '');
  const container = String(payload?.container || '');
  if (!EXPORT_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${EXPORT_MODES.join(', ')}`);
  }
  if (!RUN_ID.test(runId)) throw new Error('runId must be a UTC date, YYYY-MM-DD');
  if (!exportPlanFor(mode).includes(container)) {
    throw new Error(`${container || '(empty)'} is not exported on a ${mode} run`);
  }
  return { runId, mode, container };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function }} deps.store - the `jobs` container writer
 * @param {{ putJson: Function }} deps.blobs - export blob store (run record)
 * @param {(message: {jobId: string, type: string}) => void} deps.enqueue - queue output
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {(mode: string) => string[]} [deps.plan]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createExportScheduler({
  store,
  blobs,
  enqueue,
  now = () => new Date(),
  uuid = randomUUID,
  plan = exportPlanFor,
  log = {},
}) {
  /**
   * Enqueue one job per container for today's run. Idempotent per run id:
   * the run record `<prefix>run.json` is written first with overwrite off,
   * and a second firing on the same UTC date (a host restart replaying the
   * schedule) finds it present and enqueues nothing.
   */
  async function run() {
    const at = now();
    const runId = runIdFor(at);
    const mode = modeFor(at);
    const containers = plan(mode);
    const names = blobNames({ mode, runId, container: '' });

    const claimed = await blobs.putJson(
      names.run,
      { runId, mode, containers, enqueuedAt: at.toISOString() },
      { overwrite: false }
    );
    if (!claimed) {
      log.log?.(`[cosmosExport] run ${mode}/${runId} already scheduled — skipping`);
      return { runId, mode, containers: containers.length, enqueued: 0, skipped: true };
    }

    let enqueued = 0;
    for (const container of containers) {
      const jobId = uuid();
      // newJobDoc, as every writer of a job document: the same shape, and the
      // type's payload bound held here too (#942 follow-up).
      await store.upsertDoc(
        JOBS_CONTAINER,
        newJobDoc({
          id: jobId,
          type: EXPORT_JOB_TYPE,
          payload: { runId, mode, container },
          requestedBy: EXPORT_ACTOR,
          createdAt: now().toISOString(),
        })
      );
      enqueue({ jobId, type: EXPORT_JOB_TYPE });
      enqueued += 1;
    }
    log.log?.(`[cosmosExport] run ${mode}/${runId}: enqueued ${enqueued} container job(s)`);
    return { runId, mode, containers: containers.length, enqueued, skipped: false };
  }

  return { run };
}

// ── Container worker ─────────────────────────────────────────────────────────

/**
 * @typedef {object} CosmosReader
 * @property {(container: string, sql: string, opts: {maxItemCount: number}) => AsyncIterable<object[]>} queryPages
 * @property {(container: string, from: {continuation?: string|null}, opts: {maxItemCount: number}) => AsyncIterable<{items: object[], continuationToken?: string}>} changeFeedPages
 * @property {(container: string) => Promise<string|undefined>} changeFeedCheckpoint - a continuation at "now"
 */

/**
 * @typedef {object} ExportBlobStore
 * @property {(name: string, stream: import('node:stream').Readable, opts: {tier?: string, metadata?: Record<string,string>}) => Promise<void>} uploadGzipStream
 * @property {(name: string, value: object, opts?: {overwrite?: boolean}) => Promise<boolean>} putJson - false when overwrite is off and the blob exists
 * @property {(name: string) => Promise<object|null>} readJson - null when absent
 * @property {(prefix: string) => Promise<string[]>} listNames
 */

/**
 * @param {object} deps
 * @param {CosmosReader} deps.cosmos
 * @param {ExportBlobStore} deps.blobs
 * @param {{ trackEvent: (name: string, props: object) => Promise<boolean> }} [deps.tracker]
 * @param {() => Date} [deps.now]
 * @param {(mode: string) => string[]} [deps.plan]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 * @param {number} [deps.pageSize]
 */
export function createContainerExporter({
  cosmos,
  blobs,
  tracker = { trackEvent: async () => false },
  now = () => new Date(),
  plan = exportPlanFor,
  log = {},
  pageSize = PAGE_SIZE,
  signal: defaultSignal,
}) {
  /**
   * Export one container for one run and write its marker. Returns the
   * marker (small, id-free) as the job result.
   * @param {{ runId: string, mode: 'full'|'delta', container: string, signal?: AbortSignal }} job
   */
  async function exportContainer({ runId, mode, container, signal: callSignal }) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const names = blobNames({ mode, runId, container });
    const startedAt = now();
    const stats = { docs: 0, rawBytes: 0, bytes: 0, tsHighWater: 0 };

    // The continuation to store once the blob is safely written.
    let nextContinuation = null;
    let priorState = null;
    let source;
    if (mode === 'full') {
      nextContinuation = (await cosmos.changeFeedCheckpoint(container)) ?? null;
      source = fullPages(container);
    } else {
      priorState = await blobs.readJson(names.state);
      const continuation = priorState?.continuation || null;
      if (!continuation) {
        log.warn?.(
          `[cosmosExport] ${container}: no stored continuation — reading the change feed from the beginning`
        );
      }
      source = deltaPages(container, continuation, (token) => {
        if (token) nextContinuation = token;
      });
    }

    const lines = ndjsonLines(source, stats, activeSignal);
    const gzip = createGzip();
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        stats.bytes += chunk.length;
        callback(null, chunk);
      },
    });
    const metadata = { runId, mode, container };
    // pipeline() propagates a read failure into the counter stream, so the
    // upload rejects too; an upload failure destroys the counter, so the
    // pipeline ends instead of stalling on backpressure. Promise.all surfaces
    // whichever failed first.
    await Promise.all([
      pipeline(Readable.from(lines), gzip, counter),
      blobs.uploadGzipStream(names.data, counter, { tier: 'Cool', metadata }).catch((error) => {
        counter.destroy(error);
        throw error;
      }),
    ]);

    // Only now — the blob is written — does the continuation move.
    if (nextContinuation) {
      await blobs.putJson(names.state, {
        container,
        continuation: nextContinuation,
        mode,
        runId,
        storedAt: now().toISOString(),
      });
    } else if (mode === 'delta' && priorState) {
      // The feed handed back no token (nothing changed); the old one stands.
      log.log?.(`[cosmosExport] ${container}: continuation unchanged`);
    }

    const durationMs = now().getTime() - startedAt.getTime();
    const marker = {
      container,
      mode,
      runId,
      docs: stats.docs,
      bytes: stats.bytes,
      rawBytes: stats.rawBytes,
      tsHighWater: stats.tsHighWater,
      durationMs,
      blob: names.data,
      completedAt: now().toISOString(),
    };
    await blobs.putJson(names.marker, marker);
    log.log?.(
      `[cosmosExport] ${container} ${mode}/${runId}: ${marker.docs} docs, ${marker.bytes} bytes gzip, ${durationMs} ms`
    );

    const completion = await completeRunIfLast({ mode, runId });
    return { ...marker, manifestWritten: completion.written };
  }

  async function* fullPages(container) {
    for await (const page of cosmos.queryPages(container, 'SELECT * FROM c', {
      maxItemCount: pageSize,
    })) {
      yield page;
    }
  }

  async function* deltaPages(container, continuation, onToken) {
    for await (const page of cosmos.changeFeedPages(
      container,
      { continuation },
      { maxItemCount: pageSize }
    )) {
      onToken(page.continuationToken);
      if (page.items?.length) yield page.items;
    }
  }

  async function* ndjsonLines(pages, stats, signal) {
    for await (const page of pages) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      for (const doc of page) {
        const line = `${JSON.stringify(doc)}\n`;
        stats.docs += 1;
        stats.rawBytes += Buffer.byteLength(line);
        if (typeof doc?._ts === 'number' && doc._ts > stats.tsHighWater)
          stats.tsHighWater = doc._ts;
        yield line;
      }
    }
  }

  /**
   * Write the run manifest if this worker is the one that finds every
   * marker present, and emit the completion event once. The manifest is
   * written with overwrite off, so two workers finishing together race
   * safely: one wins, the other sees `false` and stays quiet.
   */
  async function completeRunIfLast({ mode, runId }) {
    const names = blobNames({ mode, runId, container: '' });
    const run = await blobs.readJson(names.run);
    const expected =
      Array.isArray(run?.containers) && run.containers.length ? run.containers : plan(mode);
    const present = new Set(await blobs.listNames(names.prefix));
    if (present.has(names.manifest)) return { written: false, reason: 'exists' };

    const missing = expected.filter(
      (container) => !present.has(blobNames({ mode, runId, container }).marker)
    );
    if (missing.length) return { written: false, reason: 'incomplete', missing: missing.length };

    const containers = [];
    for (const container of expected) {
      const marker = await blobs.readJson(blobNames({ mode, runId, container }).marker);
      containers.push({
        container,
        docs: Number(marker?.docs) || 0,
        bytes: Number(marker?.bytes) || 0,
        tsHighWater: Number(marker?.tsHighWater) || 0,
        durationMs: Number(marker?.durationMs) || 0,
      });
    }
    const manifest = {
      runId,
      mode,
      containers,
      docs: containers.reduce((n, c) => n + c.docs, 0),
      bytes: containers.reduce((n, c) => n + c.bytes, 0),
      durationMs: containers.reduce((n, c) => n + c.durationMs, 0),
      completedAt: now().toISOString(),
    };
    const won = await blobs.putJson(names.manifest, manifest, { overwrite: false });
    if (!won) return { written: false, reason: 'lost-race' };

    log.log?.(
      `[cosmosExport] run ${mode}/${runId} complete: ${containers.length} containers, ${manifest.docs} docs, ${manifest.bytes} bytes gzip, ${manifest.durationMs} ms of worker time`
    );
    const tracked = await tracker.trackEvent(EXPORT_EVENT, {
      mode,
      runId,
      containers: containers.length,
      docs: manifest.docs,
      bytes: manifest.bytes,
      durationMs: manifest.durationMs,
    });
    return { written: true, tracked };
  }

  return { exportContainer, completeRunIfLast };
}
