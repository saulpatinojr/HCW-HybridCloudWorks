/**
 * cosmos-export.js — the out-of-account Cosmos export's two registrations
 * (ADR 0028, issue #231): the daily timer that fans one job per container
 * onto the platform jobs queue, and the job type the worker runs them as.
 *
 * Gated like every timer (schedulers.js, jobs-sweeper.js): the master
 * `FEATURE_FLAG_SCHEDULERS` must not be "false" AND `FEATURE_FLAG_COSMOS_EXPORT`
 * must be "1" (or "true"). Absent or anything else, the timer logs and
 * returns, so the code is inert on a deploy until the app setting is flipped
 * — the Terraform half of #231 adds the setting.
 *
 * The same timer also makes the yearly content archive's daily check
 * (`contentArchiveCheck` below, ADR 0046), which has its own switch.
 *
 * The run id and the full/delta decision come from the UTC clock
 * (`runIdFor`/`modeFor` in lib/backup/cosmos-export.js), and so does the
 * schedule: the app sets no `WEBSITE_TIME_ZONE`, so NCRONTAB reads UTC too
 * (#416). This used to say the two agreed "whichever time zone the schedule
 * fires in" — a real defence while the app clock was America/Chicago and
 * 03:00 local could have been a different UTC day from the run id. There is
 * now one clock and nothing left for that sentence to defend against.
 */
import { app, output } from '@azure/functions';
import * as store from '../lib/cosmos-client.js';
import { registerJobType, JOBS_QUEUE } from '../lib/jobs.js';
import { createEventTracker } from '../lib/telemetry.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import {
  EXPORT_JOB_TYPE,
  createExportScheduler,
  createContainerExporter,
  exportEnabled,
  parseExportPayload,
} from '../lib/backup/cosmos-export.js';
import { createCosmosReader, createExportBlobStore } from '../lib/backup/cosmos-export-edges.js';
import { ARCHIVE_CONTAINER, createArchiveScheduler } from '../lib/backup/archive-job.js';
import { createNotifier } from '../lib/notify.js';
import { errorCode } from '../lib/http/error-response.js';
import { jsonForLog } from '../lib/http/log-json.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

/** "1" or "true" arms it; the schedulers master switch still holds it off. */
export { exportEnabled };

app.timer('cosmosExportScheduler', {
  // 03:00 UTC daily; Sunday is the weekly full, the other six days are deltas.
  schedule: '0 0 3 * * *',
  extraOutputs: [queueOutput],
  handler: async (_timer, context) => {
    if (!exportEnabled()) {
      context.log('cosmosExportScheduler: disabled (FEATURE_FLAG_COSMOS_EXPORT)');
      return;
    }
    const messages = [];
    const result = await createExportScheduler({
      store,
      blobs: createExportBlobStore(),
      enqueue: (message) => messages.push(message),
      log: context,
    }).run();
    const archive = await contentArchiveCheck(context, (message) => messages.push(message));
    if (messages.length) context.extraOutputs.set(queueOutput, messages);
    // runId is the run's date label, not a stored document's id, so it is kept.
    context.log(`cosmosExportScheduler: ${jsonForLog(result, { keep: ['runId'] })}`);
    context.log(
      `contentArchive: ${archive.action}, year ${archive.year ?? 'unknown'}, ${archive.queued ?? 0} job(s) queued${archive.blockers?.length ? `, waiting on: ${archive.blockers.join(', ')}` : ''}`
    );
  },
});

/**
 * The yearly content archive's daily check (ADR 0046 section 4, #1811;
 * lib/backup/archive-job.js). It rides this timer, after the export has been
 * queued, because the archive is made from the export's weekly backup: with
 * the export off there is no backup to read, so there is nothing to check.
 * It does nothing unless the app setting CONTENT_ARCHIVE_ENABLED is "true",
 * and then only once a year, on or after 1 February.
 *
 * A failure here is logged by its code and never fails the export's own run.
 *
 * @param {import('@azure/functions').InvocationContext} context
 * @param {(message: { jobId: string, type: string }) => void} enqueue
 */
export async function contentArchiveCheck(context, enqueue, deps = {}) {
  try {
    return await createArchiveScheduler({
      store,
      backupBlobs: createExportBlobStore(),
      archiveBlobs: createExportBlobStore({ container: ARCHIVE_CONTAINER, stateContainer: ARCHIVE_CONTAINER }),
      enqueue,
      notifier: createNotifier({ store, log: context }),
      log: context,
      ...deps,
    }).run();
  } catch (error) {
    context.error?.(`contentArchive: the daily check failed (${errorCode(error)})`);
    return { action: 'failed' };
  }
}

registerJobType(EXPORT_JOB_TYPE, {
  // No HTTP route performs this; the timer is its only intended caller. The
  // worker reads every document of a container and writes it out of the
  // account, so a hand-enqueue is a super_admin act.
  role: 'super_admin',
  description:
    'Export one Cosmos container for one run (full: SELECT * paged; delta: change feed from the stored continuation) as gzip NDJSON into the private cosmos-export blob container, then write its marker and, if it is the last, the run manifest. Enqueued by cosmosExportScheduler (ADR 0028).',
  maxPayloadBytes: 1024,
  // Under the 30-minute non-HTTP host limit, with room for the terminal write.
  timeoutMs: 28 * 60 * 1000,
  worker: async (payload, { context, signal }) => {
    const job = parseExportPayload(payload);
    return createContainerExporter({
      cosmos: createCosmosReader(),
      blobs: createExportBlobStore(),
      tracker: createEventTracker({ log: context }),
      log: context,
      signal,
    }).exportContainer({ ...job, signal });
  },
  // A container that fails to export is a missing marker, which the alert
  // will surface in hours; the phone gets it now.
  onComplete: createJobFailureOnComplete({ store }),
});
