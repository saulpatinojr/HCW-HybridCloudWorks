/**
 * cost-http.js — the admin portal's Cost page routes (ADR 0039).
 * Registration only; semantics in lib/cost/handlers.js.
 *
 * Three registrations, because the Functions host keys its route table on
 * the template alone (lib/auth/http-route.js httpRouteByMethod): the summary
 * answers GET; the ledger collection answers GET and POST and one row
 * answers PATCH and DELETE; the settings answer GET and PUT.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createDoc, queryDocs, readDoc, replaceDocIfMatch, upsertDoc } from '../lib/cosmos-client.js';
import { createCostHandlers } from '../lib/cost/handlers.js';

// readDoc, createDoc and replaceDocIfMatch: the ledger and the snapshot are
// one document each, written under the ETag they were read at. queryDocs
// reads the AI usage ledger when the snapshot is refreshed. upsertDoc only
// for the audit row.
const handlers = () =>
  createCostHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, upsertDoc, queryDocs },
  });

httpRoute('cmsCostSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/cost/summary',
  handler: (request, context) => handlers().summary(request, context),
});

httpRouteByMethod('cmsCostServices', {
  authLevel: 'anonymous',
  route: 'cms/cost/services',
  handlers: {
    GET: (request, context) => handlers().listServices(request, context),
    POST: (request, context) => handlers().createService(request, context),
  },
});

httpRouteByMethod('cmsCostServiceById', {
  authLevel: 'anonymous',
  route: 'cms/cost/services/{itemId}',
  handlers: {
    PATCH: (request, context) => handlers().updateService(request, context),
    DELETE: (request, context) => handlers().removeService(request, context),
  },
});

httpRouteByMethod('cmsCostSettings', {
  authLevel: 'anonymous',
  route: 'cms/cost/settings',
  handlers: {
    GET: (request, context) => handlers().getSettings(request, context),
    PUT: (request, context) => handlers().putSettings(request, context),
  },
});
