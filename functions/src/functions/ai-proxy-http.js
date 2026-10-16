/**
 * ai-proxy-http.js — registration for the admin AI RPCs (#180) and the
 * selection document (ADR 0034 §2) with its two reads of production (§4).
 * Semantics in lib/ai/proxy.js, lib/admin-integrations/ai-routing.js and
 * lib/admin-integrations/ai-tasks.js.
 *
 * aiProxy / testAiProvider are RPC-style routes, not REST: the frontend
 * posts to a function NAME (`postJSON('aiProxy', ...)` in lib/api.js), which
 * is the shape the Firebase callable functions had and the admin UI still
 * uses. `cms/ai-routing` is REST (GET/PUT), beside `cms/ai-features`;
 * `cms/ai-routing/effective` (GET) is the resolver's answer per task, and
 * `cms/ai-routing/test/{task}` (POST) runs a task's chain with the Test's
 * limits (ADR 0034 slice 4, #859).
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { readDoc, upsertDoc, patchDoc, queryDocs, deleteDoc, incrementIf, createDoc } from '../lib/cosmos-client.js';
import { createAiProxyHandlers } from '../lib/ai/proxy.js';
import { createAdminIntegrationHandlers } from '../lib/admin-integrations.js';
import * as ai from '../lib/ai/router.js';
import { getCostEstimate } from '../lib/ai/router.js';

const handlers = () =>
  createAiProxyHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, upsertDoc, patchDoc, incrementIf, createDoc },
    ai: { callProvider: ai.callProvider, getCostEstimate },
  });

// The routing document's handlers live beside the feature switches in
// admin-integrations.js; the router's cache is dropped after every write so
// a change applies on the next call, not after the 60 s TTL. The effective
// read and the per-task Test run the router itself.
const routingHandlers = () =>
  createAdminIntegrationHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, upsertDoc, patchDoc, deleteDoc },
    onAiConfigChanged: ai.invalidateConfig,
    availableProviders: ai.availableProviders,
    availableMediaProviders: ai.availableMediaProviders,
    effectiveSelection: ai.resolveEffectiveSelection,
    ai: { callProvider: ai.callProvider, getCostEstimate },
  });

httpRoute('aiProxy', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'aiProxy',
  handler: (request, context) => handlers().aiProxy(request, context),
});

httpRoute('testAiProvider', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'testAiProvider',
  handler: (request, context) => handlers().testAiProvider(request, context),
});

httpRouteByMethod('cmsAiRouting', {
  authLevel: 'anonymous',
  route: 'cms/ai-routing',
  handlers: {
    GET: (request, context) => routingHandlers().getAiRouting(request, context),
    PUT: (request, context) => routingHandlers().putAiRouting(request, context),
  },
});

httpRoute('cmsAiRoutingEffective', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/ai-routing/effective',
  handler: (request, context) => routingHandlers().getAiRoutingEffective(request, context),
});

httpRoute('cmsAiRoutingTest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/ai-routing/test/{task}',
  handler: (request, context) => routingHandlers().testAiTask(request, context),
});
