/**
 * archive-job.js — the job that writes the yearly content archive
 * (ADR 0046 section 4, issue #1811).
 *
 * WHAT AN ARCHIVE IS. A long-term copy of the site's content, one folder per
 * calendar year in the private `content-archive` blob container:
 *
 *   <year>/cosmos/<container>.ndjson.gz   one file per database container:
 *                                         one record per line as JSON, then
 *                                         gzip-compressed (the backup's format)
 *   <year>/manifest.json                  the list of those files with their
 *                                         record counts, sizes and sha256
 *                                         (a fingerprint of the file's bytes)
 *
 * It is made from the newest complete weekly full backup, never from the live
 * database, and only from the containers and records the classification
 * keeps (archive-classification.js `archiveRecord`, the same function the dry
 * run uses; no rule is written a second time here).
 *
 * THE ORDER, AND WHY. (1) Each container's job writes its file as an
 * ordinary online file, then reads it back and checks the sha256 and the
 * record count. (2) Only when every file is checked is `manifest.json`
 * written, create-only. The manifest is what "this year is archived" means.
 * (3) Only then is each data file moved to the Archive tier, Azure's
 * cheapest, where a file is offline and cannot be read or fixed for hours.
 * Checking before the move is the only cheap moment to check. The manifest
 * stays online.
 *
 * HOW IT STARTS. By itself, once a day: the nightly export's timer
 * (functions/cosmos-export.js, 03:00 UTC) calls `createArchiveScheduler().run()`
 * after it has queued the export. So there is no second timer and no second
 * switch: the archive's own switch is the app setting CONTENT_ARCHIVE_ENABLED
 * (it ships "false"), and with the nightly export off there is no backup to
 * read and nothing runs. The start rule is `archiveStartDecision`
 * (archive-report.js).
 *
 * NEVER FROM A STATE NO REPORT DESCRIBES. An archive starts only when the
 * newest dry-run report is finished, was made from the very backup the
 * archive would read, and shows nothing still to decide: no container
 * waiting for the owner, no flagged field in a container the owner has not
 * decided about, and no count that disagrees with the backup (`reportGate`).
 * When a report is all that is missing, the daily check starts the dry run
 * itself and the archive starts a day later. When the report shows something
 * to decide, nothing starts and the owner is told.
 *
 * RUNNING TWICE DOES NO HARM. File names are fixed by year and container.
 * A job that finds its file already checked skips it. A job never writes
 * once the year's manifest exists, so a finished year is never overwritten.
 * A run that stopped half-way has archived nothing; the next day's check
 * queues only the containers still missing, and writes the manifest itself
 * if every file is there.
 *
 * ONE BACKUP PER ARCHIVE. The first check pins the backup it will read
 * (`state/archive-run/<year>/run.json`), so a run that takes two days is not
 * made from two different Sundays. If the pinned backup has since been
 * deleted (backups are kept 35 days) the run starts again from the newest
 * one; a file written from the old backup is not counted and is replaced.
 *
 * WHERE THE WORKING NOTES LIVE. In the private `cosmos-export-state`
 * container, under `state/archive-run/<year>/`, beside the dry run's
 * reports: the pinned run and one small note per finished file. So
 * `content-archive` holds only the archive itself.
 *
 * WHAT IS NEVER LOGGED OR STORED OUTSIDE THE DATA FILES. A record, the id of
 * a record or a field's value. Logs, notes and the manifest carry container
 * names, field names the code itself writes, counts, sizes and times.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { withStatus } from '../http/error-response.js';
import { blobNames } from './cosmos-export.js';
import {
  DECISIONS,
  REASONS,
  archiveDecisionFor,
  archivePlan,
  archiveRecord,
  classificationFingerprint,
  createContentIndex,
} from './archive-classification.js';
import {
  ARCHIVE_CONTAINER,
  ARCHIVE_SETTING,
  archiveManifestName,
  archiveStartDecision,
  archiveYearFor,
  createReportScheduler,
  findLatestFullBackup,
  gzipLines,
  readLatestReport,
  reportGate,
} from './archive-report.js';

/** The platform job type one message per container is queued as. */
export const ARCHIVE_JOB_TYPE = 'content-archive-container';
/** Where a run's working notes live in `cosmos-export-state`. */
export const ARCHIVE_RUN_PREFIX = 'state/archive-run/';
/** The access tier a checked data file is moved to. */
export const ARCHIVE_TIER = 'Archive';
/** A run with no manifest this long after it started is said to be late (ADR 0046 section 4). */
export const ARCHIVE_LATE_HOURS = 6;
/** The manifest's layout. Raise it when a reader of an old manifest would misread a new one. */
export const MANIFEST_FORMAT = 1;
/** Stamped on the job documents the daily check creates. */
export const ARCHIVE_ACTOR = Object.freeze({ oid: null, email: 'content-archive@system' });
/**
 * The sources notifications about the archive are sent under (lib/notify.js).
 * One each, because the notifier sends at most one message per source in 15
 * minutes: with a shared source, "not finished" at 03:00 could swallow
 * "written" a few minutes later.
 */
