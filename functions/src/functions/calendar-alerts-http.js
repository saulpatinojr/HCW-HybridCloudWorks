/**
 * calendar-alerts-http.js — the admin portal's Calendar Alerts routes.
 * Registration only; semantics in lib/calendar-alerts/handlers.js.
 *
 * Two registrations, because the Functions host keys its route table on the
 * template alone (lib/auth/http-route.js httpRouteByMethod): the collection
 * answers GET and POST, and the one-alert template answers PATCH and DELETE.
 * `cms/calendar-alerts` is a different template from `cms/calendar` (the
 * Amplify calendar read), so the two never meet.
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createDoc, readDoc, replaceDocIfMatch, upsertDoc } from '../lib/cosmos-client.js';
import { createCalendarAlertHandlers } from '../lib/calendar-alerts/handlers.js';

// readDoc, createDoc and replaceDocIfMatch: the alerts are one document,
// written under the ETag it was read at. upsertDoc only for the audit row.
// There is no query: nothing here lists documents, so nothing can list another.
const handlers = () =>
  createCalendarAlertHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, replaceDocIfMatch, upsertDoc },
  });

httpRouteByMethod('cmsCalendarAlerts', {
  authLevel: 'anonymous',
  route: 'cms/calendar-alerts',
  handlers: {
    GET: (request, context) => handlers().list(request, context),
    POST: (request, context) => handlers().create(request, context),
  },
});

httpRouteByMethod('cmsCalendarAlertById', {
  authLevel: 'anonymous',
  route: 'cms/calendar-alerts/{alertId}',
  handlers: {
    PATCH: (request, context) => handlers().update(request, context),
    DELETE: (request, context) => handlers().remove(request, context),
  },
});
