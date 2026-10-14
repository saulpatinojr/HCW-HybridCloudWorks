/**
 * integrations-http.js — publerProxy, linkieProxy (#180).
 * Semantics and the security boundary in lib/integrations/rest-proxy.js.
 *
 * RPC-style route names, matching what the admin UI posts to.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { readKey } from '../lib/ai/router.js';
import {
  createRestProxy,
  createIntegration,
  createProxyAuditWriter,
} from '../lib/integrations/rest-proxy.js';
import { upsertDoc } from '../lib/cosmos-client.js';
import { PUBLER_API_BASE_URL, publerSettingForStatus } from '../lib/timers/publer-sync.js';
import { recordKeyVerdict } from '../lib/key-verdict.js';

// `recordKeyVerdict` is the process-wide writer the AI router and the Publer
// timer use, so the API-keys page hears about a rejected key from whichever
// path sees it first (#358).
const proxy = () =>
  createRestProxy({
    guard: getDefaultGuard(),
    readKey,
    onKeyVerdict: recordKeyVerdict,
    // Every non-GET call through either proxy leaves an admin_audit_logs row
    // with its actor, path and outcome (AP-B3, #938).
    audit: createProxyAuditWriter({ upsertDoc }),
  });

// Base URL and auth shape reused from the client that has been calling Publer
// since the port, rather than restated here where the two could drift. The
// verdict opt-in matches the timer's client: a 401/403 here is the same fact
// the timer sees, recorded against the same setting.
const PUBLER = createIntegration({
  name: 'Publer',
  baseUrl: PUBLER_API_BASE_URL,
  keyEnv: 'PUBLER_API_KEY',
  extraEnv: ['PUBLER_WORKSPACE_ID'],
  headers: ({ apiKey, env, readKey: read }) => ({
    Authorization: `Bearer-API ${apiKey}`,
    'Publer-Workspace-Id': read(env, 'PUBLER_WORKSPACE_ID'),
  }),
  reportsKeyVerdict: true,
  // 401 is the workspace id, 403 is the key — measured against the live API,
  // and the reverse of Publer's documentation. Shared with the timer's client
  // so the two cannot disagree about which light to turn red (#358).
  verdictSettingForStatus: publerSettingForStatus,
  // The paths and methods the Social Hub sends, enumerated from
  // frontend/src/components/admin/social/publerApi.js, the Platform settings
  // Social tab and the Connections card (AP-B3, #938). Before this the proxy
  // forwarded any verb to any Publer path with the server's key, so an editor
  // session could reach accounts, members and workspace settings the Social
  // Hub never touches, with no trail. The allowlist is checked without the
  // query string: `/posts` covers the list (`?state=…&page=…`) and the delete
  // (`?post_ids[]=…`). `rest-proxy.test.js` sends every request the pages
  // make, so widening this is argued there rather than done quietly.
  allowedPaths: {
    paths: ['/accounts', '/posts', '/posts/schedule', '/posts/schedule/publish'],
    patterns: [/^\/job_status\/[A-Za-z0-9_-]+$/],
  },
  allowedMethods: ['GET', 'POST', 'DELETE'],
});

// Base URL and allowlist taken from Site-Main's working proxy
// (functions/cms/proxies.js), not inferred. The first version of this file
// guessed `https://api.linkie.bio` from the env-var name and was wrong: the API
// is served from the app host under a version prefix. Overridable because
// Site-Main found the published docs Cloudflare-gated from non-browser clients,
// so the endpoint may have to be corrected without a code change.
//
// Linkie is the one integration here with an allowlist. Its admin page calls a
// small known set, and the key's scopes (profiles read+write, analytics read,
// posts read+write) are broader than any single screen needs — so naming the
// endpoints is worth more than trusting the caller.
const LINKIE = createIntegration({
  name: 'Linkie',
  baseUrl: process.env.LINKIE_API_BASE_URL || 'https://app.linkie.bio/api/v1',
  keyEnv: 'LINKIE_API_KEY',
  headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
  allowedPaths: {
    paths: ['/profiles', '/analytics/traffic-stats'],
    // Posts are profile-scoped: Linkie has no top-level /links or /analytics
    // endpoint, which is the detail an inferred base URL would have missed too.
    patterns: [/^\/profiles\/[^/]+\/posts$/, /^\/profiles\/[^/]+\/posts\/[^/]+$/],
  },
});

for (const [name, integration] of [
  ['publerProxy', PUBLER],
  ['linkieProxy', LINKIE],
]) {
  httpRoute(name, {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: name,
    handler: (request, context) => proxy()(integration)(request, context),
  });
}
