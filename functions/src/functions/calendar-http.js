/**
 * calendar-http.js — the Amplify → Calendar aggregate read (ADR 0033 §4).
 * Registration only; semantics in lib/calendar.js.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { queryDocs, readDoc } from '../lib/cosmos-client.js';
import { createCalendarHandlers } from '../lib/calendar.js';

// readDoc: the calendar alerts are one document (lib/calendar-alerts/collector.js).
// No write function is passed: the Calendar read never writes.
const handlers = () =>
  createCalendarHandlers({ guard: getDefaultGuard(), store: { queryDocs, readDoc } });

httpRoute('cmsCalendar', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/calendar',
  handler: (request, context) => handlers().read(request, context),
});
