/**
 * search-console-http.js — the admin Search Console page's routes and the
 * job its Run now button queues (#1612). Semantics in lib/search-console/.
 *
 *   GET  cms/search-console       the snapshot the last run wrote
 *   POST cms/search-console/run   queue one run now (job sync-search-console)
 *
 * The twice-a-day run is the `syncSearchConsole` timer in schedulers.js; it
 * runs the same lib/search-console/sync.js in place. The job's queue message
 * goes out through the same Storage Queue output binding enqueueJob uses.
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import * as store from '../lib/cosmos-client.js';
import { JOBS_QUEUE, registerJobType } from '../lib/jobs.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { AuthoredError } from '../lib/http/error-response.js';
import { createSearchConsoleHandlers, SYNC_JOB_TIMEOUT_MS, SYNC_JOB_TYPE } from '../lib/search-console/handlers.js';
import { createSearchConsoleSync } from '../lib/search-console/sync.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

const handlers = () =>
  createSearchConsoleHandlers({
    guard: getDefaultGuard(),
    store: { readDoc: store.readDoc, upsertDoc: store.upsertDoc, queryDocs: store.queryDocs },
  });

httpRoute('cmsSearchConsole', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/search-console',
  handler: (request, context) => handlers().get(request, context),
});

httpRoute('cmsSearchConsoleRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/search-console/run',
  extraOutputs: [queueOutput],
  handler: (request, context) =>
    handlers().run(request, context, {
      enqueue: (message) => context.extraOutputs.set(queueOutput, message),
    }),
});

/** A run that could not sign in to Google or read the property: the job fails with the run's own sentence. */
class SearchConsoleRunFailed extends AuthoredError {}

registerJobType(SYNC_JOB_TYPE, {
  // Editor, the role of POST cms/search-console/run, which queues it
  // (jobs.roles.test.js pairs them). The worker reads Google's data about
  // the public site and rewrites one admin_config document; it publishes
  // nothing.
  role: 'editor',
  description:
    'Refresh the admin Search Console page (#1612): inspect every root-domain page in the sitemap with Google\'s URL Inspection API (at most 900), read 90 days of Search Analytics and the sitemaps list, and replace admin_config/search_console_snapshot. No payload. Skips with not_configured when the Google sign-in settings are empty.',
  maxPayloadBytes: 64,
  // About 200 pages, four at a time and paced under Google's 600 a minute:
  // two to four minutes. Twenty leaves room for 900 pages and Google's
  // retries, well under the 30-minute Flex limit.
  timeoutMs: SYNC_JOB_TIMEOUT_MS,
  worker: async (_payload, { context, signal }) => {
    const result = await createSearchConsoleSync({
      store: { readDoc: store.readDoc, createDoc: store.createDoc, replaceDocIfMatch: store.replaceDocIfMatch },
      log: context,
      signal,
    }).run();
    if (result?.status === 'error') {
      // The document already says what failed; the job records the same.
      throw new SearchConsoleRunFailed('The Search Console run failed; the page shows which step.', {
        code: 'GSC_RUN_FAILED',
      });
    }
    return result;
  },
  // A failed run reaches the phone, like the other jobs' failures.
  onComplete: createJobFailureOnComplete({ store }),
});
