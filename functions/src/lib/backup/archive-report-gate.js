/**
 * archive-report-gate.js — when the yearly content archive may start
 * (ADR 0046 section 4, issue #1811): the report gate and the start
 * decision. Re-exported by archive-report.js, which describes the dry run.
 */
import { exportEnabled } from './cosmos-export.js';
import {
  DECISIONS,
  REASONS,
  archiveDecisionFor,
  archivePlan,
  classificationFingerprint,
  ownerAcceptedOn,
} from './archive-classification.js';
import { ARCHIVE_SETTING, RUN_ID, archiveYearFor, count } from './archive-report-base.js';

// ── When an archive may start (ADR 0046 section 4) ──────────────────────────

/**
 * What the newest dry-run report says against starting an archive from one
 * backup. An archive is never started from a state no finished report
 * describes: the report has to exist, be finished, be made from the very
 * backup the archive would read and under today's rules, cover every
 * container the archive would write, and show nothing still to decide.
 *
 *   report-missing             no dry run has been made
 *   report-running             one is reading the backup now
 *   report-stalled             the newest one did not finish
 *   report-older-than-backup   it was made from another backup than the one
 *                              the archive would read
 *   report-older-rules         it was made under other rules than today's
 *                              (the list of what is kept has changed since)
 *   report-incomplete          a container the archive would write is not in
 *                              it, or is in it with another decision than
 *                              today's
 *   report-mismatch            for a container the archive would write it
 *                              did not count the number of records the
 *                              backup's own list says, or it met a line it
 *                              could not read
 *   report-cut-short           a record was too large or too deep to be
 *                              searched whole for names that look like a
 *                              secret, so the report cannot vouch for it
 *   report-flagged             a container an archive keeps has a field that
 *                              would remain, is named like a secret or
 *                              contact details, and no owner decision covers
 *                              the container
 *   report-waiting             a container is waiting for the owner
 *
 * The first five end the reading: such a report says nothing about today.
 * The rest are listed together.
 *
 * Whether the owner's decision covers a container, and whether a container
 * is still waiting, are read from the list as it is now, not from what the
 * report stored.
 *
 * @param {object} facts
 * @param {Awaited<ReturnType<typeof readLatestReport>>} facts.latest
 * @param {string|null} facts.backupRunId - the backup the archive would read
 * @param {string[]|null} [facts.backupContainers] - the containers that
 *   backup holds; without it no report is enough
 * @returns {string[]} blockers; empty when the report allows a start
 */
export function reportGate({ latest, backupRunId, backupContainers = null }) {
  const stale = staleReportBlocker(latest, backupRunId);
  if (stale) return [stale];
  const report = latest.report || {};
  const containers = Array.isArray(report.containers) ? report.containers : [];
  const leftOutWhole = Array.isArray(report.leftOutWhole) ? report.leftOutWhole : [];
  return [...coverageBlockers(report, containers, backupContainers), ...findingBlockers(containers, leftOutWhole)];
}

/** The first five blockers: each ends the reading, since such a report says nothing about today. */
function staleReportBlocker(latest, backupRunId) {
  if (!latest) return 'report-missing';
  if (!latest.complete) return latest.stalled ? 'report-stalled' : 'report-running';
  const report = latest.report || {};
  if (typeof backupRunId !== 'string' || report.sourceBackup?.runId !== backupRunId) return 'report-older-than-backup';
  if (report.rules !== classificationFingerprint()) return 'report-older-rules';
  return null;
}

/**
 * Every container the archive would write must be in the report, read
 * whole, with the decision the list gives it today.
 */
function coverageBlockers(report, containers, backupContainers) {
  const blockers = [];
  const byName = new Map(containers.map((part) => [part?.container, part]));
  const inBackup = new Set(Array.isArray(backupContainers) ? backupContainers : []);
  const wanted = Array.isArray(backupContainers) ? archivePlan().filter((name) => inBackup.has(name)) : null;
  const covered = wanted !== null && wanted.every((name) => byName.get(name)?.decision === archiveDecisionFor(name).decision);
  if (!covered) blockers.push('report-incomplete');
  const planned = (wanted || []).map((name) => byName.get(name)).filter(Boolean);
  if (count(report.totals?.unreadable) > 0 || planned.some(misread)) {
    blockers.push('report-mismatch');
  }
  return blockers;
}

/** A part whose count disagrees with the backup, or that met a line it could not read. */
const misread = (part) => part.matchesBackup !== true || count(part.unreadable) > 0;

