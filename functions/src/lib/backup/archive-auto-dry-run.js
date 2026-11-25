/**
 * archive-auto-dry-run.js — the part of the yearly content archive's daily
 * check that starts a dry run by itself, and tells the owner once when it
 * cannot (ADR 0046 section 4, issue #1811). The daily check is in
 * archive-scheduler.js; the whole job is described in archive-job.js.
 *
 * Every function takes the scheduler's `deps` first:
 * `{ store, backupBlobs, enqueue, now, uuid, log, notifier }`.
 */
import { classificationFingerprint } from './archive-classification.js';
import { createReportScheduler } from './archive-report.js';
import {
  ARCHIVE_ACTOR,
  ARCHIVE_NOTIFY_SOURCES,
  AUTO_DRY_RUN_MAX_FAILURES,
  archiveNames,
  count,
} from './archive-run-notes.js';

/** A report that is absent, unfinished, or made from another backup or under other rules: a new dry run puts that right. */
const NEEDS_A_DRY_RUN = ['report-missing', 'report-stalled', 'report-older-than-backup', 'report-older-rules', 'report-incomplete'];
/** A finished report of the right backup that shows something to decide: only the owner puts that right. */
const NEEDS_THE_OWNER = ['report-mismatch', 'report-cut-short', 'report-flagged', 'report-waiting'];

/** True when there is a backup and every blocker is one of `kinds`. */
const onlyBlockedBy = (kinds, blockers, backup) =>
  Boolean(backup) && blockers.length > 0 && blockers.every((code) => kinds.includes(code));

/** What the daily check has already done or said for this year. */
export const readMemo = async ({ backupBlobs }, year) => {
  const memo = await backupBlobs.readJson(archiveNames(year).memo);
  return memo !== null && typeof memo === 'object' ? memo : {};
};

/**
 * Tell the owner something once. The daily check runs every day, and a
 * thing that waits for the owner would otherwise be said every morning.
 * `key` names the exact situation, so a new situation is said again.
 */
export async function sayOnce(deps, year, key, message) {
  const memo = await readMemo(deps, year);
  if (memo.said?.[key]) return false;
  await deps.notifier?.notifyTelegram(message)?.catch?.(() => {});
  await deps.backupBlobs.putJson(archiveNames(year).memo, { ...memo, said: { ...(memo.said || {}), [key]: deps.now().toISOString() } });
  return true;
}

const none = (reason) => ({ started: false, queued: 0, reason });
const PRESS_AGAIN = 'Open the Archive card on Health, Overview and press Dry run; the content archive runbook says what to check if it fails again.';

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
export async function dryRunIfThatIsAllThatIsMissing(deps, year, blockers, backup, latest) {
  if (!onlyBlockedBy(NEEDS_A_DRY_RUN, blockers, backup)) return none('not-the-only-thing');
  const key = `${backup.runId}:${classificationFingerprint()}`;
  const memo = await readMemo(deps, year);
  const auto = memo.autoDryRun || {};
  const capped = await capReached(deps, { year, key, auto, latest });
  if (capped.refusal) return none(capped.refusal);
  const { failures } = capped;
  const { store, backupBlobs, enqueue, now, uuid, log } = deps;
  const result = await createReportScheduler({
    store,
    blobs: backupBlobs,
    enqueue: (messages) => messages.forEach((message) => enqueue(message)),
    now,
    uuid,
  }).start({ requestedBy: ARCHIVE_ACTOR });
  if (!result.started) return none(result.reason || 'not-started');
  await backupBlobs.putJson(archiveNames(year).memo, { ...(await readMemo(deps, year)), autoDryRun: { key, failures, startedAt: now().toISOString() } });
  log.log?.(`[contentArchive] a dry run was started for the archive of ${year}: ${result.queued} container job(s) queued`);
  return { started: true, queued: result.queued };
}

/**
 * The cap on automatic dry runs. Returns `{ refusal }` (and tells the owner
 * once) when no dry run may start, otherwise `{ failures }`: how many
 * automatic dry runs in a row have not finished.
 */
async function capReached(deps, { year, key, auto, latest }) {
  if (auto.key === key) {
    await sayOnce(deps, year, `dry-run-did-not-finish:${key}`, {
      title: `Content archive of ${year}: the dry run did not finish`,
      message: `The yearly archive of ${year} is ready to start, but the dry run that has to come first did not finish, and it is not started again by itself for this backup. Nothing has been written. ${PRESS_AGAIN}`,
      severity: 'warning',
      source: ARCHIVE_NOTIFY_SOURCES.blocked,
    });
    return { refusal: 'already-tried' };
  }
  // The automatic dry run before this one left no finished report.
  const failures = auto.key && !latest?.complete ? count(auto.failures) + 1 : 0;
  if (failures >= AUTO_DRY_RUN_MAX_FAILURES) {
    await sayOnce(deps, year, 'dry-run-gave-up', {
      title: `Content archive of ${year}: no more automatic dry runs`,
      message: `${AUTO_DRY_RUN_MAX_FAILURES} automatic dry runs in a row did not finish, so no more are started by themselves and the yearly archive of ${year} cannot start. Nothing has been written. ${PRESS_AGAIN}`,
      severity: 'warning',
      source: ARCHIVE_NOTIFY_SOURCES.blocked,
    });
    return { refusal: 'gave-up' };
  }
  return { failures };
}

/** Tell the owner, once, when everything else is ready and only the report's findings stop the archive. */
export async function sayIfTheReportStopsIt(deps, year, blockers, backup) {
  if (!onlyBlockedBy(NEEDS_THE_OWNER, blockers, backup)) return;
  deps.log.warn?.(`[contentArchive] the archive of ${year} is not started: the dry-run report shows something to decide (${blockers.join(', ')})`);
  await sayOnce(deps, year, `waiting:${backup.runId}:${classificationFingerprint()}:${blockers.join(',')}`, {
    title: `Content archive of ${year} is waiting for you`,
    message: `The yearly archive of ${year} is ready to start, and the newest dry-run report shows something to decide first (${blockers.join(', ')}). Nothing has been written. Open the Archive card on Health, Overview and read the report; the content archive runbook says how to answer.`,
    severity: 'warning',
    source: ARCHIVE_NOTIFY_SOURCES.waiting,
  });
}