export const ARCHIVE_NOTIFY_SOURCES = Object.freeze({
  written: 'content_archive_written',
  late: 'content_archive_late',
  waiting: 'content_archive_waiting',
  blocked: 'content_archive_blocked',
});
/** How long the daily check may take before the export timer stops waiting for it. */
export const ARCHIVE_CHECK_DEADLINE_MS = 2 * 60 * 1000;
/** After this many automatic dry runs in a row that did not finish, the daily check stops starting them. */
export const AUTO_DRY_RUN_MAX_FAILURES = 3;

const RUN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 60 * 60 * 1000;

const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

const bump = (map, key) => {
  map[key] = (map[key] || 0) + 1;
};

/** A calendar year an archive can be of. */
export const isArchiveYear = (year) => Number.isInteger(year) && year >= 2000 && year <= 2999;

/**
 * Every blob one year's archive touches. `run` and `note` are working notes
 * (the export blob store sends `state/` names to `cosmos-export-state`); the
 * other three are in `content-archive`.
 */
export function archiveNames(year, container = '') {
  const notes = `${ARCHIVE_RUN_PREFIX}${year}/`;
  return {
    run: `${notes}run.json`,
    note: `${notes}${container}.done.json`,
    // What the daily check has already done or said for this year, so it does it once.
    memo: `${notes}check-memo.json`,
    dataPrefix: `${year}/cosmos/`,
    data: `${year}/cosmos/${container}.ndjson.gz`,
    manifest: archiveManifestName(year),
  };
}

/** Validate a queue payload into `{ year, runId, container }`; throws (400) on anything else. */
export function parseArchivePayload(payload = {}) {
  const year = Number(payload?.year);
  const runId = String(payload?.runId || '');
  const container = String(payload?.container || '');
  if (!isArchiveYear(year)) throw withStatus(new Error('year must be a calendar year'), 400);
  if (!RUN_DATE.test(runId)) throw withStatus(new Error('runId must be a UTC date, YYYY-MM-DD'), 400);
  // The list of what an archive writes. A container the owner has not
  // classified, or one that is left out, can never be asked for.
  if (!archivePlan().includes(container)) {
    throw withStatus(new Error('that container is not written by the content archive'), 400);
  }
  return { year, runId, container };
}

/**
 * Is this the pinned run of that year, in a shape this file wrote, started
 * under the rules as they are TODAY? A run pinned under other rules (the
 * list of what is kept changed while it was unfinished) is not a run to
 * carry on: nothing it wrote is trusted, and it starts again.
 */
function validRun(run, year) {
  return isRunOfYear(run, year) && run.rules === classificationFingerprint();
}

/** Is this a pinned run of that year in a shape this file wrote, whatever rules it was pinned under? */
function isRunOfYear(run, year) {
  return (
    run !== null &&
    typeof run === 'object' &&
    run.year === year &&
    typeof run.backup?.runId === 'string' &&
    RUN_DATE.test(run.backup.runId) &&
    Array.isArray(run.containers) &&
    run.containers.every((name) => typeof name === 'string')
  );
}

/**
 * Does this note say the container's file was written and checked for THIS
 * run, under the SAME rules the run was pinned with? (The run itself is
 * only valid under today's rules: `validRun`.)
 */
function noteMatches(note, run, container) {
  return (
    note !== null &&
    typeof note === 'object' &&
    note.container === container &&
    note.year === run.year &&
    note.sourceRun === run.backup.runId &&
    note.rules === run.rules &&
    typeof note.etag === 'string' &&
    note.etag !== '' &&
    typeof note.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(note.sha256)
  );
}

/**
 * Where the archive's container stands for one year, as two separate facts
 * (see archive-handlers.js `archiveState`, which words the same thing for the
 * card): `containerExists` true or false, and `archived` true (the manifest
 * is there), false (the container is there and the manifest is not) or null
 * (not known). A failure to ask is a throw.
 */
async function yearState(archiveBlobs, year) {
  if ((await archiveBlobs.containerExists()) !== true) return { containerExists: false, archived: null };
  return { containerExists: true, archived: (await archiveBlobs.readJson(archiveManifestName(year))) !== null };
}

