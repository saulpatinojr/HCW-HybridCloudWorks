/**
 * CORS for the Cloud Tools / admin API.
 *
 * ===========================================================================
 * DECISION 7 — CORS lives in code, and the platform `cors` block is removed
 * ===========================================================================
 * Two allowlists is the actual hazard: they drift, and when a request fails you
 * cannot tell which one rejected it. Picking in-code, for three reasons:
 *
 *   1. The platform setting can only allowlist-or-omit. Site-Main's applyCors
 *      (`cloud-tools.js:355-376`) returns 403 on a disallowed origin, turning
 *      an invisible browser-side failure into a server-side signal you can
 *      alert on. Preserve that.
 *   2. The platform list is exact-match and cannot express a localhost port
 *      pattern. The Terraform hardcodes 5173 and 4173 — NARROWER than current
 *      behaviour, so a developer on any other port silently breaks.
 *   3. In-code is testable in the same suite as the authorization rules.
 *
 * `support_credentials = true` must also go from the Terraform: it makes the
 * platform intercept OPTIONS preflights itself, so an in-code preflight would
 * never run. It is wrong on its own merits too — this is a bearer-token API,
 * not a cookie API.
 *
 * LOCALHOST DOES NOT SURVIVE TO PRODUCTION. Site-Main includes it
 * unconditionally (`cloud-tools.js:51-53`) and that is a defect not to port:
 * `http://localhost:5173` in a production allowlist means any page running on
 * a victim's machine — a malicious local dev server, a compromised
 * `npm postinstall`, a rogue Electron app — can make cross-origin calls to
 * production carrying the victim's token. Gated on NODE_ENV here; the
 * production Function App already sets NODE_ENV=production, and a local
 * Functions host does not, so nothing is lost.
 *
 * CORS IS NOT AN AUTHORIZATION CONTROL. It stops browsers, not curl. Every
 * role check and rate limit must hold with no Origin header at all — which is
 * why a missing Origin is allowed through here rather than rejected. Do not
 * "harden" that into requiring the header: it would break non-browser clients
 * and buy nothing.
 */

/**
 * Production origins: the site itself, on the apex and on www, both of which
 * serve it (www answers 200 rather than redirecting, checked 2026-09-28).
 *
 * Exported because the public lab submission is locked to exactly these two
 * (lib/labs/public-lock.js, ADR 0032 decision 6 as revised 2026-09-28): the
 * preview hostname below is a break-glass path, not the site's pane, and is
 * deliberately not one of them.
 *
 * Written as a plain array literal and frozen on the next line because
 * cors-platform-origins.test.js text-reads this file for
 * `const PRODUCTION_ORIGINS = [`.
 */
export const PRODUCTION_ORIGINS = ['https://hybridcloudworks.com', 'https://www.hybridcloudworks.com'];
Object.freeze(PRODUCTION_ORIGINS);

/**
 * The Static Web App's own hostname — RETAINED DELIBERATELY, not a leftover.
 *
 * This said "TEMPORARY, for Migration-Plan §6 step 2. REMOVE IT when DNS moves
 * (§6 step 5)". DNS moved; hybridcloudworks.com has been live for weeks and the
 * origin is still here — so the comment was describing an intention the code had
 * stopped following, which is worse than either answer. Corrected by #521.
 *
 * It stays because `deploy-azure-frontend.yml` documents the production
 * break-glass as re-pointing or disabling the custom domain, and exercising that
 * escape hatch lands on exactly this hostname. Removing the origin would take
 * the admin portal out of the only documented unserviceable-estate recovery
 * path — and it would be discovered during the incident.
 *
 * It is also not the shape Zero Trust guidance warns about: not a wildcard, and
 * not a dangling domain. The host is bound to a live Static Web App we own, and
 * SWA default hostnames carry a random discriminator so they are not
 * reallocated.
 *
 * REVISIT TRIGGER, a real one this time: remove it when the Static Web App is
 * deleted, or when the break-glass procedure stops depending on the default
 * hostname.
 *
 * It is compiled in rather than supplied through `EXTRA_ALLOWED_ORIGINS`, which
 * is what §6 step 2 was originally going to use. On 2026-08-22 that setting was
 * applied correctly — verified in ARM byte-for-byte, 51 characters, single key
 * — and the running app still refused the origin, through a restart, a
 * stop/start, three deploys and about twenty probes. `parseExtraOrigins()` and
 * `createCors()` return `true` for that exact value locally, so the code is not
 * the problem, and `TELEGRAM_BOT_TOKEN` reaching the same worker proves app
 * settings do arrive. That was T-513, and it has since been explained: on
 * that date the setting was named `CORS_ALLOWED_ORIGINS`, which collides with a
 * variable App Service injects, so the worker only ever saw `[]`. CHANGELOG.md
 * records the proof, and `parseExtraOrigins` in http-route.js explains the
 * rename to `EXTRA_ALLOWED_ORIGINS`.
 *
 * Two reasons this is the better home even with the setting fixed:
 *
 *   1. An allowlist is a security control. In code it is reviewed, diffed and
 *      covered by the tests below. As an app setting it can be changed by
 *      anyone with Contributor, silently, with no test and no reviewer.
 *   2. Deploys are the one propagation path that is demonstrably reliable here
 *      — the function count moved 84 → 96 → 97 across three of them, while the
 *      same app ignored a setting written four different ways.
 */
