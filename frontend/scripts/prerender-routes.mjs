/**
 * Which routes prerender.mjs renders and advertises, what each one is seeded
 * with, and the file each is written to (moved out of prerender.mjs by
 * #1845, which re-exports all of it). Pure apart from staticSectionItems,
 * which imports each provider's architecture-blueprints.js to count it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One render and one sitemap entry per route, whatever the inputs repeat.
 * The manifest carried one slug three times on 2026-09-06 (issue #373): the
 * same file was written three times and the sitemap advertised the URL three
 * times. Order is preserved, so the sitemap stays stable across builds.
 */
export function dedupeRoutes(list) {
  return [...new Set(list)];
}

/**
 * Items a route renders from the repository rather than from the API, keyed by
 * route (issue #373).
 *
 * WHY THIS EXISTS. `manifest.sections` counts what the content API returns, and
 * for six of the seven sections that is the whole page. `architecture-designs`
 * is the exception: each provider's ArchitecturePage merges the API documents
 * with a hardcoded blueprint list, so on 2026-09-07 an API count of zero was
 * true of all five architecture pages and wrong about four of them — only
 * `/vmware/architecture-designs` was actually empty. That is why the section was
 * left uncounted when the other six were wired up, and acting on its zero would
 * have unadvertised four working pages to fix one broken one.
 *
 * WHY IT IS DERIVED. The obvious fix — a list here naming the providers that
 * have static content — is wrong the first time someone adds or removes a
 * blueprint, and nothing would fail to say so. So each page's list moved to a
 * sibling `src/pages/<provider>/architecture-blueprints.js` and this reads them:
 * every directory under `src/pages` is checked for that file, the module is
 * imported, and its `staticBlueprints` array is counted. The count has exactly
 * one source, which is the array the page itself renders.
 *
 * The map is keyed by full route rather than by provider so that
 * `sitemapRoutes` needs no notion of which section has static content — a future
 * section that hardcodes items adds a module and a line to FILE_SECTION here,
 * and nothing downstream changes.
 *
 * A directory with no such module contributes no entry, which reads as zero. An
 * import that fails is not swallowed: this runs at build time, and a data module
 * that cannot be loaded means the page cannot render it either.
 */
const FILE_SECTION = Object.freeze({
  'architecture-blueprints.js': { section: 'architecture-designs', exported: 'staticBlueprints' },
});

export async function staticSectionItems(pagesDir) {
  const items = {};
  if (!existsSync(pagesDir)) return items;
  for (const provider of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const [file, { section, exported }] of Object.entries(FILE_SECTION)) {
      const path = join(pagesDir, provider.name, file);
      if (!existsSync(path)) continue;
      const module = await import(pathToFileURL(path).href);
      const list = module[exported];
      if (!Array.isArray(list)) {
        throw new Error(`${path} does not export an array named ${exported}`);
      }
      items[`/${provider.name}/${section}`] = list.length;
    }
  }
  return items;
}

/**
 * The routes the sitemap advertises: every published route except a section
 * page known to be empty (issue #373).
 *
 * The page is still rendered and still served — a visitor who types the URL
 * gets the honest empty state — it is just not offered to search engines as a
 * page worth indexing. A route `/<provider>/<section>` is dropped only when all
 * three of these hold:
 *
 *   - `manifest.sections[provider][section]` is exactly 0, so the API puts
 *     nothing on the page;
 *   - the manifest counts no unattributed item for that section, because the
 *     blog and frameworks pages infer a provider from titles and URLs as a last
 *     resort and the architecture pages default an unattributed document to
 *     their own provider — so such an item could appear on any provider's page
 *     and a zero is not trusted while one exists;
 *   - `staticItems[route]` is not positive, so the page renders nothing from the
 *     repository either. This is the half `manifest.sections` cannot see, and
 *     without it the four architecture pages that render hardcoded blueprints
 *     would be dropped on an API zero that says nothing about them.
 *
 * A manifest without `sections` (the route predates the field) drops nothing.
 * Returns the kept routes and the dropped ones, so the build log can say what
 * left and why.
 */
export function sitemapRoutes(routes, manifest, staticItems = {}) {
  const sections = manifest?.sections;
  if (!sections || typeof sections !== 'object') return { kept: routes, dropped: [] };
  const unattributed = sections._unattributed || {};
  const kept = [];
  const dropped = [];
  for (const route of routes) {
    const [, provider, section, ...rest] = route.split('/');
    const count = sections[provider]?.[section];
    const empty =
      rest.length === 0 && count === 0 && !(unattributed[section] > 0) && !(staticItems[route] > 0);
    if (empty) {
      dropped.push(route);
    } else {
      kept.push(route);
    }
  }
  return { kept, dropped };
}

/**
 * The query key a route's page reads, as `usePublicData` keys it, or null
 * for a route that needs no seed. `/azure` is the landing page, whose
 * Interviews card reads the interview list (ADR 0040, D6). A design page
 * reads `architecture:<slug>` whatever its provider (#1628); a built-in
 * design with no seed in the manifest gets null back and fetches in the
 * browser, as before.
 */
export function seedKeyFor(route) {
  const article = /\/blog\/([^/]+)$/.exec(route)?.[1];
  if (article) return `article:${article}`;
  const design = /^\/[a-z]+\/architecture-designs\/([^/]+)$/.exec(route)?.[1];
  if (design) return `architecture:${design}`;
  const interview = /^\/azure\/interviews\/([^/]+)$/.exec(route)?.[1];
  if (interview) return `interview:${interview}`;
  if (route === '/azure/interviews' || route === '/azure') return 'interviews:list';
  return null;
}

/**
 * The data a route needs, keyed as `usePublicData` keys it.
 *
 * Only the entry for THIS route is handed over, not the whole manifest: a page
 * that reads a key it was not given should fall through to its normal fetch,
 * and passing everything would hide that.
 */
export function seedFor(manifest, route) {
  if (!manifest?.data) return null;
  const key = seedKeyFor(route);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(manifest.data, key)
    ? { [key]: manifest.data[key] }
    : null;
}

/**
 * The file a route is written to, under `dist`.
 *
 * Refuses a route whose file would land outside `dist` (a `..` segment, for
 * example). Routes from the content manifest come from published content,
 * and the builder already skips an unsafe slug; this is the second layer, so
 * that no route, whatever produced it, can write anywhere but the build.
 */
export function outputPathFor(dist, route) {
  const clean = route.replace(/^\/+|\/+$/g, '');
  const out = clean ? join(dist, clean, 'index.html') : join(dist, 'index.html');
  const inside = relative(resolve(dist), resolve(out));
  // A `..` path segment, not any name that starts with two dots.
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`route ${JSON.stringify(route)} would be written outside the build folder`);
  }
  return out;
}
