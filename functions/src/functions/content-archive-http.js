/**
 * content-archive-http.js — the yearly content archive's admin routes and
 * its two job types (ADR 0046, issue #1811). Registration only; semantics in
 * lib/backup/archive-handlers.js, archive-report.js and archive-job.js.
 *
 *   GET  cms/content-archive           where the archive stands, and the newest dry-run report
 *   POST cms/content-archive/dry-run   start a dry run
 *
 * There is NO timer here and NO route that starts an archive. An archive
 * starts by itself: the nightly export's timer (cosmos-export.js) makes the
 * daily check, which queues one `content-archive-container` job per
 * container when the app setting CONTENT_ARCHIVE_ENABLED is "true" and the
 * start rule allows it. This file only registers what those jobs run.
 *
 * Safe to deploy before or after the Terraform run that adds the setting and
 * the `content-archive` container: with the setting absent the switch reads
 * as off and nothing is written, and with the container absent the status
 * says "the container does not exist yet" and the year's archive is "not
 * known" (never "not archived": a missing container must not look like a
 * year that is safe to start). A dry run needs neither; it reads the backup
 * and writes its report beside the backup's own working state.
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import * as store from '../lib/cosmos-client.js';
import { JOBS_QUEUE, registerJobType } from '../lib/jobs.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { createExportBlobStore } from '../lib/backup/cosmos-export-edges.js';
import { createArchiveHandlers } from '../lib/backup/archive-handlers.js';
import { ARCHIVE_JOB_TYPE, createArchiveWorker, parseArchivePayload } from '../lib/backup/archive-job.js';
import { createNotifier } from '../lib/notify.js';
import { contentArchiveCheck } from '../lib/backup/archive-check.js';
import { exportEnabled } from '../lib/backup/cosmos-export.js';
import {
  ARCHIVE_CONTAINER,
  REPORT_JOB_TYPE,
  createReportWorker,
  parseReportPayload,
} from '../lib/backup/archive-report.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

/** A blob store on the archive's own container. The routes only read it; the archive job writes it. */
const archiveBlobStore = () =>
  createExportBlobStore({ container: ARCHIVE_CONTAINER, stateContainer: ARCHIVE_CONTAINER });

// Built per request: the guard is resolved lazily so this module stays
// importable without one (the route inventory imports every module).
const handlers = () =>
  createArchiveHandlers({
    guard: getDefaultGuard(),
    store: { upsertDoc: store.upsertDoc },
    blobs: createExportBlobStore(),
    archiveBlobs: archiveBlobStore(),
  });

httpRoute('cmsContentArchive', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/content-archive',
  handler: (request, context) => handlers().getStatus(request, context),
});

httpRoute('cmsContentArchiveDryRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/content-archive/dry-run',
  extraOutputs: [queueOutput],
  handler: (request, context) =>
    handlers().startDryRun(request, context, {
      enqueue: (messages) => context.extraOutputs.set(queueOutput, messages),
    }),
});

/** How long the dry-run job may run (under the 30-minute non-HTTP host limit, with room for the terminal write). */
const REPORT_JOB_TIMEOUT_MS = 28 * 60 * 1000;
/** The archive check is given up to two minutes; it is started only with this much of the job's time left. */
const ARCHIVE_CHECK_ROOM_MS = 3 * 60 * 1000;

/**
 * The job that writes a finished dry-run report runs the archive's daily
 * check at once, so a dry run that clears the way starts the archive today
 * instead of at the next 03:00 UTC timer. Before this, any change to the
 * list of what is kept between a dry run and the next morning sent the
 * archive back a day (#1811). It is the timer's own check: it does nothing
 * while the switch is off or the year is archived, and it never fails the
 * job (it catches its own errors). Like the timer, it runs only while the
 * nightly export is on. It is skipped when less than ARCHIVE_CHECK_ROOM_MS
 * of the job's time is left, so a slow last part is never marked timed out
 * for it; the 03:00 UTC timer then picks it up.
 */
export async function archiveCheckAfterReport(context, enqueue, elapsedMs, { check = contentArchiveCheck, enabled = exportEnabled } = {}) {
  if (!enabled()) return { action: 'export-off' };
  if (REPORT_JOB_TIMEOUT_MS - elapsedMs < ARCHIVE_CHECK_ROOM_MS) {
    context.log?.('contentArchive: the dry run finished too close to its time limit to run the archive check; the 03:00 UTC check will');
    return { action: 'left-for-the-timer' };
  }
  return check(context, enqueue);
}

registerJobType(REPORT_JOB_TYPE, {
  // The role of POST cms/content-archive/dry-run, which queues it. The
  // worker reads one container's backup file and writes counts.
  role: 'super_admin',
  description:
    'Archive dry run (ADR 0046): read one container’s file from a weekly full backup in the private cosmos-export blob container, a line at a time, put every record through the archive classification, and write a small part file of counts, the common top-level field names, and a count of records carrying a field whose name looks like a secret (names only, never a value) under state/archive-report/ in cosmos-export-state; the job that finds every part present writes the report. Writes nothing to content-archive and changes no record. The job that writes the report then runs the archive’s daily check, which starts the archive when the report allows it. Queued by POST cms/content-archive/dry-run and by the daily check.',
  maxPayloadBytes: 1024,
  timeoutMs: REPORT_JOB_TIMEOUT_MS,
  worker: async (payload, { context, signal, enqueue }) => {
    const began = Date.now();
    const job = parseReportPayload(payload);
    const result = await createReportWorker({ blobs: createExportBlobStore(), log: context }).readContainer({ ...job, signal });
    if (result?.reportWritten) await archiveCheckAfterReport(context, enqueue, Date.now() - began);
    return result;
  },
  onComplete: createJobFailureOnComplete({ store }),
});

registerJobType(ARCHIVE_JOB_TYPE, {
  // No HTTP route queues this; the daily check on the nightly export's timer
  // is its only intended caller. The worker writes one file of the long-term
  // archive, so a hand-queued job is a super_admin act. It still writes
  // nothing unless CONTENT_ARCHIVE_ENABLED is "true", the year has no
  // manifest yet and the payload matches the run that is in progress.
  role: 'super_admin',
  description:
    'Yearly content archive (ADR 0046): read one container’s file from the pinned weekly full backup in the private cosmos-export blob container, a line at a time, keep only the records and fields the archive classification keeps, and write them as gzip NDJSON to <year>/cosmos/ in the private content-archive container; read the file back and check its sha256 and record count; note the result under state/archive-run/ in cosmos-export-state. The job that finds every file checked writes <year>/manifest.json, create-only, and only then moves the data files to the Archive tier. Writes nothing when CONTENT_ARCHIVE_ENABLED is not "true" or the year already has a manifest. Queued by the daily check on cosmosExportScheduler.',
  maxPayloadBytes: 1024,
  // Under the 30-minute non-HTTP host limit, with room for the terminal write.
  timeoutMs: 28 * 60 * 1000,
  worker: async (payload, { context, signal }) => {
    const job = parseArchivePayload(payload);
    return createArchiveWorker({
      backupBlobs: createExportBlobStore(),
      archiveBlobs: archiveBlobStore(),
      notifier: createNotifier({ store, log: context }),
      log: context,
    }).archiveContainer({ ...job, signal });
  },
  // A container whose file could not be written or checked is said on the
  // phone now; the next daily check queues it again.
  onComplete: createJobFailureOnComplete({ store }),
});
