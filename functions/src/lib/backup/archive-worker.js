/**
 * archive-worker.js — one job of the yearly content archive: write one
 * container's file, check it, and note it (ADR 0046 section 4, issue #1811).
 * The whole job, and why it runs in this order, is described in
 * archive-job.js, which re-exports `createArchiveWorker`.
 *
 * The helpers below take the worker's `deps` first:
 * `{ backupBlobs, archiveBlobs, env, now, log, notifier }`.
 */
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { withStatus } from '../http/error-response.js';
import { DECISIONS, REASONS, archiveDecisionFor, archiveRecord } from './archive-classification.js';
import { backupRecords, contentIndexFor, readBack } from './archive-file-read.js';
import { archiveNames, bump, count, noteMatches, switchOn, validRun, yearState } from './archive-run-notes.js';
import { completeIfLast, moveToArchiveTier } from './archive-manifest.js';

/**
 * @param {object} deps
 * @param {{ readJson: Function, putJson: Function, listNames: Function, readGzipStream: Function }} deps.backupBlobs -
 *   the export blob store: the backup's files, and the run's working notes
 * @param {{ readJson: Function, putJson: Function, readGzipStream: Function, uploadGzipStream: Function, listDetails: Function, setTier: Function, containerExists: Function }} deps.archiveBlobs -
 *   a blob store on `content-archive`
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 */
export function createArchiveWorker({ backupBlobs, archiveBlobs, env = process.env, now = () => new Date(), log = {}, notifier = null }) {
  const deps = { backupBlobs, archiveBlobs, env, now, log, notifier };
  return {
    archiveContainer: (job) => archiveContainer(deps, job),
    completeIfLast: (args) => completeIfLast(deps, args),
    moveToArchiveTier: (args) => moveToArchiveTier(deps, args),
  };
}

/** A job that did not write, and why. Fixed words only. */
const skipped = ({ log }, container, reason) => {
  log.log?.(`[contentArchive] ${container}: nothing written (${reason})`);
  return { container, written: false, skipped: reason };
};

/** What is in storage under this file's name right now, or null. */
async function storedDetails({ archiveBlobs }, name) {
  return (await archiveBlobs.listDetails(name)).find((file) => file.name === name) || null;
}

/**
 * Write one container's file of one year's archive, check it, and note it.
 * @param {{ year: number, runId: string, container: string, signal?: AbortSignal }} job
 */
async function archiveContainer(deps, { year, runId, container, signal }) {
  const ready = await jobReadiness(deps, { year, runId, container, signal });
  if (ready.skip) return skipped(deps, container, ready.skip);
  const { decision, names, run, there } = ready;

  const earlier = await deps.backupBlobs.readJson(names.note);
  if (noteMatches(earlier, run, container) && there && there.etag === earlier.etag) {
    const completion = await completeIfLast(deps, { year });
    return { ...skipped(deps, container, 'already-written'), manifestWritten: completion.written };
  }

  const startedAt = deps.now();
  const file = await writeAndCheck(deps, { year, runId, container, signal, names, run, there });
  // Asked again, now that minutes have passed: nothing is noted once the
  // owner has switched the archive off, or the year has its manifest.
  const late = file.skip || (await lateSkip(deps, names));
  if (late) return skipped(deps, container, late);

  const durationMs = deps.now().getTime() - startedAt.getTime();
  await writeNote(deps, { year, runId, container, names, run, decision, file, durationMs });
  const { stats } = file;
  deps.log.log?.(
    `[contentArchive] ${container}: ${stats.read} read, ${stats.kept} written, ${stats.changed} with fields removed, ${stats.leftOut} left out, ${stats.bytes} bytes gzip, ${durationMs} ms`
  );
  const completion = await completeIfLast(deps, { year });
  return {
    container,
    written: true,
    read: stats.read,
    records: stats.kept,
    changed: stats.changed,
    leftOut: stats.leftOut,
    bytes: stats.bytes,
    durationMs,
    manifestWritten: completion.written,
  };
}

/**
 * Everything checked before a job writes. Returns `{ skip }` with the reason
 * a job writes nothing, or `{ decision, names, run, there }`; throws for a
 * container the archive never writes.
 */
async function jobReadiness(deps, { year, runId, container, signal }) {
  const { backupBlobs, archiveBlobs, env } = deps;
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  // The switch is read again here, not only by the daily check: a job that
  // was queued before the owner switched the archive off must not write.
  if (!switchOn(env)) return { skip: 'switch-off' };
  // The classification decides, here as in the dry run. A container that is
  // not classified, or is left out, has no file in an archive.
  const decision = archiveDecisionFor(container);
  if (!decision || decision.decision === DECISIONS.leaveOut) {
    throw withStatus(new Error('that container is not written by the content archive'), 400);
  }
  const names = archiveNames(year, container);
  const stateSkip = yearSkip(await yearState(archiveBlobs, year));
  if (stateSkip) return { skip: stateSkip };
  const run = await backupBlobs.readJson(names.run);
  if (!isRunFor(run, { year, runId, container })) return { skip: 'not-this-run' };

  // What is in storage under this file's name right now, if anything. Its
  // version stamp (ETag) changes on every write, so it says exactly which
  // write a note vouches for, and which one this job may replace.
  const there = await storedDetails(deps, names.data);
  return { decision, names, run, there };
}

/** Why a year cannot take a file, or null when it can. */
function yearSkip(state) {
  if (!state.containerExists) return 'archive-container-missing';
  // A finished year is never written to again.
  if (state.archived) return 'already-archived';
  return null;
}

