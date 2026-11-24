/**
 * content-archive-http.js — the yearly content archive's admin routes and
 * the job a dry run queues (ADR 0046, issue #1811). Registration only;
 * semantics in lib/backup/archive-handlers.js and lib/backup/archive-report.js.
 *
 *   GET  cms/content-archive           where the archive stands, and the newest dry-run report
 *   POST cms/content-archive/dry-run   start a dry run
 *
 * There is NO timer here and nothing that writes an archive: that job is
 * phase 3 of ADR 0046. The app setting CONTENT_ARCHIVE_ENABLED is read only
 * to report whether it is on. So this file is safe to deploy before or after
 * the Terraform run that adds the setting and the `content-archive`
 * container: with the setting absent the switch reads as off, and with the
 * container absent the status says "the container does not exist yet" and
 * the year's archive is "not known" (never "not archived": a missing
 * container must not look like a year that is safe to start). A dry run needs
 * neither; it reads the backup and writes its report beside the backup's own
 * working state.
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import * as store from '../lib/cosmos-client.js';
import { JOBS_QUEUE, registerJobType } from '../lib/jobs.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { createExportBlobStore } from '../lib/backup/cosmos-export-edges.js';
import { createArchiveHandlers } from '../lib/backup/archive-handlers.js';
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

// Built per request: the guard is resolved lazily so this module stays
// importable without one (the route inventory imports every module).
const handlers = () =>
  createArchiveHandlers({
    guard: getDefaultGuard(),
    store: { upsertDoc: store.upsertDoc },
    blobs: createExportBlobStore(),
    // Its own store on the archive's container: only ever read here.
    archiveBlobs: createExportBlobStore({ container: ARCHIVE_CONTAINER, stateContainer: ARCHIVE_CONTAINER }),
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

registerJobType(REPORT_JOB_TYPE, {
  // The role of POST cms/content-archive/dry-run, which queues it. The
  // worker reads one container's backup file and writes counts.
  role: 'super_admin',
  description:
    'Archive dry run (ADR 0046): read one container’s file from a weekly full backup in the private cosmos-export blob container, a line at a time, put every record through the archive classification, and write a small part file of counts, the common top-level field names, and a count of records carrying a field whose name looks like a secret (names only, never a value) under state/archive-report/ in cosmos-export-state; the job that finds every part present writes the report. Writes nothing to content-archive and changes no record. Queued by POST cms/content-archive/dry-run.',
  maxPayloadBytes: 1024,
  // Under the 30-minute non-HTTP host limit, with room for the terminal write.
  timeoutMs: 28 * 60 * 1000,
  worker: async (payload, { context, signal }) => {
    const job = parseReportPayload(payload);
    return createReportWorker({ blobs: createExportBlobStore(), log: context }).readContainer({ ...job, signal });
  },
  onComplete: createJobFailureOnComplete({ store }),
});
