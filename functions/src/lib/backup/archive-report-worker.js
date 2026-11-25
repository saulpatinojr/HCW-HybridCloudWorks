/**
 * archive-report-worker.js — one job of the archive dry run: read one
 * container's backup file and write its part of the report, then the whole
 * report once every part is there (ADR 0046, issue #1811). Re-exported by
 * archive-report.js, which describes the dry run.
 *
 * The helpers below take the worker's `deps` first: `{ blobs, now, log }`.
 */
import { blobNames } from './cosmos-export.js';
import {
  DECISIONS,
  REASONS,
  SENSITIVE_KEPT_ON_PURPOSE,
  archiveDecisionFor,
  classificationFingerprint,
  createContentIndex,
  ownerAcceptedOn,
} from './archive-classification.js';
import { count, gzipRecords, reportNames } from './archive-report-base.js';
import { newTallies, noteRecord } from './archive-report-tally.js';
import { fieldNameSummary, sensitiveSummary } from './archive-report-summary.js';

/**
 * @param {object} deps
 * @param {{ readJson: Function, putJson: Function, listNames: Function, readGzipStream: Function }} deps.blobs
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createReportWorker({ blobs, now = () => new Date(), log = {} }) {
  const deps = { blobs, now, log };
  return {
    readContainer: (job) => readContainer(deps, job),
    completeIfLast: (args) => completeIfLast(deps, args),
  };
}

/** Each record of one backup file (`undefined` for a line that is not JSON); nothing when the file is not there. */
async function* records({ blobs }, runId, container, signal) {
  const name = blobNames({ mode: 'full', runId, container }).data;
  const source = await blobs.readGzipStream(name);
  if (!source) return;
  yield* gzipRecords(source, signal);
}

/** The ids of `content` the versions rule needs, from the same backup. */
async function contentIndexFor(deps, runId, signal) {
  const index = createContentIndex();
  for await (const doc of records(deps, runId, 'content', signal)) index.add(doc);
  return index;
}

/** A part with nothing counted yet. */
function newPart(container) {
  const decision = archiveDecisionFor(container);
  return {
    container,
    decision: decision?.decision || DECISIONS.leaveOut,
    // A container this file does not name is waiting for a decision.
    reason: decision ? decision.reason || null : REASONS.unclassified,
    // The date the owner chose to keep this container as the dry run
    // showed it, flagged names included; null when no such decision covers it.
    ownerAccepted: ownerAcceptedOn(container),
    inBackup: true,
    read: 0,
    kept: 0,
    changed: 0,
    leftOut: 0,
    leftOutBy: {},
    removed: {},
    unreadable: 0,
  };
}

/**
 * Read one container's backup file and write its part of the report.
 * @param {{ reportId: string, runId: string, container: string, signal?: AbortSignal }} job
 */
async function readContainer(deps, { reportId, runId, container, signal }) {
  const { blobs, now, log } = deps;
  const startedAt = now();
  const names = reportNames(reportId, container);
  const part = newPart(container);
  const state = newTallies();

  const exists = (await blobs.listNames(blobNames({ mode: 'full', runId, container }).data)).length > 0;
  if (!exists) {
    part.inBackup = false;
  } else {
    const contentIndex = container === 'content_versions' ? await contentIndexFor(deps, runId, signal) : null;
    for await (const doc of records(deps, runId, container, signal)) {
      noteRecord(state, part, { container, doc, contentIndex });
    }
  }
  Object.assign(part, fieldNameSummary(state, part.read));
  part.sensitive = sensitiveSummary(state, SENSITIVE_KEPT_ON_PURPOSE[container] || {});
  part.durationMs = now().getTime() - startedAt.getTime();
  part.completedAt = now().toISOString();
  await blobs.putJson(names.part, part);
  log.log?.(
    `[archiveReport] ${container}: ${part.read} read, ${part.kept} would be kept, ${part.changed} with fields removed, ${part.leftOut} left out, ${part.durationMs} ms`
  );
  const completion = await completeIfLast(deps, { reportId });
  // The job's own result: counts only. The field names stay in the part file.
  return {
    container,
    read: part.read,
    kept: part.kept,
    changed: part.changed,
    leftOut: part.leftOut,
    unreadable: part.unreadable,
    durationMs: part.durationMs,
    reportWritten: completion.written,
  };
}

/** Write `report.json` if every part is present and nobody has written it yet. */
async function completeIfLast({ blobs, now, log }, { reportId }) {
  const names = reportNames(reportId);
  const run = await blobs.readJson(names.run);
  if (!run || !Array.isArray(run.containers)) return { written: false, reason: 'no-run' };
  const present = new Set(await blobs.listNames(names.prefix));
  if (present.has(names.report)) return { written: false, reason: 'exists' };
  const missing = run.containers.filter((c) => !present.has(reportNames(reportId, c).part));
  if (missing.length) return { written: false, reason: 'incomplete', missing: missing.length };

  const containers = await readParts(blobs, reportId, run);
  const report = {
    reportId,
    sourceBackup: { mode: 'full', runId: run.backup?.runId || null },
    // The fingerprint of the rules the run was started under. When a
    // deploy changed the rules half-way, the parts were read under two
    // sets of rules, and the report says so by carrying neither.
    rules: run.rules === classificationFingerprint() ? run.rules : null,
    startedAt: run.startedAt || null,
    completedAt: now().toISOString(),
    totals: reportTotals(containers),
    containers,
    leftOutWhole: run.leftOutWhole || [],
    notInBackup: run.notInBackup || [],
  };
  const won = await blobs.putJson(names.report, report, { overwrite: false });
  if (!won) return { written: false, reason: 'lost-race' };
  log.log?.(
    `[archiveReport] report complete: ${containers.length} containers read, ${report.totals.read} records, ${report.totals.kept} would be kept, ${report.totals.leftOut} left out`
  );
  return { written: true };
}

/** Every part of the run, each with the count the backup's own list gives for it. */
async function readParts(blobs, reportId, run) {
  const backupDocs = new Map((run.backup?.containers || []).map((row) => [row.container, count(row.docs)]));
  const containers = [];
  for (const container of run.containers) {
    const part = (await blobs.readJson(reportNames(reportId, container).part)) || {};
    const expected = backupDocs.has(container) ? backupDocs.get(container) : null;
    containers.push({
      ...part,
      container,
      backupDocs: expected,
      // ADR 0046, "validated when": what the dry run read is what the backup says it wrote.
      matchesBackup: expected === null ? null : expected === count(part.read),
    });
  }
  return containers;
}

/** A kept container that holds a name to look at (see `flagged` in a part). */
const isFlagged = (c) => c.decision !== DECISIONS.leaveOut && count(c.sensitive?.flagged) > 0;

function reportTotals(containers) {
  const sum = (key) => containers.reduce((n, c) => n + count(c[key]), 0);
  return {
    containersRead: containers.length,
    read: sum('read'),
    kept: sum('kept'),
    changed: sum('changed'),
    leftOut: sum('leftOut'),
    unreadable: sum('unreadable'),
    sensitiveRecords: containers.reduce((n, c) => n + count(c.sensitive?.records), 0),
    sensitiveKeptRecords: containers.reduce((n, c) => n + count(c.sensitive?.keptRecords), 0),
    // Containers an archive would keep that hold a name to look at (see `flagged` in a part).
    flaggedContainers: containers.filter(isFlagged).length,
    // Of those, the ones no owner decision covers: these are what is still to look at.
    flaggedNotAccepted: containers.filter((c) => isFlagged(c) && !c.ownerAccepted).length,
    mismatched: containers.filter((c) => c.matchesBackup === false).length,
  };
}
