/**
 * archive-report-reading.js — what the archive dry run reads before and
 * after it runs: the newest complete weekly backup, which containers a run
 * reads, a queue message, and the newest report (ADR 0046, issue #1811).
 * Re-exported by archive-report.js, which describes the dry run.
 */
import { withStatus } from '../http/error-response.js';
import { blobNames } from './cosmos-export.js';
import { UNCLASSIFIED, archiveDecisionFor, archivePlan } from './archive-classification.js';
import {
  BACKUP_LOOKBACK_DAYS,
  DAY_MS,
  REPORT_ID,
  RUN_ID,
  RUN_STALE_MINUTES,
  count,
  reportIdTime,
  reportNames,
} from './archive-report-base.js';

// ── Finding the backup ───────────────────────────────────────────────────────

/**
 * The newest complete weekly full backup, or null. A full run is complete
 * when its `manifest.json` exists: the exporter writes it only after every
 * container's file is written (cosmos-export.js completeRunIfLast).
 *
 * @param {object} deps
 * @param {{ readJson: Function }} deps.blobs - the export blob store
 * @param {Date} deps.now
 * @param {number} [deps.lookbackDays]
 * @returns {Promise<{ runId: string, containers: { container: string, docs: number, bytes: number }[] }|null>}
 */
export async function findLatestFullBackup({ blobs, now, lookbackDays = BACKUP_LOOKBACK_DAYS }) {
  const start = new Date(now).getTime();
  for (let back = 0; back <= lookbackDays; back += 1) {
    const day = new Date(start - back * DAY_MS);
    if (day.getUTCDay() !== 0) continue; // the weekly full is Sunday's (cosmos-export.js modeFor)
    const runId = day.toISOString().slice(0, 10);
    const manifest = await blobs.readJson(blobNames({ mode: 'full', runId, container: '' }).manifest);
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.containers)) continue;
    const containers = manifest.containers
      .filter((row) => typeof row?.container === 'string' && row.container)
      .map((row) => ({ container: row.container, docs: count(row.docs), bytes: count(row.bytes) }));
    return { runId, containers };
  }
  return null;
}

// ── Which containers a dry run reads ────────────────────────────────────────

/**
 * Is this a container the classification does not name at all? Such a
 * container is left out of every archive (`archiveRecord` answers
 * "unclassified"), and the dry run reads it like one on the waiting list,
 * so that a container nobody has decided about is seen and not skipped.
 * Only a name shaped like a database container's name counts, because the
 * name becomes part of the backup file's name.
 */
export function isUnnamedContainer(container) {
  return typeof container === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(container) && archiveDecisionFor(container) === null;
}

/** Validate a queue payload into `{ reportId, runId, container }`; throws (400) on anything else. */
export function parseReportPayload(payload = {}) {
  const reportId = String(payload?.reportId || '');
  const runId = String(payload?.runId || '');
  const container = String(payload?.container || '');
  if (!REPORT_ID.test(reportId)) throw withStatus(new Error('reportId is not a report id'), 400);
  if (!RUN_ID.test(runId)) throw withStatus(new Error('runId must be a UTC date, YYYY-MM-DD'), 400);
  if (!reportContainers().includes(container) && !isUnnamedContainer(container)) {
    throw withStatus(new Error('that container is not read by the archive dry run'), 400);
  }
  return { reportId, runId, container };
}

/**
 * The containers a dry run reads a backup file for: the ones an archive
 * would write, and the ones waiting for the owner. A container that is left
 * out for a known reason is not read at all; its count comes from the
 * backup's own manifest.
 */
export function reportContainers() {
  return [...archivePlan(), ...UNCLASSIFIED].sort();
}

// ── Reading the newest report ────────────────────────────────────────────────

/**
 * The newest report, finished or not. One that is not finished also says
 * which containers are still missing, and `stalled: true` once it is older
 * than RUN_STALE_MINUTES: a job has 28 minutes at most, so by then the run
 * did not finish and will not.
 *
 * @param {{ blobs: { readJson: Function, listNames: Function }, now?: Date }} deps
 * @returns {Promise<null | { reportId: string, complete: boolean, report?: object, startedAt?: string|null, sourceRun?: string|null, done?: number, expected?: number, missing?: string[], stalled?: boolean }>}
 */
export async function readLatestReport({ blobs, now = new Date() }) {
  const latest = await blobs.readJson(reportNames('x').latest);
  const reportId = typeof latest?.reportId === 'string' && REPORT_ID.test(latest.reportId) ? latest.reportId : null;
  if (!reportId) return null;
  const names = reportNames(reportId);
  const report = await blobs.readJson(names.report);
  if (report && typeof report === 'object') return { reportId, complete: true, report };
  return unfinishedReport({ blobs, now }, reportId, names);
}

const textOrNull = (value) => (typeof value === 'string' ? value : null);

/** A report that is not finished: how far it got, and whether it has stalled. */
async function unfinishedReport({ blobs, now }, reportId, names) {
  const run = await blobs.readJson(names.run);
  const wanted = Array.isArray(run?.containers) ? run.containers.filter((c) => typeof c === 'string') : [];
  const present = new Set(await blobs.listNames(names.prefix));
  const missing = wanted.filter((container) => !present.has(reportNames(reportId, container).part));
  const asked = reportIdTime(reportId);
  return {
    reportId,
    complete: false,
    startedAt: textOrNull(run?.startedAt),
    sourceRun: textOrNull(run?.backup?.runId),
    done: wanted.length - missing.length,
    expected: wanted.length,
    // Container names only; they are this repository's own names.
    missing,
    stalled: asked === null || new Date(now).getTime() - asked >= RUN_STALE_MINUTES * 60 * 1000,
  };
}
