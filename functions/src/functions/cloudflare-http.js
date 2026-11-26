/**
 * cloudflare-http.js — the Cloudflare page's routes (#1905). Registration
 * only; what each route does, its role and what it refuses are in
 * lib/cloudflare/handlers.js. There is no DELETE on any of them.
 *
 * Each template is registered once, with its methods fanned out by
 * httpRouteByMethod, because the host keys routes on the template alone.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createDoc, patchDoc, readDoc, upsertDoc } from '../lib/cosmos-client.js';
import { createNotifier } from '../lib/notify.js';
import { createCloudflareHandlers } from '../lib/cloudflare/handlers.js';

// upsertDoc for the audit row; the notifier's store for its cooldown and log.
const handlers = (context) =>
  createCloudflareHandlers({
    guard: getDefaultGuard(),
    store: { upsertDoc },
    notifier: createNotifier({ store: { readDoc, upsertDoc, patchDoc, createDoc }, log: context }),
  });

httpRoute('cmsCloudflareStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/status',
  handler: (request, context) => handlers(context).getStatus(request, context),
});

httpRoute('cmsCloudflareSettings', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/settings',
  handler: (request, context) => handlers(context).getSettings(request, context),
});

httpRoute('cmsCloudflareSetting', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/settings/{settingId}',
  handler: (request, context) => handlers(context).patchSetting(request, context),
});

httpRoute('cmsCloudflarePurge', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/purge',
  handler: (request, context) => handlers(context).purge(request, context),
});

httpRouteByMethod('cmsCloudflareDns', {
  authLevel: 'anonymous',
  route: 'cms/cloudflare/dns',
  handlers: {
    GET: (request, context) => handlers(context).listDns(request, context),
    POST: (request, context) => handlers(context).createDns(request, context),
  },
});

httpRoute('cmsCloudflareDnsRecord', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/dns/{recordId}',
  handler: (request, context) => handlers(context).patchDns(request, context),
});

httpRoute('cmsCloudflareRulesets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/cloudflare/rulesets',
  handler: (request, context) => handlers(context).listRulesets(request, context),
});

httpRouteByMethod('cmsCloudflarePhase', {
  authLevel: 'anonymous',
  route: 'cms/cloudflare/rulesets/phases/{phase}',
  handlers: {
    GET: (request, context) => handlers(context).getPhase(request, context),
    PUT: (request, context) => handlers(context).putPhase(request, context),
  },
});