/** Is `run` today's valid run of that year, from that backup, listing that container? */
function isRunFor(run, { year, runId, container }) {
  return validRun(run, year) && run.backup.runId === runId && run.containers.includes(container);
}

/** The switch and the manifest, asked again once the file is written. */
async function lateSkip({ archiveBlobs, env }, names) {
  if (!switchOn(env)) return 'switch-off';
  if ((await archiveBlobs.readJson(names.manifest)) !== null) return 'already-archived';
  return null;
}

/**
 * Stream the kept records of one container into its archive file, then read
 * the stored file back and check it. Returns `{ skip }` when storage refused
 * the write because another job wrote the file, otherwise
 * `{ stats, sha256, written }`.
 */
async function writeAndCheck(deps, { year, runId, container, signal, names, run, there }) {
  const expected = (run.backup.containers || []).find((row) => row?.container === container);
  const stats = { read: 0, kept: 0, changed: 0, leftOut: 0, leftOutBy: {}, removed: {}, unreadable: 0, rawBytes: 0, bytes: 0 };
  const contentIndex = container === 'content_versions' ? await contentIndexFor(deps, runId, signal) : null;
  const lines = keptLines(deps, { runId, container, signal, contentIndex, expected, stats });

  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      stats.bytes += chunk.length;
      callback(null, chunk);
    },
  });
  // No tier is asked for, so the file is written online. It moves to the
  // Archive tier only after the manifest exists (moveToArchiveTier).
  // pipeline() carries a read failure into `tap`, so the upload fails too;
  // an upload failure destroys `tap`, so the pipeline ends instead of
  // waiting for ever. Promise.all gives whichever failed first.
  // The write is conditional: only when no file has this name, or only
  // over the exact version this job saw when it started. So of two jobs
  // writing one container at once, storage lets one finish, and a job that
  // is late cannot write over a file another job has since written.
  const [, committed] = await Promise.all([
    pipeline(Readable.from(lines), createGzip(), tap),
    deps.archiveBlobs
      .uploadGzipStream(names.data, tap, {
        metadata: { year: String(year), sourcerun: runId },
        conditions: there?.etag ? { ifMatch: there.etag } : { ifNoneMatch: '*' },
      })
      .catch((error) => {
        tap.destroy(error);
        throw error;
      }),
  ]);
  if (committed === false) return { skip: 'another-job-wrote-it' };
  const sha256 = hash.digest('hex');

  // The third check, which needs the stored file: read it back. A file
  // that fails here stays under its name, uncounted (it gets no note), and
  // the next job for this container replaces it.
  assertReadBack(await readBack(deps, names.data), sha256, stats);
  const written = await storedDetails(deps, names.data);
  if (!written?.etag || written.size !== stats.bytes) {
    throw new Error('the archive file changed in storage while it was being checked');
  }
  return { stats, sha256, written };
}

function assertReadBack(stored, sha256, stats) {
  if (!stored || stored.sha256 !== sha256 || stored.bytes !== stats.bytes || stored.records !== stats.kept) {
    throw new Error('the archive file read back from storage is not the file that was written');
  }
}

/** The kept records of one container as NDJSON lines, counted into `stats`. */
async function* keptLines(deps, { runId, container, signal, contentIndex, expected, stats }) {
  for await (const doc of backupRecords(deps, runId, container, signal)) {
    const line = keptLine(stats, container, doc, contentIndex);
    if (line !== null) yield line;
  }
  // Two checks while the upload is still open. Throwing here fails the
  // stream, so storage is never told to keep the file: a file that fails
  // either check is not left in `content-archive`.
  if (stats.unreadable > 0) {
    throw new Error('a line of the backup file could not be read as a record, so the archive file is not written');
  }
  if (expected && count(expected.docs) !== stats.read) {
    throw new Error('the backup file holds a different number of records than the backup’s own list says');
  }
}

/** Count one record into `stats`; answers its line, or null when it is not kept. */
function keptLine(stats, container, doc, contentIndex) {
  stats.read += 1;
  if (doc === undefined) {
    stats.unreadable += 1;
    return null;
  }
  const result = archiveRecord(container, doc, { contentIndex });
  if (!result.keep) {
    stats.leftOut += 1;
    bump(stats.leftOutBy, result.reason || REASONS.unlisted);
    return null;
  }
  stats.kept += 1;
  if (result.removed.length) {
    stats.changed += 1;
    for (const field of result.removed) bump(stats.removed, field);
  }
  // `result.doc` is the record as the classification returns it: whole
  // for a container kept as it is, or only the listed fields.
  const line = `${JSON.stringify(result.doc)}\n`;
  stats.rawBytes += Buffer.byteLength(line);
  return line;
}

/** The small note that says this container's file is written and checked. */
async function writeNote({ backupBlobs, now }, { year, runId, container, names, run, decision, file, durationMs }) {
  const { stats, sha256, written } = file;
  await backupBlobs.putJson(names.note, {
    container,
    year,
    sourceRun: runId,
    // The rules the file was written under, and the exact version of it that was checked.
    rules: run.rules,
    etag: written.etag,
    file: names.data,
    decision: decision.decision,
    records: stats.kept,
    bytes: stats.bytes,
    rawBytes: stats.rawBytes,
    sha256,
    read: stats.read,
    changed: stats.changed,
    leftOut: stats.leftOut,
    leftOutBy: stats.leftOutBy,
    removed: stats.removed,
    durationMs,
    completedAt: now().toISOString(),
  });
}
