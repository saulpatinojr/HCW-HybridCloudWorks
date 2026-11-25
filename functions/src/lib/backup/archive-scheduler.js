/**
 * archive-scheduler.js — the yearly content archive's daily check: start a
 * run, carry one on, or say why not (ADR 0046 section 4, issue #1811). The
 * whole job is described in archive-job.js, which re-exports
 * `createArchiveScheduler`.
 *
 * The helpers below take the scheduler's `deps` first:
 * `{ store, backupBlobs, archiveBlobs, enqueue, env, now, uuid, log, notifier, worker }`.
 */
import { randomUUID } from 'node:crypto';

import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { blobNames } from './cosmos-export.js';
import { archivePlan, classificationFingerprint } from './archive-classification.js';
import {
  ARCHIVE_SETTING,
  archiveStartDecision,
  archiveYearFor,
  findLatestFullBackup,
  readLatestReport,
  reportGate,
} from './archive-report.js';
import {
  ARCHIVE_ACTOR,
  ARCHIVE_JOB_TYPE,
  ARCHIVE_LATE_HOURS,
  ARCHIVE_NOTIFY_SOURCES,
  archiveNames,
  isLate,
  isRunOfYear,
  noteMatches,
  switchOn,
  validRun,
  yearState,
} from './archive-run-notes.js';
import { dryRunIfThatIsAllThatIsMissing, sayIfTheReportStopsIt, sayOnce } from './archive-auto-dry-run.js';
import { createArchiveWorker } from './archive-worker.js';

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
  const deps = { store, backupBlobs, archiveBlobs, enqueue, env, now, uuid, log, notifier, worker };
  return { run: () => run(deps) };
}

