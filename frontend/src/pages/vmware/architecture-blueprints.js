/**
 * The VMware reference architectures this page renders whatever the content API
 * returns — none, today, and that is the point of the file existing.
 *
 * WHY AN EMPTY ARRAY IS A FILE. The other four providers declared a
 * `staticBlueprints` list inside their ArchitecturePage.jsx; VMware never had
 * one, so `/vmware/architecture-designs` renders whatever the API gives it and
 * the live corpus holds no VMware architecture document. The page was empty and
 * the sitemap advertised it anyway (issue #373), because the pre-render had no
 * way to tell a provider with hardcoded blueprints from one without: an API
 * count of zero was true of all five pages and wrong about four of them.
 *
 * A hardcoded list of "providers that have static content" in the build script
 * would answer that question and go stale the day someone adds or removes a
 * blueprint. Exporting the answer as data does not. `sitemapRoutes` in
 * frontend/scripts/prerender-routes.mjs imports every `architecture-blueprints.js`
 * under src/pages and counts what it exports; this one is empty, so
 * `/vmware/architecture-designs` is dropped from `sitemap.xml` for exactly as
 * long as it stays empty. Add a blueprint here and the URL comes back with no
 * other edit.
 *
 * The page still renders and is still served — a visitor who types the URL gets
 * the site's honest empty state. This changes what is advertised, not what
 * exists.
 *
 * Plain data, no JSX and no `@/` imports, because that build script imports this
 * file directly in Node with no bundler and no alias resolution.
 */
export const staticBlueprints = [];
