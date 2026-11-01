/**
 * agent-content-http.js — the Agent Content API Koda calls, and the Koda
 * tab's one admin route (ADR 0037). Registration only; semantics in
 * lib/agent-content/handlers.js (the agent routes, which are the Drafts
 * routes and the public reads behind the key guard) and
 * lib/agent-content/admin-handlers.js (the key's lifecycle).
 *
 * Two guards, never mixed. The /api/agent-content/v1/* routes take Koda's
 * key (lib/agent-content/guard.js) and nothing else: an admin token is
 * refused there. The cms/agent-content/key route takes the admin role guard
 * and nothing else: Koda's key cannot read, make, change or revoke itself.
 * The route-inventory test knows the key guard by name, as it knows the lab
 * agent's.
 *
 * The base path is `agent-content/v1`, not the proposal's `agent/v1`:
 * `/api/agent/*` is the Labs VPS agent's namespace (lab-agent-http.js).
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  createDoc,
  deleteDoc,
  deleteDocIfMatch,
  patchDoc,
  queryDocs,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createDashboardStatsMaintainer } from '../lib/triggers/dashboard-stats.js';
import { getAgentContentGuard } from '../lib/agent-content/guard.js';
import { createAgentContentHandlers } from '../lib/agent-content/handlers.js';
import { createAgentContentAdminHandlers } from '../lib/agent-content/admin-handlers.js';
import { API_BASE_PATH } from '../lib/agent-content/keys.js';

// The same store, counters and log the Drafts routes compose (drafts-http.js),
// so a draft Koda writes is written exactly as one typed on the page.
const agent = (context) =>
  createAgentContentHandlers({
    guard: getAgentContentGuard(),
    store: { queryDocs, readDoc, createDoc, patchDoc, deleteDocIfMatch, upsertDoc },
    publicStore: { queryDocs, readDoc },
    onContentDeleted: (contentId) =>
      createDashboardStatsMaintainer({
        store: { readDoc, upsertDoc, replaceDocIfMatch, deleteDoc, patchDoc },
      }).applyTransition({ contentId, afterData: null }),
    log: context,
  });

const admin = (context) =>
  createAgentContentAdminHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, upsertDoc },
    log: context,
  });

/** [function name, path under the base, { METHOD: handler }] — one registration per template. */
export const AGENT_CONTENT_ROUTES = Object.freeze([
  ['agentContentStatus', 'status', { GET: 'status' }],
  ['agentContentDrafts', 'drafts', { GET: 'listDrafts', POST: 'createDraft' }],
  ['agentContentDraftFromMarkdown', 'drafts/from-markdown', { POST: 'createDraftFromMarkdown' }],
  ['agentContentDraft', 'drafts/{id}', { GET: 'getDraft', PUT: 'saveDraft', DELETE: 'deleteDraft' }],
  ['agentContentDraftSendToReview', 'drafts/{id}/send-to-review', { POST: 'sendToReview' }],
  ['agentContentDraftBackToDrafts', 'drafts/{id}/back-to-drafts', { POST: 'backToDrafts' }],
  ['agentContentPublished', 'published', { GET: 'listPublished' }],
  ['agentContentPublishedItem', 'published/{slugOrId}', { GET: 'getPublished' }],
]);

for (const [name, path, methods] of AGENT_CONTENT_ROUTES) {
  httpRouteByMethod(name, {
    authLevel: 'anonymous',
    route: `${API_BASE_PATH}/${path}`,
    handlers: Object.fromEntries(
      Object.entries(methods).map(([method, action]) => [
        method,
        (request, context) => agent(context)[action](request, context),
      ]),
    ),
  });
}

httpRouteByMethod('cmsAgentContentKey', {
  authLevel: 'anonymous',
  route: 'cms/agent-content/key',
  handlers: {
    GET: (request, context) => admin(context).getKey(request, context),
    POST: (request, context) => admin(context).generateKey(request, context),
    PATCH: (request, context) => admin(context).updateCapabilities(request, context),
    DELETE: (request, context) => admin(context).revokeKey(request, context),
  },
});
