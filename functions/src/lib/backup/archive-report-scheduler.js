/**
 * archive-report-scheduler.js — starting an archive dry run, and removing
 * old reports (ADR 0046, issue #1811). Re-exported by archive-report.js,
 * which describes the dry run.
 *
 * The helpers below take the scheduler's `deps` first:
 * `{ store, blobs, enqueue, now, uuid }`.
 */
import { randomUUID } from 'node:crypto';

import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { REASONS, archiveClassifiedContainers, archiveDecisionFor, classificationFingerprint } from './archive-classification.js';
import {
  DAY_MS,
  REPORT_ID,
  REPORT_JOB_TYPE,
  REPORT_KEEP_DAYS,
  REPORT_PREFIX,
  reportIdFor,
  reportIdTime,
  reportNames,
} from './archive-report-base.js';
import { findLatestFullBackup, isUnnamedContainer, readLatestReport, reportContainers } from './archive-report-reading.js';

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function }} deps.store - the `jobs` container writer
 * @param {{ readJson: Function, putJson: Function, listNames: Function, deleteReportFile?: Function }} deps.blobs - the export blob store
 * @param {(messages: {jobId: string, type: string}[]) => void} deps.enqueue
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createReportScheduler({ store, blobs, enqueue, now = () => new Date(), uuid = randomUUID }) {
  const deps = { store, blobs, enqueue, now, uuid };
  return {
    start: (options) => start(deps, options),
    removeOldReports: (options) => removeOldReports(deps, options),
  };
}

/**
 * Claim a report and queue its jobs.
 * @param {{ requestedBy?: object|null }} [options]
 * @returns {Promise<{ started: boolean, reason?: string, reportId?: string, sourceRun?: string, queued?: number, removedReports?: number }>}
 */
async function start(deps, { requestedBy = null } = {}) {
  const { blobs, now } = deps;
  const at = now();
  // One dry run at a time: while the newest one is still reading and is
  // young, a second would read the whole backup again for nothing.
  const newest = await readLatestReport({ blobs, now: at });
  if (newest && !newest.complete && !newest.stalled) {
    return { started: false, reason: 'in-progress', reportId: newest.reportId };
  }
  const backup = await findLatestFullBackup({ blobs, now: at });
  if (!backup) return { started: false, reason: 'no-backup' };

  const plan = dryRunPlan(backup);
  const reportId = reportIdFor(at);
  const names = reportNames(reportId);
  const docsOf = new Map(backup.containers.map((row) => [row.container, row.docs]));
  const claimed = await blobs.putJson(
    names.run,
    {
      reportId,
      startedAt: at.toISOString(),
      // Which rules this run reads the backup under (archive-classification.js).
      rules: classificationFingerprint(),
      backup: { runId: backup.runId, containers: backup.containers.map((row) => ({ container: row.container, docs: docsOf.get(row.container) })) },
      containers: plan.containers,
      leftOutWhole: plan.leftOutWhole,
      notInBackup: plan.notInBackup,
    },
    { overwrite: false }
  );
  if (!claimed) return { started: false, reason: 'already-started', reportId };

  const queued = await queueJobs(deps, { reportId, runId: backup.runId, containers: plan.containers, requestedBy });
  // Only now is the new report the newest one. If anything above failed,
  // `latest.json` still names the report before it: the card keeps showing
  // that one, nothing reads as "running", and the button can be pressed
  // again a minute later. The half-started folder is removed with the old
  // reports, below, once it is old enough.
  await blobs.putJson(names.latest, { reportId, startedAt: at.toISOString() });
  const removedReports = await removeOldReports(deps, { keep: reportId, at }).catch(() => 0);
  return { started: true, reportId, sourceRun: backup.runId, queued, removedReports };
}

/**
 * Which containers a dry run of this backup reads, and what it lists
 * without reading.
 */
function dryRunPlan(backup) {
  const inBackup = new Set(backup.containers.map((row) => row.container));
  // What an archive would write, what is on the waiting list, and any
  // container in the backup that the classification does not name at all.
  const unnamed = backup.containers.map((row) => row.container).filter(isUnnamedContainer);
  const containers = [...reportContainers().filter((name) => inBackup.has(name)), ...unnamed].sort();
  const wanted = new Set([...reportContainers(), ...unnamed]);
  // Left out whole for a known reason: not read, counted from the backup's own manifest.
  const leftOutWhole = backup.containers
    .filter((row) => !wanted.has(row.container))
    .map((row) => ({
      container: row.container,
      reason: archiveDecisionFor(row.container)?.reason || REASONS.unclassified,
      backupDocs: row.docs,
    }));
  // Named by the classification and absent from the backup: nothing to read.
  const notInBackup = archiveClassifiedContainers()
    .filter((name) => !inBackup.has(name))
    .map((name) => {
      const decision = archiveDecisionFor(name);
      return { container: name, decision: decision.decision, reason: decision.reason };
    });
  return { containers, leftOutWhole, notInBackup };
}

/** Write one job row per container, then queue them all; returns how many. */
async function queueJobs({ store, enqueue, now, uuid }, { reportId, runId, containers, requestedBy }) {
  const messages = [];
  for (const container of containers) {
    const jobId = uuid();
    await store.upsertDoc(
      JOBS_CONTAINER,
      newJobDoc({
        id: jobId,
        type: REPORT_JOB_TYPE,
        payload: { reportId, runId, container },
        requestedBy,
        createdAt: now().toISOString(),
      })
    );
    messages.push({ jobId, type: REPORT_JOB_TYPE });
  }
  if (messages.length) enqueue(messages);
  return messages.length;
}

/**
 * Delete every report older than REPORT_KEEP_DAYS. A report's age is read
 * from its own name (the minute it was asked for). Best effort: a failure
 * here never fails the dry run that was just started.
 */
async function removeOldReports({ blobs }, { keep, at }) {
  if (typeof blobs.deleteReportFile !== 'function') return 0;
  const cutoff = at.getTime() - REPORT_KEEP_DAYS * DAY_MS;
  const old = new Set();
  for (const name of await blobs.listNames(REPORT_PREFIX)) {
    const id = name.slice(REPORT_PREFIX.length).split('/')[0];
    if (!isOldReport(id, keep, cutoff)) continue;
    await blobs.deleteReportFile(name);
    old.add(id);
  }
  return old.size;
}

/** Is `id` a report other than `keep`, asked for before `cutoff`? */
function isOldReport(id, keep, cutoff) {
  if (id === keep || !REPORT_ID.test(id)) return false;
  const asked = reportIdTime(id);
  return asked !== null && asked < cutoff;
}