/** What the report found that still needs deciding: cut short, flagged, waiting. */
function findingBlockers(containers, leftOutWhole) {
  const blockers = [];
  const kept = containers.filter((part) => part?.decision !== DECISIONS.leaveOut);
  if (kept.some((part) => count(part.sensitive?.cutShort) > 0)) blockers.push('report-cut-short');
  if (kept.some(isFlaggedPart)) blockers.push('report-flagged');
  // Waiting: the report called it unclassified, and the list still has no
  // other answer for it today.
  if ([...containers, ...leftOutWhole].some(isStillWaiting)) blockers.push('report-waiting');
  return blockers;
}

function isFlaggedPart(part) {
  if (ownerAcceptedOn(part.container)) return false;
  // A report from before the lists were split cannot say what would remain: count any kept record that carries a name.
  return Array.isArray(part.sensitive?.remaining) ? count(part.sensitive.flagged) > 0 : count(part.sensitive?.keptRecords) > 0;
}

function isStillWaiting(part) {
  if (part?.reason !== REASONS.unclassified) return false;
  const today = archiveDecisionFor(part.container);
  return !today || today.reason === REASONS.unclassified;
}

/**
 * May the yearly archive start now? All seven must hold:
 *
 *   1. the switch `CONTENT_ARCHIVE_ENABLED` is exactly `true`;
 *   2. today is on or after 1 February (UTC), so January is the month of grace;
 *   3. the `content-archive` container exists;
 *   4. last year's `manifest.json` does not exist (a year is archived once);
 *   5. a complete full backup dated on or after 2 February exists (the day
 *      after the yearly clean-up of talk proposals runs);
 *   6. the nightly export is switched on (`exportEnabled`). The archive is
 *      made from its weekly backup and its daily check rides the export's
 *      timer, so with the export off nothing looks and nothing starts
 *      ("no backup, no archive", ADR 0046 section 4);
 *   7. the newest dry-run report allows it (`reportGate`): it is finished,
 *      was made from that same backup, and shows nothing still to decide.
 *      `reportBlockers` is that function's answer; when it is not handed in
 *      at all, the report counts as missing.
 *
 * `containerExists`, `manifestExists` and `backupRunId` are `null` when they
 * could not be read; not known is never read as "go". A container that is
 * not there is its own blocker and is NOT the same as "no manifest": storage
 * answers "not found" for a file in a missing container exactly as it does
 * for a missing file, so without condition 3 a container that was never
 * created, or was deleted, would read as "this year is not archived yet,
 * safe to start".
 *
 * @param {object} facts
 * @param {Record<string, string|undefined>} facts.env
 * @param {Date} facts.now
 * @param {boolean|null} facts.containerExists
 * @param {boolean|null} facts.manifestExists
 * @param {string|null} facts.backupRunId - the newest complete full backup's date, `YYYY-MM-DD`
 * @param {string[]} [facts.reportBlockers] - what `reportGate` answered for that backup
 * @returns {{ start: boolean, year: number, earliestBackup: string, blockers: string[] }}
 */
export function archiveStartDecision({ env = process.env, now, containerExists, manifestExists, backupRunId, reportBlockers }) {
  const at = new Date(now);
  const year = archiveYearFor(at);
  const opens = Date.UTC(year + 1, 1, 1); // 1 February of the year after
  const earliestBackup = `${year + 1}-02-02`;
  const blockers = [];
  if (env?.[ARCHIVE_SETTING] !== 'true') blockers.push('switch-off');
  if (!exportEnabled(env || {})) blockers.push('export-off');
  if (at.getTime() < opens) blockers.push('before-1-february');
  blockers.push(...[containerBlocker(containerExists, manifestExists), backupBlocker(backupRunId, earliestBackup)].filter(Boolean));
  blockers.push(...(Array.isArray(reportBlockers) ? reportBlockers : ['report-missing']));
  return { start: blockers.length === 0, year, earliestBackup, blockers };
}

/** What the archive's container and last year's manifest say against a start, or null. */
function containerBlocker(containerExists, manifestExists) {
  if (containerExists === false) return 'archive-container-missing';
  if (containerExists !== true) return 'archive-not-readable';
  if (manifestExists === true) return 'already-archived';
  if (manifestExists !== false) return 'archive-not-readable';
  return null;
}

/** What the newest backup's date says against a start, or null. */
function backupBlocker(backupRunId, earliestBackup) {
  if (typeof backupRunId !== 'string' || !RUN_ID.test(backupRunId)) return 'no-backup';
  if (backupRunId < earliestBackup) return 'backup-too-early';
  return null;
}
