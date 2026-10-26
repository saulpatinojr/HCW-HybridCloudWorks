import { httpRoute, readConfigStamp } from "../lib/auth/http-route.js";
import { unresolvedSecretCount } from "../lib/secrets-health.js";

// Import all triggers so they are registered with the Azure Functions framework
import "./admin-crud-http.js";
import "./ambassador-audience.js";
import "./ambassador-http.js";
import "./calendar-http.js";
import "./admin-identity-http.js";
import "./admin-integrations-http.js";
import "./admin-secrets-http.js";
import "./credentials-http.js";
import "./ai-proxy-http.js";
import "./ai-model-catalog-http.js";
import "./mcp-http.js";
import "./integrations-http.js";
import "./connection-probe-http.js";
import "./admin-uploads-http.js";
import "./admin-snapshots-http.js";
import "./cms-http.js";
import "./code-quality-http.js";
import "./drafts-http.js";
import "./content-workflow-http.js";
import "./generate-article-draft-http.js";
import "./forge-config-http.js";
import "./gallery-images-http.js";
import "./health-http.js";
import "./image-prompts-http.js";
import "./inspect-jobs.js";
import "./forge-jobs.js";
import "./jobs-sweeper.js";
import "./change-feed.js";
import "./cloud-tools-http.js";
import "./cloud-tools-jobs.js";
import "./cosmos-export.js";
import "./jobs-http.js";
import "./jobs-worker.js";
import "./lab-agent-http.js";
import "./listen-and-learn-http.js";
import "./listen-and-learn-jobs.js";
import "./labs-http.js";
import "./labs-jobs.js";
import "./labs-public-http.js";
import "./addons-public-http.js";
import "./legacy-blogs-telemetry-http.js";
import "./manual-images-http.js";
import "./newsletter-http.js";
import "./newsletter-admin-http.js";
import "./newsletter-insights-http.js";
import "./ops-health-http.js";
import "./platform-health-http.js";
import "./platform-settings-http.js";
import "./podcast-http.js";
import "./podcast-jobs.js";
import "./podcast-recordings-http.js";
import "./public-media.js";
import "./public-preview.js";
import "./public-content-manifest.js";
import "./public-reads.js";
import "./publish-http.js";
import "./publish-jobs.js";
import "./brain-http.js";
import "./recording-content-http.js";
import "./reviewer-digest-http.js";
import "./rss-jobs.js";
import "./public-submissions.js";
import "./schedulers.js";
import "./social-caption-http.js";
import "./streamyard-http.js";
import "./telegram-http.js";
import "./doc-vault-http.js";

const BUILD_TIME = new Date().toISOString();

/**
 * Liveness probe. Anonymous, and therefore says as little as possible.
 *
 * It used to return `node: process.version`, the site name, and whether the
 * schedulers flag was on — an unauthenticated inventory of the runtime version
 * and deployment name, which is the first thing anyone enumerating a host
 * looks for and is of no use to a probe (T-402). A liveness check
 * needs one bit: is the host answering.
 *
 * `startedAt` stays. It is the one field with an operational use — telling a
 * cold start from a warm instance while diagnosing — and it discloses nothing
 * about the software.
 */
httpRoute("healthCheck", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health", // resolves to GET /api/health
  handler: async (request, context) => {
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        service: "hcw-functions",
        startedAt: BUILD_TIME,
        // T-513's second observation channel. Application Insights went blind
        // for six hours on 2026-08-22 (T-514) while this endpoint kept
        // answering, so the configuration generation a worker is running must
        // be readable without it.
        //
        // This is a deliberate, narrow exception to T-402, which stripped
        // `node`, the site name and a feature flag from this response. Those
        // disclosed the runtime version and deployment topology to anyone
        // enumerating the host. These two disclose neither: `generation` is a
        // CI run id and a commit SHA from a public repository, and `writer` is
        // one of `azurerm`, `azapi-strip`, `cli` or `unset`. Neither is a
        // secret, a version, or a name — and both are useless to an attacker
        // and load-bearing for an operator.
        ...readConfigStamp(),
        // How many app settings arrived as the literal
        // `@Microsoft.KeyVault(…)` string instead of a resolved secret
        // (T-720). Unseeded, RBAC revoked, vault firewall denying, or rotated
        // and broken all present identically — as a feature quietly turning
        // itself off, in production, with no exception in Application Insights
        // because the code path taken is a clean fallback.
        //
        // A COUNT, not the names: this endpoint is anonymous, and T-402
        // stripped the runtime version, site name and a feature flag from it
        // because an unauthenticated inventory is what host enumeration looks
        // for. Which integrations exist and which are unconfigured is exactly
        // such an inventory. The number is 0 in a healthy estate, so any other
        // number is actionable without it. Names come from the authenticated
        // ops-health surface.
        unresolvedSecrets: unresolvedSecretCount(process.env),
      }),
    };
  },
});
