/**
 * ops-health-http.js — operations-health snapshot + workflow-alert RPCs at
 * the frontend's route names. Registration only; semantics in
 * lib/ops-health.js.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { queryDocs, readDoc, upsertDoc, patchDoc } from '../lib/cosmos-client.js';
import { createOpsHealthHandlers } from '../lib/ops-health.js';

// One store object for the module's life, not a literal per request: the
// snapshot cache in lib/ops-health.js is keyed on it, and a new object on
// every request would be a new key, and so an empty cache, every time (#946).
const store = Object.freeze({ queryDocs, readDoc, upsertDoc, patchDoc });

/**
 * A handler set for one request. Built per request so the guard is composed
 * lazily (lib/auth/default-guard.js); the snapshot cache outlives it.
 */
const handlers = () =>
  createOpsHealthHandlers({
    guard: getDefaultGuard(),
    store,
  });

httpRoute('getOpsHealthSnapshot', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'getOpsHealthSnapshot',
  handler: (request, context) => handlers().getOpsHealthSnapshot(request, context),
});

httpRoute('updateWorkflowAlert', {
  methods: ['POST', 'PATCH'],
  authLevel: 'anonymous',
  route: 'updateWorkflowAlert',
  handler: (request, context) => handlers().updateWorkflowAlert(request, context),
});