// ── The per-container worker ────────────────────────────────────────────────

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
  /** Each line of one backup file as a record, or `undefined` for a line that is not JSON. */
  async function* backupRecords(runId, container, signal) {
    const source = await backupBlobs.readGzipStream(blobNames({ mode: 'full', runId, container }).data);
    if (!source) throw new Error('the backup file for this container is not there');
    for await (const line of gzipLines(source)) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      if (!line.trim()) continue;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        doc = undefined;
      }
      yield doc;
    }
  }

  /** The ids of `content` the versions rule needs, read from the same backup. */
  async function contentIndexFor(runId, signal) {
    const index = createContentIndex();
    for await (const doc of backupRecords(runId, 'content', signal)) index.add(doc);
    return index;
  }

  /** Read a written file back: its sha256, its size, and how many records it holds. */
  async function readBack(name) {
    const source = await archiveBlobs.readGzipStream(name);
    if (!source) return null;
    const hash = createHash('sha256');
    let bytes = 0;
    let records = 0;
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    const piping = pipeline(source, tap);
    // The loop below sees the same failure through `tap`; this only stops it being reported twice.
    piping.catch(() => {});
    for await (const line of gzipLines(tap)) if (line.trim()) records += 1;
    await piping;
    return { sha256: hash.digest('hex'), bytes, records };
  }

  /** A job that did not write, and why. Fixed words only. */
  const skipped = (container, reason) => {
    log.log?.(`[contentArchive] ${container}: nothing written (${reason})`);
    return { container, written: false, skipped: reason };
  };

  /**
   * Write one container's file of one year's archive, check it, and note it.
   * @param {{ year: number, runId: string, container: string, signal?: AbortSignal }} job
   */
  async function archiveContainer({ year, runId, container, signal }) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    // The switch is read again here, not only by the daily check: a job that
    // was queued before the owner switched the archive off must not write.
    if (env?.[ARCHIVE_SETTING] !== 'true') return skipped(container, 'switch-off');
    // The classification decides, here as in the dry run. A container that is
    // not classified, or is left out, has no file in an archive.
    const decision = archiveDecisionFor(container);
    if (!decision || decision.decision === DECISIONS.leaveOut) {
      throw withStatus(new Error('that container is not written by the content archive'), 400);
    }
    const names = archiveNames(year, container);
    const state = await yearState(archiveBlobs, year);
    if (!state.containerExists) return skipped(container, 'archive-container-missing');
    // A finished year is never written to again.
    if (state.archived) return skipped(container, 'already-archived');
    const run = await backupBlobs.readJson(names.run);
    if (!validRun(run, year) || run.backup.runId !== runId || !run.containers.includes(container)) {
      return skipped(container, 'not-this-run');
    }

    // What is in storage under this file's name right now, if anything. Its
    // version stamp (ETag) changes on every write, so it says exactly which
    // write a note vouches for, and which one this job may replace.
    const there = (await archiveBlobs.listDetails(names.data)).find((file) => file.name === names.data) || null;
    const earlier = await backupBlobs.readJson(names.note);
    if (noteMatches(earlier, run, container) && there && there.etag === earlier.etag) {
      const completion = await completeIfLast({ year });
      return { ...skipped(container, 'already-written'), manifestWritten: completion.written };
    }

    const startedAt = now();
    const expected = (run.backup.containers || []).find((row) => row?.container === container);
    const stats = { read: 0, kept: 0, changed: 0, leftOut: 0, leftOutBy: {}, removed: {}, unreadable: 0, rawBytes: 0, bytes: 0 };
    const contentIndex = container === 'content_versions' ? await contentIndexFor(runId, signal) : null;

    async function* keptLines() {
      for await (const doc of backupRecords(runId, container, signal)) {
        stats.read += 1;
        if (doc === undefined) {
          stats.unreadable += 1;
          continue;
        }
        const result = archiveRecord(container, doc, { contentIndex });
        if (!result.keep) {
          stats.leftOut += 1;
          bump(stats.leftOutBy, result.reason || REASONS.unlisted);
          continue;
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
        yield line;
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
      pipeline(Readable.from(keptLines()), createGzip(), tap),
      archiveBlobs
        .uploadGzipStream(names.data, tap, {
          metadata: { year: String(year), sourcerun: runId },
          conditions: there?.etag ? { ifMatch: there.etag } : { ifNoneMatch: '*' },
        })
        .catch((error) => {
          tap.destroy(error);
          throw error;
        }),
    ]);
    if (committed === false) return skipped(container, 'another-job-wrote-it');
    const sha256 = hash.digest('hex');

    // The third check, which needs the stored file: read it back. A file
    // that fails here stays under its name, uncounted (it gets no note), and
    // the next job for this container replaces it.
    const stored = await readBack(names.data);
    if (!stored || stored.sha256 !== sha256 || stored.bytes !== stats.bytes || stored.records !== stats.kept) {
      throw new Error('the archive file read back from storage is not the file that was written');
    }
    const written = (await archiveBlobs.listDetails(names.data)).find((file) => file.name === names.data) || null;
    if (!written?.etag || written.size !== stats.bytes) {
      throw new Error('the archive file changed in storage while it was being checked');
    }

    // Asked again, now that minutes have passed: nothing is noted once the
    // owner has switched the archive off, or the year has its manifest.
    if (env?.[ARCHIVE_SETTING] !== 'true') return skipped(container, 'switch-off');
    if ((await archiveBlobs.readJson(names.manifest)) !== null) return skipped(container, 'already-archived');

    const durationMs = now().getTime() - startedAt.getTime();
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
    log.log?.(
      `[contentArchive] ${container}: ${stats.read} read, ${stats.kept} written, ${stats.changed} with fields removed, ${stats.leftOut} left out, ${stats.bytes} bytes gzip, ${durationMs} ms`
    );
    const completion = await completeIfLast({ year });
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
   * Write the year's `manifest.json` if every container's file is written
   * and checked and nobody has written it yet, then move the files to the
   * Archive tier. Create-only, so two jobs finishing together cannot both
   * write it. Nothing is moved to the Archive tier before the manifest
   * exists.
   */
  async function completeIfLast({ year }) {
    const names = archiveNames(year);
    // The switch is asked again here: a manifest is never written once the owner has switched the archive off.
    if (env?.[ARCHIVE_SETTING] !== 'true') return { written: false, reason: 'switch-off' };
    const run = await backupBlobs.readJson(names.run);
    // `validRun` also refuses a run pinned under other rules than today's.
    if (!validRun(run, year) || !run.containers.length) return { written: false, reason: 'no-run' };
    if ((await archiveBlobs.readJson(names.manifest)) !== null) return { written: false, reason: 'exists' };
    // The keep list is asked again, by name: a manifest never names a
    // container the list does not archive today, whatever the run says.
    const plan = archivePlan();
    if (!run.containers.every((container) => plan.includes(container))) return { written: false, reason: 'not-in-plan' };

    const notes = [];
    for (const container of run.containers) {
      const note = await backupBlobs.readJson(archiveNames(year, container).note);
      if (!noteMatches(note, run, container)) return { written: false, reason: 'incomplete' };
      notes.push(note);
    }
    // Each file must still be there, in the very version that was checked.
    const listed = await archiveBlobs.listDetails(names.dataPrefix);
    const stamps = new Map(listed.map((file) => [file.name, file.etag]));
    const wanted = new Set(notes.map((note) => archiveNames(year, note.container).data));
    for (const note of notes) {
      const name = archiveNames(year, note.container).data;
      if (stamps.get(name) !== note.etag) return { written: false, reason: 'file-missing' };
    }
    // And nothing else may be in the year's folder. A file the manifest
    // would not name is one written under earlier rules (a container that
    // has since left the list): it must not sit in a finished archive
    // unlisted. Nothing here deletes it; the owner clears it by hand.
    const unlisted = listed.filter((file) => !wanted.has(file.name)).length;
    if (unlisted > 0) return { written: false, reason: 'unlisted-file', unlisted };

    const files = notes.map((note) => ({
      name: archiveNames(year, note.container).data,
      container: note.container,
      // 'archive': every field kept. 'archive-changed': only listed fields or records.
      decision: note.decision,
      records: count(note.records),
      bytes: count(note.bytes),
      sha256: note.sha256,
      recordsInBackup: count(note.read),
      recordsLeftOut: count(note.leftOut),
      leftOutBy: note.leftOutBy || {},
      recordsWithFieldsRemoved: count(note.changed),
      // Names the classification itself writes, never a name read from a record.
      fieldsRemoved: Object.keys(note.removed || {}).sort(),
    }));
    const manifest = {
      format: MANIFEST_FORMAT,
      year,
      createdAt: now().toISOString(),
      startedAt: run.startedAt || null,
      sourceBackup: { mode: 'full', runId: run.backup.runId },
      fileFormat: 'gzip-compressed NDJSON: one record per line as JSON',
      sha256Of: 'the bytes of each file as stored (compressed)',
      totals: {
        files: files.length,
        records: files.reduce((n, file) => n + file.records, 0),
        bytes: files.reduce((n, file) => n + file.bytes, 0),
        recordsLeftOut: files.reduce((n, file) => n + file.recordsLeftOut, 0),
      },
      files,
      // Containers the list says to archive that the backup did not hold.
      notInBackup: Array.isArray(run.notInBackup) ? run.notInBackup : [],
    };
    const won = await archiveBlobs.putJson(names.manifest, manifest, { overwrite: false });
    if (!won) return { written: false, reason: 'lost-race' };
    log.log?.(
      `[contentArchive] archive of ${year} written: ${files.length} files, ${manifest.totals.records} records, ${manifest.totals.bytes} bytes gzip`
    );
    const tiering = await moveToArchiveTier({ year });
    await notifier
      ?.notifyTelegram({
        title: `Content archive of ${year} written`,
        message: `The yearly archive of ${year} is written: ${files.length} files, ${manifest.totals.records} records, ${manifest.totals.bytes} bytes. ${tiering.moved + tiering.alreadyArchived} of ${tiering.files} files are in the Archive tier. The next step is the read-back check in the content archive runbook.`,
        severity: 'info',
        source: ARCHIVE_NOTIFY_SOURCES.written,
      })
      ?.catch?.(() => {});
    return { written: true, tiering };
  }

  /**
   * Move every data file the year's manifest names to the Archive tier.
   * Does nothing without a manifest: a file is never taken offline before it
   * has been checked and listed. Safe to call again: a file already there is
   * left alone, and one that failed is tried again by the next daily check.
   */
  async function moveToArchiveTier({ year }) {
    const names = archiveNames(year);
    const manifest = await archiveBlobs.readJson(names.manifest);
    const listed = Array.isArray(manifest?.files) ? manifest.files : null;
    const result = { files: listed ? listed.length : 0, moved: 0, alreadyArchived: 0, failed: 0, missing: 0 };
    if (!listed) return { ...result, reason: 'no-manifest' };
    const tiers = new Map((await archiveBlobs.listDetails(names.dataPrefix)).map((file) => [file.name, file.tier]));
    for (const file of listed) {
      const name = typeof file?.name === 'string' ? file.name : '';
      if (!name.startsWith(names.dataPrefix) || !tiers.has(name)) {
        result.missing += 1;
      } else if (tiers.get(name) === ARCHIVE_TIER) {
        result.alreadyArchived += 1;
      } else {
        try {
          await archiveBlobs.setTier(name, ARCHIVE_TIER);
          result.moved += 1;
        } catch {
          result.failed += 1;
        }
      }
    }
    if (result.moved || result.failed || result.missing) {
      const say = result.failed || result.missing ? log.warn : log.log;
      say?.(
        `[contentArchive] archive tier for ${year}: ${result.moved} moved, ${result.alreadyArchived} already there, ${result.failed} failed, ${result.missing} missing`
      );
    }
    return result;
  }

  return { archiveContainer, completeIfLast, moveToArchiveTier };
}

