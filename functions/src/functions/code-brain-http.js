/**
 * The Code Conductor brain's routes, under /api/cms/code-brain/ (#1457,
 * ADR 0036). Off by default: until CODE_BRAIN_ENABLED is "true" and its
 * owner, desktop client and database are set (lib/code-brain/config.js),
 * every route answers 401/403 for a missing or wrong token and 404 for the
 * rest, and nothing is read from Cosmos.
 *
 * No timer and no queue: this workspace has no search index to rebuild.
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { createBrainRepository } from '../lib/brain/repository.js';
import { CODE_RECORDS, codeBrainConfig } from '../lib/code-brain/config.js';
import { createCodeBrainStore } from '../lib/code-brain/store.js';
import { getCodeBrainSyncGuard } from '../lib/code-brain/guard.js';
import { createCodeBrainHandlers } from '../lib/code-brain/handlers.js';

const handlers = (context) => {
  const config = codeBrainConfig();
  const store = createCodeBrainStore({ database: config.database });
  return createCodeBrainHandlers({
    syncGuard: {
      requireRole: (...args) => getCodeBrainSyncGuard().requireRole(...args),
    },
    repo: createBrainRepository(
      store,
      config.ownerOid || 'unconfigured',
      store.batch,
      { records: CODE_RECORDS, search: null },
    ),
    log: context,
  });
};

export const CODE_BRAIN_ROUTES = Object.freeze([
  ['cmsCodeBrainStatus', 'status', { GET: 'status' }],
  ['cmsCodeBrainItems', 'items', { GET: 'list' }],
  ['cmsCodeBrainItem', 'items/{id}', { GET: 'get' }],
  ['cmsCodeBrainHistory', 'history/{id}', { GET: 'history' }],
  ['cmsCodeBrainSync', 'sync', { GET: 'syncPull', POST: 'syncPush' }],
  ['cmsCodeBrainSyncStatus', 'sync-status', { POST: 'syncStatus' }],
]);

for (const [name, path, methods] of CODE_BRAIN_ROUTES) {
  httpRouteByMethod(name, {
    authLevel: 'anonymous',
    route: `cms/code-brain/${path}`,
    handlers: Object.fromEntries(
      Object.entries(methods).map(([method, action]) => [
        method,
        (request, context) => handlers(context)[action](request, context),
      ]),
    ),
  });
}
