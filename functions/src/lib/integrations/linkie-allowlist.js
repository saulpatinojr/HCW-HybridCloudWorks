/**
 * The Linkie endpoints `linkieProxy` will call, in the shape rest-proxy.js's
 * `isAllowedPath` matches.
 *
 * Its own module, with no imports, so the Linkie Hub's tests can run every path
 * the frontend builds (frontend/src/lib/linkie.js `linkiePaths`) through the
 * real matcher: the two used to agree only because someone kept them in step by
 * eye, and a rename on Linkie's side (profiles to pages, October 2026) is the
 * kind of change that moves one and not the other.
 *
 * Linkie renamed its profiles to PAGES in October 2026. The old `/profiles`
 * paths are deliberately absent: a caller still using them is refused by the
 * proxy with the allowlist's own message instead of reaching Linkie.
 * Source: https://linkie.bio/docs/api-reference/pages (read 2026-10-23).
 */
export const LINKIE_ALLOWED_PATHS = Object.freeze({
  paths: Object.freeze(['/pages', '/analytics/traffic-stats']),
  // Posts are page-scoped: Linkie has no top-level /links or /analytics
  // endpoint, which is the detail an inferred base URL would have missed too.
  patterns: Object.freeze([/^\/pages\/[^/]+\/posts$/, /^\/pages\/[^/]+\/posts\/[^/]+$/]),
});