// ── The daily check ─────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function }} deps.store - the `jobs` container writer
 * @param {object} deps.backupBlobs - the export blob store
 * @param {object} deps.archiveBlobs - a blob store on `content-archive`
 * @param {(message: { jobId: string, type: string }) => void} deps.enqueue
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 */
export function createArchiveScheduler({
  store,
  backupBlobs,
  archiveBlobs,
  enqueue,
  env = process.env,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
  notifier = null,
}) {
  const worker = createArchiveWorker({ backupBlobs, archiveBlobs, env, now, log, notifier });

  /** Queue one job per container; returns how many. */
  async function queue(year, runId, containers) {
    for (const container of containers) {
      const jobId = uuid();
      await store.upsertDoc(
        JOBS_CONTAINER,
        newJobDoc({
          id: jobId,
          type: ARCHIVE_JOB_TYPE,
          payload: { year, runId, container },
          requestedBy: ARCHIVE_ACTOR,
          createdAt: now().toISOString(),
        })
      );
      enqueue({ jobId, type: ARCHIVE_JOB_TYPE });
    }
    return containers.length;
  }

  /**
   * Carry on a run that has started: queue the containers whose file is not
   * written yet, or write the manifest if they all are.
   */
  async function resume(run, at) {
    const { year } = run;
    // A container is missing when it has no note for this run, or when the
    // file in storage is not the version its note vouches for.
    const stamps = new Map((await archiveBlobs.listDetails(archiveNames(year).dataPrefix)).map((file) => [file.name, file.etag]));
    const missing = [];
    for (const container of run.containers) {
      const names = archiveNames(year, container);
      const note = await backupBlobs.readJson(names.note);
      if (!noteMatches(note, run, container) || stamps.get(names.data) !== note.etag) missing.push(container);
    }
    const startedMs = Date.parse(run.startedAt || '');
    const late = Number.isFinite(startedMs) && at.getTime() - startedMs >= ARCHIVE_LATE_HOURS * HOUR_MS;
    if (!missing.length) {
      const completion = await worker.completeIfLast({ year });
      if (completion.reason === 'unlisted-file') {
        log.warn?.(`[contentArchive] the archive of ${year} is not finished: ${completion.unlisted} file(s) in its folder are not on its list`);
        await sayOnce(year, `unlisted-file:${run.backup.runId}:${run.rules}`, {
          title: `Content archive of ${year} needs you: a file that should not be there`,
          message: `Every file of the yearly archive of ${year} is written and checked, but its folder also holds ${completion.unlisted} file(s) the archive's list does not name: a container that was archived when the run started and has since been taken off the list. The archive is not finished and nothing is in the Archive tier. Nothing deletes a file by itself; the content archive runbook, "A file that should not be there", has the steps.`,
          severity: 'warning',
          source: ARCHIVE_NOTIFY_SOURCES.blocked,
        });
      }
      return { action: completion.written ? 'completed' : 'waiting', year, queued: 0, reason: completion.reason || null };
    }
    const queued = await queue(year, run.backup.runId, missing);
    if (late) {
      log.warn?.(
        `[contentArchive] the archive of ${year} is late: ${run.containers.length - missing.length} of ${run.containers.length} files written; ${queued} queued again`
      );
      await notifier
        ?.notifyTelegram({
          title: `Content archive of ${year} is not finished`,
          message: `The yearly archive of ${year} started more than ${ARCHIVE_LATE_HOURS} hours ago and is not finished: ${run.containers.length - missing.length} of ${run.containers.length} files are written. Nothing has been moved to the Archive tier. The ${queued} missing container(s) were queued again. The Archive card on Health, Overview names them.`,
          severity: 'warning',
          source: ARCHIVE_NOTIFY_SOURCES.late,
        })
        ?.catch?.(() => {});
    }
    return { action: 'resumed', year, queued, late };
  }

  /** A report that is absent, unfinished, or made from another backup or under other rules: a new dry run puts that right. */
  const NEEDS_A_DRY_RUN = ['report-missing', 'report-stalled', 'report-older-than-backup', 'report-older-rules', 'report-incomplete'];
  /** A finished report of the right backup that shows something to decide: only the owner puts that right. */
  const NEEDS_THE_OWNER = ['report-mismatch', 'report-cut-short', 'report-flagged', 'report-waiting'];

  /** What the daily check has already done or said for this year. */
  const readMemo = async (year) => {
    const memo = await backupBlobs.readJson(archiveNames(year).memo);
    return memo !== null && typeof memo === 'object' ? memo : {};
  };

  /**
   * Tell the owner something once. The daily check runs every day, and a
   * thing that waits for the owner would otherwise be said every morning.
   * `key` names the exact situation, so a new situation is said again.
   */
  async function sayOnce(year, key, message) {
    const memo = await readMemo(year);
    if (memo.said?.[key]) return false;
    await notifier?.notifyTelegram(message)?.catch?.(() => {});
    await backupBlobs.putJson(archiveNames(year).memo, { ...memo, said: { ...(memo.said || {}), [key]: now().toISOString() } });
    return true;
  }

  /**
   * When the only thing between today and an archive is that no usable
   * dry-run report describes the backup, make one. The owner's answer to
   * "how does a yearly run start" was "by itself" (ADR 0046, question 4), so
   * the yearly check does not wait for someone to press Dry run. The archive
   * then starts at the next daily check, if that report shows nothing to
   * decide. A dry run writes no archive and changes no record.
   *
   * CAPPED, so a dry run that keeps failing is not started every morning for
   * ever: at most ONE automatic start per backup and set of rules. If that
   * one leaves no finished report, the owner is told once and nothing more
   * is started for that backup. After AUTO_DRY_RUN_MAX_FAILURES automatic
   * dry runs in a row that did not finish (one per weekly backup), no more
   * are started at all until a dry run has finished; the owner is told once.
   */
  async function dryRunIfThatIsAllThatIsMissing(year, blockers, backup, latest) {
    const none = (reason) => ({ started: false, queued: 0, reason });
    if (!backup || !blockers.length || !blockers.every((code) => NEEDS_A_DRY_RUN.includes(code))) return none('not-the-only-thing');
    const key = `${backup.runId}:${classificationFingerprint()}`;
    const memo = await readMemo(year);
    const auto = memo.autoDryRun || {};
    const pressAgain = 'Open the Archive card on Health, Overview and press Dry run; the content archive runbook says what to check if it fails again.';
    if (auto.key === key) {
      await sayOnce(year, `dry-run-did-not-finish:${key}`, {
        title: `Content archive of ${year}: the dry run did not finish`,
        message: `The yearly archive of ${year} is ready to start, but the dry run that has to come first did not finish, and it is not started again by itself for this backup. Nothing has been written. ${pressAgain}`,
        severity: 'warning',
        source: ARCHIVE_NOTIFY_SOURCES.blocked,
      });
      return none('already-tried');
    }
    // The automatic dry run before this one left no finished report.
    const failures = auto.key && !latest?.complete ? count(auto.failures) + 1 : 0;
    if (failures >= AUTO_DRY_RUN_MAX_FAILURES) {
      await sayOnce(year, 'dry-run-gave-up', {
        title: `Content archive of ${year}: no more automatic dry runs`,
        message: `${AUTO_DRY_RUN_MAX_FAILURES} automatic dry runs in a row did not finish, so no more are started by themselves and the yearly archive of ${year} cannot start. Nothing has been written. ${pressAgain}`,
        severity: 'warning',
        source: ARCHIVE_NOTIFY_SOURCES.blocked,
      });
      return none('gave-up');
    }
    const result = await createReportScheduler({
      store,
      blobs: backupBlobs,
      enqueue: (messages) => messages.forEach((message) => enqueue(message)),
      now,
      uuid,
    }).start({ requestedBy: ARCHIVE_ACTOR });
    if (!result.started) return none(result.reason || 'not-started');
    await backupBlobs.putJson(archiveNames(year).memo, { ...(await readMemo(year)), autoDryRun: { key, failures, startedAt: now().toISOString() } });
    log.log?.(`[contentArchive] a dry run was started for the archive of ${year}: ${result.queued} container job(s) queued`);
    return { started: true, queued: result.queued };
  }

  /** Tell the owner, once, when everything else is ready and only the report's findings stop the archive. */
  async function sayIfTheReportStopsIt(year, blockers, backup) {
    if (!backup || !blockers.length || !blockers.every((code) => NEEDS_THE_OWNER.includes(code))) return;
    log.warn?.(`[contentArchive] the archive of ${year} is not started: the dry-run report shows something to decide (${blockers.join(', ')})`);
    await sayOnce(year, `waiting:${backup.runId}:${classificationFingerprint()}:${blockers.join(',')}`, {
      title: `Content archive of ${year} is waiting for you`,
      message: `The yearly archive of ${year} is ready to start, and the newest dry-run report shows something to decide first (${blockers.join(', ')}). Nothing has been written. Open the Archive card on Health, Overview and read the report; the content archive runbook says how to answer.`,
      severity: 'warning',
      source: ARCHIVE_NOTIFY_SOURCES.waiting,
    });
  }

  /**
   * The daily check. Does nothing, and says so, unless the switch is on.
   * @returns {Promise<{ action: string, year: number, queued?: number, blockers?: string[] }>}
   */
  async function run() {
    const at = now();
    const year = archiveYearFor(at);
    if (env?.[ARCHIVE_SETTING] !== 'true') {
      log.log?.(`[contentArchive] switched off (${ARCHIVE_SETTING}): nothing is read and nothing is written`);
      return { action: 'off', year, blockers: ['switch-off'] };
    }
    const names = archiveNames(year);
    let state;
    try {
      state = await yearState(archiveBlobs, year);
    } catch {
      return { action: 'blocked', year, blockers: ['archive-not-readable'] };
    }
    if (!state.containerExists) return { action: 'blocked', year, blockers: ['archive-container-missing'] };
    if (state.archived) {
      // The year is archived. Finish moving its files to the Archive tier if a move failed.
      const tiering = await worker.moveToArchiveTier({ year });
      return { action: 'archived', year, moved: tiering.moved, failed: tiering.failed, blockers: ['already-archived'] };
    }

    const pinned = await backupBlobs.readJson(names.run);
    // A run was pinned for this year before, under today's rules or not.
    const existing = isRunOfYear(pinned, year);
    if (validRun(pinned, year)) {
      const stillThere = await backupBlobs.readJson(blobNames({ mode: 'full', runId: pinned.backup.runId, container: '' }).manifest);
      if (stillThere) return resume(pinned, at);
      log.warn?.(`[contentArchive] the backup the archive of ${year} was started from is gone; starting again from the newest one`);
    } else if (existing) {
      // The list of what is kept changed while the run was unfinished.
      // Nothing it wrote is trusted: it starts again, through the same gate
      // as a first start, and every file is written again.
      log.warn?.(`[contentArchive] the rules changed while the archive of ${year} was unfinished; it starts again under today's rules`);
    }

    const backup = await findLatestFullBackup({ blobs: backupBlobs, now: at });
    // The newest dry-run report has to describe this very backup, under
    // today's rules, and show nothing still to decide, or no archive starts
    // (reportGate).
    const latest = await readLatestReport({ blobs: backupBlobs, now: at });
    const reportBlockers = reportGate({
      latest,
      backupRunId: backup?.runId ?? null,
      backupContainers: backup ? backup.containers.map((row) => row.container) : null,
    });
    const decision = archiveStartDecision({
      env,
      now: at,
      containerExists: true,
      manifestExists: false,
      backupRunId: backup?.runId ?? null,
      reportBlockers,
    });
    if (!decision.start) {
      const dryRun = await dryRunIfThatIsAllThatIsMissing(year, decision.blockers, backup, latest);
      await sayIfTheReportStopsIt(year, decision.blockers, backup);
      return { action: 'blocked', year, blockers: decision.blockers, queued: dryRun.queued, dryRunStarted: dryRun.started };
    }

    const inBackup = new Map(backup.containers.map((row) => [row.container, row.docs]));
    const plan = archivePlan();
    const containers = plan.filter((name) => inBackup.has(name));
    if (!containers.length) return { action: 'blocked', year, blockers: ['no-backup'] };
    const claimed = await backupBlobs.putJson(
      names.run,
      {
        year,
        startedAt: at.toISOString(),
        // The rules every file of this run is written under (archive-classification.js).
        rules: classificationFingerprint(),
        backup: { runId: backup.runId, containers: containers.map((container) => ({ container, docs: inBackup.get(container) })) },
        containers,
        notInBackup: plan.filter((name) => !inBackup.has(name)),
      },
      // Create-only, so two checks at once start one run. Replacing is
      // allowed only for a run that can never finish: its backup is gone, or
      // it was pinned under rules that have since changed.
      { overwrite: existing }
    );
    if (!claimed) return { action: 'already-started', year, queued: 0 };
    const queued = await queue(year, backup.runId, containers);
    log.log?.(`[contentArchive] archive of ${year} started from the newest weekly backup: ${queued} container job(s) queued`);
    return { action: 'started', year, queued, sourceRun: backup.runId };
  }

  return { run };
}

