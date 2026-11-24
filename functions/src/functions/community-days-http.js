/**
 * community-days-http.js — the routes behind the Speaking hub's "Events to
 * apply to" tab (#1823, ADR 0045). Registration only; semantics in
 * lib/community-days/handlers.js.
 *
 * Four registrations, because the Functions host keys its route table on the
 * template alone (lib/auth/http-route.js httpRouteByMethod): the list answers
 * GET; a refresh answers POST; one event's saved note answers PUT and DELETE;
 * and one event's estimate answers POST.
 *
 * The estimate is the only route here that reaches a model, through the
 * site's existing router and under ESTIMATE_AI_BUDGET_MS
 * (lib/ai/sync-budgets.test.js lists it).
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createDoc, deleteDocIfMatch, queryDocs, readDoc, replaceDocIfMatch, upsertDoc } from '../lib/cosmos-client.js';
import * as ai from '../lib/ai/router.js';
import { createCommunityDaysHandlers } from '../lib/community-days/handlers.js';

// readDoc, createDoc, replaceDocIfMatch and deleteDocIfMatch: the cache and
// each event's note are written under the ETag they were read at. queryDocs
// lists the notes and reads the Speaking hub's topics. upsertDoc only for the
// audit row.
const handlers = () =>
  createCommunityDaysHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, deleteDocIfMatch, queryDocs, upsertDoc },
    ai,
  });

httpRoute('cmsCommunityDaysEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/community-days/events',
  handler: (request, context) => handlers().list(request, context),
});

httpRoute('cmsCommunityDaysRefresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/community-days/refresh',
  handler: (request, context) => handlers().refresh(request, context),
});

httpRouteByMethod('cmsCommunityDaysEventById', {
  authLevel: 'anonymous',
  route: 'cms/community-days/events/{eventId}',
  handlers: {
    PUT: (request, context) => handlers().save(request, context),
    DELETE: (request, context) => handlers().remove(request, context),
  },
});

httpRoute('cmsCommunityDaysEstimate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/community-days/events/{eventId}/estimate',
  handler: (request, context) => handlers().estimate(request, context),
});
