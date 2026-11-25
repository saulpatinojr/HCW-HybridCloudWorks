/**
 * archive-run-notes.js — the names, constants and checks the yearly content
 * archive's job shares between its parts (ADR 0046 section 4, issue #1811).
 *
 * The job itself is described in archive-job.js, which also re-exports
 * everything here. It is split over a few files only to keep each one short:
 *
 *   archive-run-notes.js   blob names, constants, and the checks on a run and a note
 *   archive-worker.js      one container's file: write, check, note
 *   archive-file-read.js   reading a backup file, and an archive file back
 *   archive-manifest.js    the year's manifest, and the move to the Archive tier
 *   archive-scheduler.js   the daily check that starts or carries on a run
 *   archive-auto-dry-run.js  the daily check's dry run and its messages to the owner
 *   archive-progress.js    what the admin card shows
 */
import { classificationFingerprint } from './archive-classification.js';
import { ARCHIVE_SETTING, archiveManifestName } from './archive-report.js';

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
/** After this many automatic dry runs in a row that did not finish, the daily check stops starting them. */
export const AUTO_DRY_RUN_MAX_FAILURES = 3;

export const RUN_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const HOUR_MS = 60 * 60 * 1000;

export const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

export const bump = (map, key) => {
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

/**
 * Is this the pinned run of that year, in a shape this file wrote, started
 * under the rules as they are TODAY? A run pinned under other rules (the
 * list of what is kept changed while it was unfinished) is not a run to
 * carry on: nothing it wrote is trusted, and it starts again.
 */
export function validRun(run, year) {
  return isRunOfYear(run, year) && run.rules === classificationFingerprint();
}

/** Is this a pinned run of that year in a shape this file wrote, whatever rules it was pinned under? */
export function isRunOfYear(run, year) {
  return isObject(run) && run.year === year && pinsABackup(run) && listsContainers(run);
}

const isObject = (value) => value !== null && typeof value === 'object';
const pinsABackup = (run) => typeof run.backup?.runId === 'string' && RUN_DATE.test(run.backup.runId);
const listsContainers = (run) => Array.isArray(run.containers) && run.containers.every((name) => typeof name === 'string');

/**
 * Does this note say the container's file was written and checked for THIS
 * run, under the SAME rules the run was pinned with? (The run itself is
 * only valid under today's rules: `validRun`.)
 */
export function noteMatches(note, run, container) {
  return isObject(note) && noteIsFor(note, run, container) && noteHasStamps(note);
}

const noteIsFor = (note, run, container) =>
  note.container === container && note.year === run.year && note.sourceRun === run.backup.runId && note.rules === run.rules;
const noteHasStamps = (note) =>
  typeof note.etag === 'string' && note.etag !== '' && typeof note.sha256 === 'string' && /^[0-9a-f]{64}$/.test(note.sha256);

/**
 * Where the archive's container stands for one year, as two separate facts
 * (see archive-handlers.js `archiveState`, which words the same thing for the
 * card): `containerExists` true or false, and `archived` true (the manifest
 * is there), false (the container is there and the manifest is not) or null
 * (not known). A failure to ask is a throw.
 */
export async function yearState(archiveBlobs, year) {
  if ((await archiveBlobs.containerExists()) !== true) return { containerExists: false, archived: null };
  return { containerExists: true, archived: (await archiveBlobs.readJson(archiveManifestName(year))) !== null };
}

/** True when the archive's switch, the app setting CONTENT_ARCHIVE_ENABLED, is on. */
export const switchOn = (env) => env?.[ARCHIVE_SETTING] === 'true';

/** Has a run that started at `startedAt` gone past ARCHIVE_LATE_HOURS by `atMs`? */
export function isLate(startedAt, atMs) {
  const startedMs = Date.parse(startedAt || '');
  return Number.isFinite(startedMs) && atMs - startedMs >= ARCHIVE_LATE_HOURS * HOUR_MS;
}
