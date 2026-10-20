/**
 * The Cloudflare Web Analytics beacon, built into index.html at build time
 * (#1302).
 *
 * WHY A BUILD STEP AND NOT A LINE IN index.html. The site must be able to
 * state a monthly audience figure (owner decision 2026-10-20: the Docker
 * Captain application goes in on the Thought Leader track, 5,000 monthly
 * views, and the Microsoft MVP form asks for impact metrics). The beacon is
 * how page loads are counted, and its token is the one value in it that is
 * per-site: `cloudflare_web_analytics_site` in infra/ produces it, the owner
 * copies it into the `CF_WEB_ANALYTICS_TOKEN` repository variable, and
 * deploy-azure-frontend.yml hands it to the build as
 * `VITE_CF_WEB_ANALYTICS_TOKEN`. A build that has no token — every plain CI
 * build, every local build — emits NO TAG AT ALL: not an empty attribute,
 * not a comment, nothing a diff of dist/index.html would show. The beacon is
 * either whole or absent.
 *
 * THE TOKEN IS PUBLIC BY NATURE. It ships in every page the beacon is loaded
 * from, so anyone with a browser reads it, and it grants nothing: the
 * Cloudflare API authenticates with an API token, which this is not. That is
 * why it is a repository variable rather than a secret, like the Turnstile
 * site key beside it in the workflow.
 *
 * WHY THE SHAPE IS CHECKED ANYWAY. The value is interpolated into HTML, and
 * a value that is not a token — a pasted URL, a value with a quote in it, a
 * workflow expression that expanded to the wrong thing — would either break
 * the page or be served as markup. Cloudflare site tokens are 32 hex
 * characters; `TOKEN_PATTERN` admits a little more than that so a format
 * change on Cloudflare's side does not fail a deploy, and REFUSES anything
 * that could not be a token, loudly, at build time. The token is then
 * JSON-encoded inside the attribute, so the attribute is well-formed by
 * construction and not by the pattern alone.
 *
 * LITE MODE. The site resource is created with `lite = true` (infra/
 * frontend.tf), which Cloudflare documents as keeping visitors from the EU
 * out of the beacon ("the JavaScript snippet will not be injected for
 * visitors from the EU"). The beacon reads its site's settings from
 * Cloudflare when it loads, so a hand-placed snippet is covered by the same
 * setting; documented, not measured here. The figure this exists for is a
 * count, not a profile, and a count that leaves EU visitors out is still a
 * count. No cookies are set and no consent prompt is needed; the privacy
 * policy names Cloudflare as a processor.
 *
 * WHERE THE TAG GOES, AND WHY IT SURVIVES THE PRE-RENDER. The plugin inserts
 * the tag just before `</head>` of the index.html `vite build` writes.
 * scripts/prerender.mjs then reads THAT file as its template: it removes the
 * template's `<title>` and canonical, adds each route's head tags, and keeps
 * everything else — so every pre-rendered page carries the tag, and so does
 * `app-shell.html`, the pristine template copy that serves as the SPA
 * fallback. cf-web-analytics.test.js holds the tag to that contract on both
 * sides. Pure functions, exported, so the test needs no Vite build.
 */

/** A Cloudflare site token is 32 hex characters today; admit a little more than that, and nothing else. */
export const TOKEN_PATTERN = /^[A-Za-z0-9]{16,64}$/;

/** Cloudflare's beacon, from https://developers.cloudflare.com/web-analytics/ ("Add the JavaScript snippet"). */
export const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/**
 * The beacon tag for a token, or '' for no token.
 *
 * @param {string|undefined|null} token  `VITE_CF_WEB_ANALYTICS_TOKEN`, trimmed here.
 * @returns {string} the `<script defer …>` tag, or '' when the token is empty
 * @throws {Error} when the token is non-empty and not token-shaped: a deploy
 *   build must fail here rather than serve the value as markup.
 */
export function beaconTag(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return '';
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error(
      'VITE_CF_WEB_ANALYTICS_TOKEN is not a Cloudflare Web Analytics site token: expected 16 to 64 ' +
        'letters and digits (the dashboard shows 32 hex characters). Copy the site token from ' +
        'the Terraform output or the Cloudflare dashboard, not the snippet or a URL.'
    );
  }
  // JSON.stringify gives the attribute its own quoting; TOKEN_PATTERN has
  // already ruled out a quote, an apostrophe or a bracket inside it.
  const beacon = JSON.stringify({ token: value });
  return `<script defer src="${BEACON_SRC}" data-cf-beacon='${beacon}'></script>`;
}

/**
 * `html` with the beacon tag before `</head>`, or `html` unchanged when the
 * tag is ''. Exported for the test; the plugin below is what Vite calls.
 */
export function injectBeacon(html, token) {
  const tag = beaconTag(token);
  if (!tag) return html;
  if (!/<\/head>/i.test(html))
    throw new Error('index.html has no </head> to put the beacon before');
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

/**
 * The Vite plugin: `transformIndexHtml` runs on the entry HTML in dev and in
 * build alike, so a token in a developer's .env shows the beacon locally
 * too, which is how the tag can be checked in a browser before a deploy.
 *
 * The decision is logged, the token is not: it is public, but a build log is
 * for reading what the build did, and "beacon: on" says that.
 */
export function cfWebAnalyticsPlugin(token, { log = console.log } = {}) {
  // Refused at config time, not at the first HTML transform: a bad value
  // fails `vite build` before any output exists, with the message above.
  const tag = beaconTag(token);
  log(`Cloudflare Web Analytics beacon: ${tag ? 'on' : 'off (no VITE_CF_WEB_ANALYTICS_TOKEN)'}`);
  return {
    name: 'hcw-cf-web-analytics',
    transformIndexHtml(html) {
      return injectBeacon(html, token);
    },
  };
}
