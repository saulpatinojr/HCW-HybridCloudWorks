/**
 * archive-check.js — the yearly content archive's daily check, as one call
 * (ADR 0046 section 4, #1811). Two callers: the nightly export's timer
 * (functions/cosmos-export.js), and the archive dry-run job that writes a
 * finished report (functions/content-archive-http.js), so a dry run that
 * clears the way starts the archive at once instead of at the next timer.
 * It lives here, not in a function file, so neither caller imports the
 * other's registrations.
 */
import * as store from '../cosmos-client.js';
import { createExportBlobStore } from './cosmos-export-edges.js';
import { ARCHIVE_CHECK_DEADLINE_MS, ARCHIVE_CONTAINER, createArchiveScheduler } from './archive-job.js';
import { createNotifier } from '../notify.js';
import { errorCode } from '../http/error-response.js';

/**
 * The yearly content archive's daily check (ADR 0046 section 4, #1811;
 * lib/backup/archive-job.js). The nightly export's timer runs it after the
 * export has been queued, because the archive is made from the export's
 * weekly backup: with the export off there is no backup to read, so there is
 * nothing to check. The dry-run job that writes a finished report runs it too.
 * It does nothing unless the app setting CONTENT_ARCHIVE_ENABLED is "true",
 * and then only once a year, on or after 1 February.
 *
 * A failure here is logged by its code and never fails the caller's own run.
 * Neither does a check that never answers: it is given a deadline
 * (ARCHIVE_CHECK_DEADLINE_MS, two minutes), after which the caller stops
 * waiting and says so. A job the check created after that is not lost: its
 * record is in the jobs container, and the job sweeper queues it.
 *
 * @param {import('@azure/functions').InvocationContext} context
 * @param {(message: { jobId: string, type: string }) => void} enqueue
 * @param {object} [deps] - for tests: the scheduler's parts, and `deadlineMs`
 */
export async function contentArchiveCheck(context, enqueue, { deadlineMs = ARCHIVE_CHECK_DEADLINE_MS, ...deps } = {}) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ action: 'timed-out' }), deadlineMs);
  });
  const check = (async () =>
    createArchiveScheduler({
      store,
      backupBlobs: createExportBlobStore(),
      archiveBlobs: createExportBlobStore({ container: ARCHIVE_CONTAINER, stateContainer: ARCHIVE_CONTAINER }),
      enqueue,
      notifier: createNotifier({ store, log: context }),
      log: context,
      ...deps,
    }).run())().catch((error) => {
    context.error?.(`contentArchive: the daily check failed (${errorCode(error)})`);
    return { action: 'failed' };
  });
  try {
    const answer = await Promise.race([check, deadline]);
    if (answer.action === 'timed-out') {
      context.error?.(`contentArchive: the daily check did not answer in ${Math.round(deadlineMs / 1000)} seconds, so its caller carried on without it`);
    }
    return answer;
  } finally {
    clearTimeout(timer);
  }
}