// ── What the admin card shows ───────────────────────────────────────────────

/**
 * The newest finished archive and the run in progress, for the Archive card.
 * Numbers, dates and container names only.
 *
 * @param {object} deps
 * @param {object} deps.backupBlobs
 * @param {object} deps.archiveBlobs
 * @param {number} deps.year - the year an archive taken today would be of
 * @param {boolean|null} deps.archived - whether that year's manifest exists
 * @param {Date} [deps.now]
 * @returns {Promise<{ lastArchive: object|null, run: object|null }>}
 */
export async function readArchiveProgress({ backupBlobs, archiveBlobs, year, archived, now = new Date() }) {
  const files = await archiveBlobs.listDetails('');
  const years = files
    .map((file) => /^(\d{4})\/manifest\.json$/.exec(file.name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  let lastArchive = null;
  if (years.length) {
    const newest = years[0];
    const manifest = (await archiveBlobs.readJson(archiveManifestName(newest))) || {};
    const listed = Array.isArray(manifest.files) ? manifest.files : [];
    const tiers = new Map(files.map((file) => [file.name, file.tier]));
    lastArchive = {
      year: newest,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      sourceRun: typeof manifest.sourceBackup?.runId === 'string' ? manifest.sourceBackup.runId : null,
      containers: listed.length,
      records: count(manifest.totals?.records),
      bytes: count(manifest.totals?.bytes),
      // How many of its files are offline in the Archive tier, and how many are missing.
      inArchiveTier: listed.filter((file) => tiers.get(file?.name) === ARCHIVE_TIER).length,
      missingFiles: listed.filter((file) => !tiers.has(file?.name)).length,
    };
  }

  let run = null;
  if (archived === false) {
    const pinned = await backupBlobs.readJson(archiveNames(year).run);
    if (validRun(pinned, year)) {
      const missing = [];
      const mine = new Set();
      for (const container of pinned.containers) {
        const names = archiveNames(year, container);
        mine.add(names.data);
        const note = await backupBlobs.readJson(names.note);
        if (!noteMatches(note, pinned, container)) missing.push(container);
      }
      const prefix = archiveNames(year).dataPrefix;
      const startedMs = Date.parse(pinned.startedAt || '');
      run = {
        year,
        // Files in the year's folder that this run's list does not name. While there is one, the archive cannot finish.
        unlistedFiles: files.filter((file) => file.name.startsWith(prefix) && !mine.has(file.name)).length,
        startedAt: typeof pinned.startedAt === 'string' ? pinned.startedAt : null,
        sourceRun: pinned.backup.runId,
        expected: pinned.containers.length,
        done: pinned.containers.length - missing.length,
        // Container names only; they are this repository's own names.
        missing,
        late: Number.isFinite(startedMs) && new Date(now).getTime() - startedMs >= ARCHIVE_LATE_HOURS * HOUR_MS,
      };
    }
  }
  return { lastArchive, run };
}

export { ARCHIVE_CONTAINER };
