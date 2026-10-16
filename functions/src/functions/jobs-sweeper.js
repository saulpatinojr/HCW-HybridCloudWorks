/**
 * jobs-sweeper.js — closes the known gap in lib/jobs.js: the job document is
 * written before the queue output binding sends the message, so a binding
 * failure leaves a job `queued` forever. Every 15 minutes this timer
 * re-enqueues jobs that have sat `queued` longer than STALE_QUEUED_MS and
 * stamps `requeuedAt`/`requeueCount` on them. Re-delivery is safe: the worker
 * claims a job with an etag-conditioned replace, so a duplicate message for a
 * job that did start is skipped.
 *
 * Same gating as every timer (schedulers.js): `FEATURE_FLAG_SCHEDULERS` as
 * the master switch and its own `FEATURE_FLAG_PLATFORM_JOB_SWEEPER`.
 */
import { app, output } from '@azure/functions';
import { queryDocs, patchDoc } from '../lib/cosmos-client.js';
import { createJobSweeper, JOBS_QUEUE } from '../lib/jobs.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

const enabled = () =>
  process.env.FEATURE_FLAG_SCHEDULERS !== 'false' &&
  process.env.FEATURE_FLAG_PLATFORM_JOB_SWEEPER === 'true';

app.timer('platformJobSweeper', {
  schedule: '0 */15 * * * *',
  extraOutputs: [queueOutput],
  handler: async (_timer, context) => {
    if (!enabled()) {
      context.log('platformJobSweeper: disabled (FEATURE_FLAG_PLATFORM_JOB_SWEEPER)');
      return;
    }
    const { requeued, reaped } = await createJobSweeper({
      store: { queryDocs, patchDoc },
      log: context,
    }).sweep();
    if (requeued.length) context.extraOutputs.set(queueOutput, requeued);
    const msg =
      `platformJobSweeper: re-enqueued ${requeued.length} stale job(s), ` +
      `reaped ${reaped.length} abandoned running job(s)`;
    if (requeued.length > 0 || reaped.length > 0) {
      context.warn(msg);
    } else {
      context.log(msg);
    }
  },
});
