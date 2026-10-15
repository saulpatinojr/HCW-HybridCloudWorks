/**
 * connection-probe-http.js — `connectionProbe` (#483) and the record of what
 * each service test last said (`cms/integration-status`, ADR 0033 Platform).
 *
 * The Integrations page's beaker for Telegram, Podbean, YouTube, Resend, Qlty,
 * Replicate and Firecrawl, whose credentials are read only on the server.
 * Semantics, the closed probe table and the reason the caller supplies a NAME
 * rather than a path are all in lib/integrations/connection-probe.js.
 *
 * The status record sits here rather than beside the settings routes because
 * it is the probe's outcome persisted: the browser runs a service test (this
 * route or one of the proxies) and PUTs whether it passed, so the page can say
 * when a service last worked after a reload. lib/integrations/integration-status.js.
 *
 * RPC-style route name for the probe, matching what the admin UI posts to.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { readDoc, upsertDoc, replaceDocIfMatch } from '../lib/cosmos-client.js';
import { readKey } from '../lib/ai/router.js';
import { createConnectionProbe } from '../lib/integrations/connection-probe.js';
import { createIntegrationStatusHandlers } from '../lib/integrations/integration-status.js';
import { recordKeyVerdict } from '../lib/key-verdict.js';

// `recordKeyVerdict` is the process-wide writer the AI router, the Publer
// timer and the REST proxies use, so the API-keys page hears about a rejected
// credential from whichever path sees it first (#358). Built per invocation
// for the same reason the proxies are: the guard is resolved lazily so this
// module stays importable without one.
const probe = () =>
  createConnectionProbe({
    guard: getDefaultGuard(),
    readKey,
    onKeyVerdict: recordKeyVerdict,
  });

const status = () =>
  createIntegrationStatusHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, upsertDoc, replaceDocIfMatch },
  });

httpRoute('connectionProbe', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connectionProbe',
  handler: (request, context) => probe()(request, context),
});

httpRouteByMethod('cmsIntegrationStatus', {
  authLevel: 'anonymous',
  route: 'cms/integration-status',
  handlers: {
    GET: (request, context) => status().getIntegrationStatus(request, context),
    PUT: (request, context) => status().putIntegrationStatus(request, context),
  },
});
