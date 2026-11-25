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
 * THE RULES ARE ASKED AGAIN WHILE IT RUNS. The list of what is kept can
 * change (a deploy) while an archive is half written. So the run, each
 * file's note and each dry-run report carry a fingerprint of the rules
 * (archive-classification.js `classificationFingerprint`). A run pinned
 * under other rules than today's is not carried on: it starts again and
 * every file is written again. Before the manifest is written, every
 * container of the run must still be on the list, each file in storage must
 * be the very version that was checked (its ETag), and the year's folder
 * must hold nothing the manifest would not name. Nothing here deletes a
 * file from the archive, so a file left by a container that has since left
 * the list stops the archive until the owner removes it by hand.
 *
 * ONE WRITER PER FILE. A job writes its file only when no file has that
 * name, or only over the exact version it saw when it started; storage
 * refuses any other write. Two jobs for one container cannot both finish.
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
 *
 * WHERE THE CODE IS. This file is the job's front door: it checks a queue
 * message and re-exports the rest, which is split over a few files only to
 * keep each one short (archive-run-notes.js lists them).
 */
import { withStatus } from '../http/error-response.js';
import { archivePlan } from './archive-classification.js';
import { ARCHIVE_CONTAINER } from './archive-report.js';
import { RUN_DATE, isArchiveYear } from './archive-run-notes.js';

export {
  ARCHIVE_ACTOR,
  ARCHIVE_JOB_TYPE,
  ARCHIVE_LATE_HOURS,
  ARCHIVE_NOTIFY_SOURCES,
  ARCHIVE_RUN_PREFIX,
  ARCHIVE_TIER,
  AUTO_DRY_RUN_MAX_FAILURES,
  MANIFEST_FORMAT,
  archiveNames,
  isArchiveYear,
} from './archive-run-notes.js';
export { createArchiveWorker } from './archive-worker.js';
export { createArchiveScheduler } from './archive-scheduler.js';
export { readArchiveProgress } from './archive-progress.js';

/** How long the daily check may take before the export timer stops waiting for it. */
export const ARCHIVE_CHECK_DEADLINE_MS = 2 * 60 * 1000;

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

export { ARCHIVE_CONTAINER };