const PREVIEW_ORIGINS = ['https://calm-ground-0d0e6a010.7.azurestaticapps.net'];

/**
 * Methods advertised in a preflight response.
 *
 * This was `GET, POST, OPTIONS`, written before the migration added the REST
 * surface. Fourteen registered routes use PUT, PATCH or DELETE; a browser that
 * preflights one of those reads this header, does not find its method, and
 * refuses to send the request — the call never reaches the guard, so nothing
 * server-side ever logs it (T-102).
 */
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/** Dev-only origins, any port. Never active when NODE_ENV=production. */
const LOCALHOST_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

/**
 * @param {{ environment?: string, extraOrigins?: string[], allowPreview?: boolean }} [options]
 */
export function createCors({
  environment = process.env.NODE_ENV,
  extraOrigins = [],
  allowPreview = environment !== 'production' ||
    process.env.ALLOW_SWA_PREVIEW === 'true' ||
    process.env.ALLOW_SWA_PREVIEW === '1',
} = {}) {
  const isProduction = environment === 'production';
  const previewOrigins = allowPreview ? PREVIEW_ORIGINS : [];
  const allowlist = new Set([...PRODUCTION_ORIGINS, ...previewOrigins, ...extraOrigins]);

  const isAllowed = (origin) => {
    if (allowlist.has(origin)) return true;
    if (!isProduction && LOCALHOST_PATTERN.test(origin)) return true;
    return false;
  };

  return {
    isAllowed,

    /**
     * Evaluate CORS for a request.
     *
     * @returns {{ allowed: boolean, headers: object, preflight: boolean, response?: object }}
     *   `response` is set when the caller should return immediately — either a
     *   403 for a disallowed origin, or a 204 for a preflight.
     */
    evaluate(request) {
      const origin = request?.headers?.get?.('origin');
      const method = String(request?.method || 'GET').toUpperCase();

      // No Origin: a non-browser client. Allowed — authorization is what
      // protects the endpoint, not CORS.
      if (!origin) return { allowed: true, headers: {}, preflight: false };

      if (!isAllowed(origin)) {
        return {
          allowed: false,
          headers: {},
          preflight: false,
          response: {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Origin not allowed' }),
          },
        };
      }

      const headers = {
        'Access-Control-Allow-Origin': origin,
        // Origin is now part of the cache key — without this a shared cache can
        // serve one origin's allow header to another.
        Vary: 'Origin',
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        // WITHOUT THIS THE 401 REASON IS INVISIBLE (#517).
        //
        // The admin SPA is served from hybridcloudworks.com and this API from
        // api-azure.hybridcloudworks.com, so every call is cross-origin — and a
        // browser exposes only the handful of CORS-safelisted response headers
        // to script unless the server names the rest here. `WWW-Authenticate`
        // is not safelisted, so `res.headers.get('www-authenticate')` returned
        // null in the browser however carefully the API set it.
        //
        // It belongs on the ACTUAL response, not just the preflight: the
        // preflight governs what the request may send, this governs what the
        // response may reveal.
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
        'Access-Control-Max-Age': '3600',
      };

      if (method === 'OPTIONS') {
        return { allowed: true, headers, preflight: true, response: { status: 204, headers } };
      }

      return { allowed: true, headers, preflight: false };
    },
  };
}
