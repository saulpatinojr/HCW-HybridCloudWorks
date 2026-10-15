/**
 * cloud-tools-jobs.js — the pricing cache's two registrations (#613): the
 * daily timer that enqueues a refresh onto the platform jobs queue, and the
 * job type the worker runs it as.
 *
 * The timer ENQUEUES rather than refreshes. A run is 24 live lookups across
 * three regions, fetched one service at a time so AWS and Azure do not
 * throttle it; that is minutes of work, which belongs under the job worker's
 * budget and in a job document an operator can read, not inside a timer
 * whose only record is a duration. Same shape as cosmosExportScheduler.
 *
 * Gated like every timer: the master `FEATURE_FLAG_SCHEDULERS` must not be
 * "false" AND `FEATURE_FLAG_REFRESH_TOOL_SERVICE_CACHE` must be "true" — the
 * shared gate in lib/timers/flag-gate.js, so the first skip after a restart
 * is a Warning that reaches Log Analytics. The flag is in
 * `local.timer_catalogue` (infra/functionapp.tf) and arms through
 * `enabled_timers` like the rest; the app-clock is UTC (#416), so 02:00 is
 * 02:00 UTC, an hour before the Cosmos export.
 *
 * Provider credentials: Azure needs none, AWS reads AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY, GCP reads GCP_BILLING_API_KEY — all Key Vault
 * references (secret-catalog.js, section `cloud`). Until they are seeded a
 * run yields Azure live and the other two on baseline or absent, which is a
 * complete document, not a failed job: each provider is isolated inside
 * `fetchLivePricing`, and this file keeps it that way by never reading a
 * credential itself.
 */
import { app, output } from '@azure/functions';
import * as store from '../lib/cosmos-client.js';
import { registerJobType, JOBS_QUEUE, newJobDoc, JOBS_CONTAINER } from '../lib/jobs.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';
import {
  REFRESH_JOB_TYPE,
  createPricingRefresh,
  parseRefreshPayload,
} from '../lib/cloud-tools/refresh.js';
import { randomUUID } from 'node:crypto';

export const TIMER_NAME = 'refreshToolServiceCache';
export const TIMER_FLAG = 'REFRESH_TOOL_SERVICE_CACHE';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

/** "true" arms it; the schedulers master switch still holds it off. */
export const refreshEnabled = (env = process.env) => timerEnabled(TIMER_FLAG, env);

/**
 * Write a queued job document and hand back the queue message — the same
 * `newJobDoc` shape enqueueJob writes, so getJob, the sweeper and the worker's
 * claim read a timer-enqueued run exactly as they read a button-enqueued one.
 * `requestedBy` is null: there is no user behind a timer.
 */
export async function enqueueRefreshJob({
  store: jobStore,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const jobId = uuid();
  await jobStore.upsertDoc(
    JOBS_CONTAINER,
    newJobDoc({
      id: jobId,
      type: REFRESH_JOB_TYPE,
      payload: {},
      requestedBy: null,
      createdAt: now().toISOString(),
    })
  );
  return { jobId, type: REFRESH_JOB_TYPE };
}

app.timer(TIMER_NAME, {
  // 02:00 UTC daily. Before the 03:00 Cosmos export, and well clear of the
  // 04:00 and 05:00 reapers; the page's 1,440-minute TTL means a document
  // written here is fresh until the next run writes over it.
  schedule: '0 0 2 * * *',
  extraOutputs: [queueOutput],
  handler: async (_timer, context) => {
    if (!refreshEnabled()) {
      logDisabledSkip(context, TIMER_NAME);
      return;
    }
    const message = await enqueueRefreshJob({ store });
    context.extraOutputs.set(queueOutput, message);
    context.log(`[${TIMER_NAME}] enqueued ${message.type} ${message.jobId}`);
  },
});

registerJobType(REFRESH_JOB_TYPE, {
  // Editor: the Refresh button on the admin comparison page is the intended
  // caller, and an editor's token is what that page carries. The worker reads
  // three public price lists and rewrites a cache document; it publishes
  // nothing and reads nothing an editor cannot already see.
  role: 'editor',
  description:
    "Rebuild the Cloud Tools pricing cache: for each region option, fetch every catalog service from AWS, Azure and GCP (one service at a time) and upsert one tool_service_cache document per region; then cut the day's tool_price_history snapshot (history:<region>:<YYYY-MM-DD>) and diff it against the snapshots 7 and 30 days old into price-changes:<region> (Phase 3). A history failure is recorded in the summary, never a failed region. Payload { regions?: string[] } narrows the run; absent means all. Enqueued daily by refreshToolServiceCache (#613).",
  maxPayloadBytes: 512,
  // Three regions × eight services, sequential, each service up to three
  // provider calls with GCP paging up to 30 pages: minutes, not seconds.
  // Ten is generous for the observed run and far under the 30-minute host
  // limit; the sweeper reaps at timeout + 5 minutes.
  timeoutMs: 10 * 60 * 1000,
  worker: async (payload, { context, signal }) => {
    // Validated in the worker rather than at enqueue, like every other type:
    // enqueueJob checks role, size and serialisability only.
    const { regions } = parseRefreshPayload(payload);
    // The whole client: upsertDoc for the three documents per region and
    // readDoc for the history lookup (lib/cloud-tools/history.js).
    return createPricingRefresh({ store, log: context, signal }).run({ regions, signal });
  },
  // A failed refresh is a page reporting stale prices tomorrow; the phone
  // gets it now, like the export job.
  onComplete: createJobFailureOnComplete({ store }),
});
