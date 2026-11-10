/**
 * alerts-http.js — the alert log's routes (owner request 2026-11-10).
 * Registration only; semantics in lib/alerts/handlers.js.
 *
 *   GET  cms/alerts/recent   the last alerts sent to Telegram (editor; Koda may read)
 *   POST cms/alerts/resend   send one again by its log id (editor; not Koda)
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createDoc, patchDoc, readDoc, upsertDoc } from '../lib/cosmos-client.js';
import { createNotifier } from '../lib/notify.js';
import { createAlertLogHandlers } from '../lib/alerts/handlers.js';

// Built per invocation: the guard is resolved lazily so this module stays
// importable without one (the route inventory imports every module).
const handlers = (context) =>
  createAlertLogHandlers({
    guard: getDefaultGuard(),
    store: { readDoc },
    notifier: createNotifier({
      store: { readDoc, upsertDoc, patchDoc, createDoc },
      log: context,
    }),
  });

httpRoute('cmsAlertsRecent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/alerts/recent',
  handler: (request, context) => handlers(context).getRecent(request, context),
});

httpRoute('cmsAlertsResend', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/alerts/resend',
  handler: (request, context) => handlers(context).resend(request, context),
});