/** Queue one job per container; returns how many. */
async function queue({ store, enqueue, now, uuid }, year, runId, containers) {
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
async function resume(deps, run, at) {
  const { year } = run;
  const missing = await missingContainers(deps, run);
  const late = isLate(run.startedAt, at.getTime());
  if (!missing.length) return finishRun(deps, run);
  const queued = await queue(deps, year, run.backup.runId, missing);
  if (late) await sayLate(deps, run, missing, queued);
  return { action: 'resumed', year, queued, late };
}

/**
 * A container is missing when it has no note for this run, or when the
 * file in storage is not the version its note vouches for.
 */
async function missingContainers({ archiveBlobs, backupBlobs }, run) {
  const { year } = run;
  const stamps = new Map((await archiveBlobs.listDetails(archiveNames(year).dataPrefix)).map((file) => [file.name, file.etag]));
  const missing = [];
  for (const container of run.containers) {
    const names = archiveNames(year, container);
    const note = await backupBlobs.readJson(names.note);
    if (!noteMatches(note, run, container) || stamps.get(names.data) !== note.etag) missing.push(container);
  }
  return missing;
}

/** Every file is there: write the manifest, or say what stops it. */
async function finishRun(deps, run) {
  const { year } = run;
  const completion = await deps.worker.completeIfLast({ year });
  if (completion.reason === 'unlisted-file') {
    deps.log.warn?.(`[contentArchive] the archive of ${year} is not finished: ${completion.unlisted} file(s) in its folder are not on its list`);
    await sayOnce(deps, year, `unlisted-file:${run.backup.runId}:${run.rules}`, {
      title: `Content archive of ${year} needs you: a file that should not be there`,
      message: `Every file of the yearly archive of ${year} is written and checked, but its folder also holds ${completion.unlisted} file(s) the archive's list does not name: a container that was archived when the run started and has since been taken off the list. The archive is not finished and nothing is in the Archive tier. Nothing deletes a file by itself; the content archive runbook, "A file that should not be there", has the steps.`,
      severity: 'warning',
      source: ARCHIVE_NOTIFY_SOURCES.blocked,
    });
  }
  return { action: completion.written ? 'completed' : 'waiting', year, queued: 0, reason: completion.reason || null };
}

/** A run past ARCHIVE_LATE_HOURS: log it and tell the owner. */
async function sayLate({ log, notifier }, run, missing, queued) {
  const { year } = run;
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

/**
 * The daily check. Does nothing, and says so, unless the switch is on.
 * @returns {Promise<{ action: string, year: number, queued?: number, blockers?: string[] }>}
 */
async function run(deps) {
  const at = deps.now();
  const year = archiveYearFor(at);
  if (!switchOn(deps.env)) {
    deps.log.log?.(`[contentArchive] switched off (${ARCHIVE_SETTING}): nothing is read and nothing is written`);
    return { action: 'off', year, blockers: ['switch-off'] };
  }
  const stop = await yearStop(deps, year);
  if (stop) return stop;

  const names = archiveNames(year);
  const pinned = await deps.backupBlobs.readJson(names.run);
  // A run was pinned for this year before, under today's rules or not.
  const existing = isRunOfYear(pinned, year);
  const carried = await carryOn(deps, { pinned, year, existing, at });
  if (carried) return carried;

  const gate = await startGate(deps, year, at);
  if (gate.result) return gate.result;
  return startRun(deps, { year, at, names, backup: gate.backup, existing });
}

/** The answer of a day the archive's container stops the check, or null to go on. */
async function yearStop(deps, year) {
  let state;
  try {
    state = await yearState(deps.archiveBlobs, year);
  } catch {
    return { action: 'blocked', year, blockers: ['archive-not-readable'] };
  }
  if (!state.containerExists) return { action: 'blocked', year, blockers: ['archive-container-missing'] };
  if (!state.archived) return null;
  // The year is archived. Finish moving its files to the Archive tier if a move failed.
  const tiering = await deps.worker.moveToArchiveTier({ year });
  return { action: 'archived', year, moved: tiering.moved, failed: tiering.failed, blockers: ['already-archived'] };
}

/** Carry on the pinned run when it can be, or say why it starts again (null). */
async function carryOn(deps, { pinned, year, existing, at }) {
  if (validRun(pinned, year)) {
    const stillThere = await deps.backupBlobs.readJson(blobNames({ mode: 'full', runId: pinned.backup.runId, container: '' }).manifest);
    if (stillThere) return resume(deps, pinned, at);
    deps.log.warn?.(`[contentArchive] the backup the archive of ${year} was started from is gone; starting again from the newest one`);
  } else if (existing) {
    // The list of what is kept changed while the run was unfinished.
    // Nothing it wrote is trusted: it starts again, through the same gate
    // as a first start, and every file is written again.
    deps.log.warn?.(`[contentArchive] the rules changed while the archive of ${year} was unfinished; it starts again under today's rules`);
  }
  return null;
}

/**
 * The newest dry-run report has to describe this very backup, under
 * today's rules, and show nothing still to decide, or no archive starts
 * (reportGate). Returns `{ result }` when nothing starts, else `{ backup }`.
 */
async function startGate(deps, year, at) {
  const { backupBlobs, env } = deps;
  const backup = await findLatestFullBackup({ blobs: backupBlobs, now: at });
  const latest = await readLatestReport({ blobs: backupBlobs, now: at });
  const backupRunId = backup?.runId ?? null;
  const reportBlockers = reportGate({
    latest,
    backupRunId,
    backupContainers: backup ? backup.containers.map((row) => row.container) : null,
  });
  const decision = archiveStartDecision({
    env,
    now: at,
    containerExists: true,
    manifestExists: false,
    backupRunId,
    reportBlockers,
  });
  if (decision.start) return { backup };
  const dryRun = await dryRunIfThatIsAllThatIsMissing(deps, year, decision.blockers, backup, latest);
  await sayIfTheReportStopsIt(deps, year, decision.blockers, backup);
  return { result: { action: 'blocked', year, blockers: decision.blockers, queued: dryRun.queued, dryRunStarted: dryRun.started } };
}

/** Pin the run (create-only) and queue one job per container. */
async function startRun(deps, { year, at, names, backup, existing }) {
  const inBackup = new Map(backup.containers.map((row) => [row.container, row.docs]));
  const plan = archivePlan();
  const containers = plan.filter((name) => inBackup.has(name));
  if (!containers.length) return { action: 'blocked', year, blockers: ['no-backup'] };
  const claimed = await deps.backupBlobs.putJson(
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
  const queued = await queue(deps, year, backup.runId, containers);
  deps.log.log?.(`[contentArchive] archive of ${year} started from the newest weekly backup: ${queued} container job(s) queued`);
  return { action: 'started', year, queued, sourceRun: backup.runId };
}
