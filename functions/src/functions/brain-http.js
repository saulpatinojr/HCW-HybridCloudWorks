import { app, output } from '@azure/functions';
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import * as store from '../lib/cosmos-client.js';
import * as ai from '../lib/ai/router.js';
import { getBrainSyncGuard } from '../lib/brain/guard.js';
import {
  createBrainRepository,
  cosmosBrainBatch,
} from '../lib/brain/repository.js';
import { createBrainHandlers } from '../lib/brain/handlers.js';
import { BRAIN_QUEUE, createBrainIndexer } from '../lib/brain/indexing.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';

const queue = output.storageQueue({
  queueName: BRAIN_QUEUE,
  connection: 'AzureWebJobsStorage',
});
const repository = () =>
  createBrainRepository(
    store,
    process.env.BRAIN_OWNER_OID || 'unconfigured',
    cosmosBrainBatch,
  );
const handlers = (context) =>
  createBrainHandlers({
    guard: getDefaultGuard(),
    syncGuard: {
      requireRole: (...args) => getBrainSyncGuard().requireRole(...args),
    },
    repo: repository(),
    ai,
    log: context,
    enqueue: (message) => context.extraOutputs.set(queue, message),
  });
const routes = [
  ['cmsBrainStatus', 'status', { GET: 'status' }],
  ['cmsBrainItems', 'items', { GET: 'list', POST: 'save' }],
  ['cmsBrainItem', 'items/{id}', { GET: 'get' }],
  ['cmsBrainHistory', 'history/{id}', { GET: 'history' }],
  ['cmsBrainSearch', 'search', { POST: 'search' }],
  ['cmsBrainGraph', 'graph', { GET: 'graph' }],
  ['cmsBrainReindex', 'reindex', { POST: 'reindex' }],
  ['cmsBrainDraft', 'draft/{id}', { POST: 'draft' }],
  ['cmsBrainContext', 'context', { GET: 'context' }],
  ['cmsBrainAsk', 'ask', { POST: 'ask' }],
  ['cmsBrainSync', 'sync', { GET: 'syncPull', POST: 'syncPush' }],
  ['cmsBrainSyncReferences', 'sync-references', { GET: 'syncReferences' }],
  ['cmsBrainSyncStatus', 'sync-status', { POST: 'syncStatus' }],
];
for (const [name, path, methods] of routes) {
  httpRouteByMethod(name, {
    authLevel: 'anonymous',
    route: `cms/brain/${path}`,
    ...(name === 'cmsBrainReindex' && { extraOutputs: [queue] }),
    handlers: Object.fromEntries(
      Object.entries(methods).map(([method, action]) => [
        method,
        (request, context) => handlers(context)[action](request, context),
      ]),
    ),
  });
}
const enabled = () =>
  process.env.BRAIN_ENABLED === 'true' &&
  Boolean(process.env.BRAIN_OWNER_OID && process.env.BRAIN_OWNER_TENANT_ID);
app.storageQueue('brainIndexWorker', {
  queueName: BRAIN_QUEUE,
  connection: 'AzureWebJobsStorage',
  extraOutputs: [queue],
  handler: async (message, context) => {
    if (!enabled()) return;
    const parsed = typeof message === 'string' ? JSON.parse(message) : message;
    if (parsed?.ownerId !== process.env.BRAIN_OWNER_OID) return;
    if (await createBrainIndexer(repository()).step())
      context.extraOutputs.set(queue, { ownerId: process.env.BRAIN_OWNER_OID });
  },
});
/**
 * The Second Brain index timer and its own switch (#1822). It runs when three
 * things hold: Second Brain is on (`enabled()` above), the schedulers master
 * switch `FEATURE_FLAG_SCHEDULERS` is not "false", and its own flag
 * `FEATURE_FLAG_BRAIN_INDEX_RECONCILE` is "true". The last two are the gate
 * every catalogued timer uses (lib/timers/flag-gate.js); the flag is written
 * by Terraform from `local.timer_catalogue` (infra/functionapp.tf) and is
 * "true" only while BRAIN_INDEX_RECONCILE is in the `enabled_timers` workspace
 * variable. Switched off, the timer still fires and returns at once, so the
 * overdue-timer alert stays quiet; the index is then rebuilt only by the
 * Index creator content button.
 */
const TIMER_NAME = 'brainIndexReconcile';
const TIMER_FLAG = 'BRAIN_INDEX_RECONCILE';
app.timer(TIMER_NAME, {
  schedule: '0 */15 * * * *',
  runOnStartup: false,
  extraOutputs: [queue],
  handler: async (_timer, context) => {
    // Second Brain off: nothing to say, as before. The timer's own switch
    // off: say so once per process at Warning, like its siblings.
    if (!enabled()) return;
    if (!timerEnabled(TIMER_FLAG)) {
      logDisabledSkip(context, TIMER_NAME);
      return;
    }
    // Every firing resumes an unfinished rebuild; a new full rebuild starts
    // only once a day (REBUILD_INTERVAL_MS, #1772). When there is nothing to
    // do, no message is queued, so the worker does not run at all.
    const { action } = await createBrainIndexer(repository()).reconcile();
    if (action !== 'wait')
      context.extraOutputs.set(queue, { ownerId: process.env.BRAIN_OWNER_OID });
  },
});
