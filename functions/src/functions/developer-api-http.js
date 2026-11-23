/**
 * developer-api-http.js — the Developer API v1 for event organizers, and the
 * admin routes for their keys (ADR 0042, Phase 1). Registration only;
 * semantics in lib/developer-api/handlers.js (the v1 routes) and
 * lib/developer-api/admin-handlers.js (the keys' lifecycle).
 *
 * Two guards. The keyed /api/developer/v1/* routes take an organizer key
 * (lib/developer-api/guard.js) and nothing else: an admin token and Koda's key
 * are refused there. The cms/developer-api/* routes take the admin role guard.
 * Three v1 reads and one v1 write are public by decision (ADR 0042): the
 * published events, the speakers, and sending a talk proposal, which is
 * origin-verified and rate-limited. The route-inventory test lists each of
 * them by route and method.
 *
 * Base path `developer/v1`: one namespace per machine caller. `/api/agent/*`
 * is the lab agent's, `/api/agent-content/v1/` is Koda's.
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createClientIdentity } from '../lib/auth/client-identity.js';
import {
  createDoc,
  deleteDocIfMatch,
  incrementIf,
  queryDocs,
  queryDocsPage,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { getDeveloperApiGuard } from '../lib/developer-api/guard.js';
import { createDeveloperApiHandlers } from '../lib/developer-api/handlers.js';
import { createDeveloperApiAdminHandlers } from '../lib/developer-api/admin-handlers.js';
import { API_BASE_PATH } from '../lib/developer-api/keys.js';

let identity = null;
const clientIdentity = () => (identity ||= createClientIdentity());

const api = () =>
  createDeveloperApiHandlers({
    guard: getDeveloperApiGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, queryDocsPage, deleteDocIfMatch, upsertDoc, incrementIf },
    publicStore: { readDoc },
    identity: clientIdentity(),
  });

const admin = (context) =>
  createDeveloperApiAdminHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, queryDocs, deleteDocIfMatch, upsertDoc },
    log: context,
  });

/** [function name, path under the base, { METHOD: handler }] — one registration per template. */
export const DEVELOPER_API_ROUTES = Object.freeze([
  ['developerApiStatus', 'status', { GET: 'status' }],
  ['developerApiPublishedEvents', 'published-events', { GET: 'publishedEvents' }],
  ['developerApiSpeakers', 'speakers', { GET: 'speakers' }],
  ['developerApiCallForSpeakers', 'events/{eventId}/call-for-speakers', { POST: 'setCall' }],
  [
    'developerApiCfsSubmissions',
    'events/{eventId}/call-for-speakers/submissions',
    { GET: 'listSubmissions', POST: 'submitProposal' },
  ],
  [
    'developerApiCfsSubmission',
    'events/{eventId}/call-for-speakers/submissions/{submissionId}',
    { PUT: 'reviewSubmission', DELETE: 'deleteSubmission' },
  ],
]);

for (const [name, path, methods] of DEVELOPER_API_ROUTES) {
  httpRouteByMethod(name, {
    authLevel: 'anonymous',
    route: `${API_BASE_PATH}/${path}`,
    handlers: Object.fromEntries(
      Object.entries(methods).map(([method, action]) => [
        method,
        (request, context) => api()[action](request, context),
      ]),
    ),
  });
}

httpRouteByMethod('cmsDeveloperApiKeys', {
  authLevel: 'anonymous',
  route: 'cms/developer-api/keys',
  handlers: {
    GET: (request, context) => admin(context).listKeys(request, context),
    POST: (request, context) => admin(context).createKey(request, context),
  },
});

httpRouteByMethod('cmsDeveloperApiKey', {
  authLevel: 'anonymous',
  route: 'cms/developer-api/keys/{keyId}',
  handlers: {
    PATCH: (request, context) => admin(context).updateKey(request, context),
    DELETE: (request, context) => admin(context).revokeKey(request, context),
  },
});

httpRouteByMethod('cmsDeveloperApiKeyRotate', {
  authLevel: 'anonymous',
  route: 'cms/developer-api/keys/{keyId}/rotate',
  handlers: {
    POST: (request, context) => admin(context).rotateKey(request, context),
  },
});

// A speaker's erasure request (#1777): find where an address has proposals,
// then delete each one. The address travels in the body, so it is a POST.
httpRouteByMethod('cmsDeveloperApiProposalSearch', {
  authLevel: 'anonymous',
  route: 'cms/developer-api/proposal-search',
  handlers: {
    POST: (request, context) => admin(context).findProposals(request, context),
  },
});

httpRouteByMethod('cmsDeveloperApiProposal', {
  authLevel: 'anonymous',
  route: 'cms/developer-api/proposals/{submissionId}',
  handlers: {
    DELETE: (request, context) => admin(context).eraseProposal(request, context),
  },
});
