/**
 * Pre-render the built SPA to real HTML, one file per route (T-515).
 *
 * WHAT WAS WRONG. This repository built with `vite build` and shipped a single
 * `index.html` containing an empty `<div id="root">` and the title "Hybrid Cloud
 * Works". Site-Main, the site being migrated from, built with Vike and shipped
 * pre-rendered HTML. Measured on the same path during the §6 parallel run:
 * `/about` was 24,902 bytes on Firebase and 2,808 bytes on Azure, with 2,717
 * characters of visible text against 967, and the correct `<title>` against a
 * generic one. Migration-Plan §7 states a gate of "90 HTML documents
 * pre-rendered"; this build produced three.
 *
 * That matters here more than it usually would. This is a content platform
 * whose purpose is being found, and every article, framework and architecture
 * page served a generic title and an empty shell to anything that does not run
 * JavaScript — most link unfurlers, several crawlers, every social preview card.
 * The pages render correctly in a browser, so clicking through the site reveals
 * nothing at all.
 *
 * HOW. `vite build` still produces the SPA exactly as before; this runs after it
 * and adds static HTML beside it. Each route is rendered through the real
 * application — same components, same providers, same pages that set their
 * own title — and written to `dist/<route>/index.html`. The client bundle is
 * untouched and still hydrates, so this is additive: if a file here were wrong,
 * the SPA underneath it still works.
 *
 * WHY NOT `renderToString`. Every route is a `React.lazy` import behind one
 * `<Suspense>`, and `renderToString` does not wait for those — it emits the
 * loading fallback and returns, producing ~380 characters of identical markup
 * for every URL. `prerenderToNodeStream` (React 19's static API) resolves every
 * boundary first.
 *
 * ARTICLE PAGES COME FROM A FILE, NOT THE API. CI cannot reach the API at build
 * time (issue #175), so the article pages are built from the content manifest
 * (`frontend/data/content-manifest.json`); see `routes()` in prerender-entry.jsx.
 *
 * THIS STEP FAILS THE BUILD. A route that throws, renders its error boundary, or
 * comes back suspiciously small is a broken page — and a broken page written to
 * disk looks exactly like a working one from the outside. Shipping a shell is
 * the failure this whole file exists to prevent, so it is not something to warn
 * about and continue past.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalFor,
  findStreamedBoundary,
  injectIntoTemplate,
  splitHead,
} from './prerender-template.mjs';
import {
  dedupeRoutes,
  outputPathFor,
  seedFor,
  sitemapRoutes,
  staticSectionItems,
} from './prerender-routes.mjs';

// The pure parts live in two sibling files: building one document
// (prerender-template.mjs) and choosing routes, files, seeds and the sitemap
// (prerender-routes.mjs). What this file exported before is re-exported here,
// so the tests keep one import path.
export {
  SITE_ORIGIN,
  canonicalFor,
  socialTags,
  splitHead,
  findStreamedBoundary,
  SEED_ATTRIBUTE,
  seedAttribute,
  injectIntoTemplate,
} from './prerender-template.mjs';
export {
  dedupeRoutes,
  staticSectionItems,
  sitemapRoutes,
  seedKeyFor,
  seedFor,
  outputPathFor,
} from './prerender-routes.mjs';

const ENTRY = 'scripts/prerender-entry.jsx';

/**
 * Resolved on demand, not at module scope.
 *
 * `splitHead` and `injectIntoTemplate` are pure and are imported by
 * prerender.test.js, where `import.meta.url` is a Vite module id rather than a
 * `file:` URL — computing these eagerly made the whole test file fail to import
 * with "The URL must be of scheme file", before a single assertion ran.
 */
function paths() {
  const frontend = fileURLToPath(new URL('..', import.meta.url));
  return { frontend, dist: join(frontend, 'dist'), ssrDist: join(frontend, 'dist-ssr') };
}

/**
 * Below this many characters of visible text, a page is a shell rather than a
 * page. The smallest legitimate route is a Coming Soon page at ~470; the shell
 * this replaces measured 389 on every URL. 420 sits between them.
 */
const MIN_TEXT_CHARS = 420;

/**
 * The shape of a pre-rendered mount point, as a string a shell `grep` can use.
 *
 * WHY THIS IS EXPORTED RATHER THAN WRITTEN OUT IN THE WORKFLOW. It was written
 * out in the workflow, as `<div id="root"><[^/]`, and #296 then added
 * `data-prerendered-route` to the mount point (injectIntoTemplate, in
 * prerender-template.mjs). The literal stopped
 * existing, so the check could never pass — and because its failure BLOCKS a
 * deploy rather than letting one through, it sat unnoticed until someone tried
 * to ship. Every frontend deploy between 2026-08-31 and 2026-09-01 would have
 * failed on a correctly pre-rendered page.
 *
 * A bash literal in a workflow encoding a shape this file defines is a
 * two-place truth with nothing holding the places together. prerender.test.js
 * reads the pattern back out of the workflow and asserts it against real
 * output, so the next change to the mount point fails a test instead of a
 * deploy.
 *
 * The pattern deliberately allows attributes (`[^>]*`) and deliberately
 * requires a child element (`<[^/]`) — an empty mount point is `…></div>`,
 * where `/` follows `<` and the match fails. It relies on escapeAttr escaping
 * `>`; see the note there, in prerender-template.mjs.
 */
export const MOUNT_POINT_PATTERN = '<div id="root"[^>]*><[^/]';

/**
 * Minimal browser globals for libraries that need a document at import time.
 *
 * Installing a window is not free. Before this, `typeof window === 'undefined'`
 * was true and every SSR guard in the tree took its server path. Afterwards the
 * guards pass and the code runs — so a HALF-built DOM is worse than none, and
 * the first narrow version proved it: /azure/education had pre-rendered fine for
 * days and immediately failed with "window.matchMedia is not a function".
 *
 * So the shim fills jsdom's own documented gaps rather than only DOMPurify's
 * needs. `matchMedia` is absent from jsdom entirely, which is why a guard of the
 * form `window.matchMedia && window.matchMedia(...)` behaves differently here
 * than in any real browser.
 */
async function installDom() {
  if (globalThis.window?.document) return;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;
  globalThis.DocumentFragment = dom.window.DocumentFragment;
  globalThis.HTMLTemplateElement = dom.window.HTMLTemplateElement;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.trustedTypes = dom.window.trustedTypes;

  // jsdom does not implement matchMedia. Reduced motion and dark mode both
  // report false, which is the right default for a static file: it is served to
  // everyone, so it must not bake in one visitor's preference.
  if (!dom.window.matchMedia) {
    dom.window.matchMedia = (query) => ({
      matches: false,
      media: String(query),
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
}

function buildSsrBundle(frontend) {
  // Built here rather than as a separate npm script so `npm run build` cannot
  // pre-render a stale tree against fresh client assets.
  //
  // Vite's JS entry is run through this same Node binary rather than the `vite`
  // shim or npx: the shims are `.cmd` files on Windows, which spawnSync cannot
  // execute without `shell: true` — and that both failed to resolve in the shell
  // this first ran in and drags in shell quoting for no benefit.
  const vite = join(frontend, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(
    process.execPath,
    [vite, 'build', '--ssr', ENTRY, '--outDir', 'dist-ssr', '--logLevel', 'warn'],
    { cwd: frontend, stdio: 'inherit' }
  );
  if (result.error) {
    throw new Error(`could not run ${vite}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`SSR bundle build failed with exit code ${result.status}`);
  }
}

/**
 * Renders one route and writes its document. Returns `{ bytes }` for a page
 * written, `{ skipped: true }` for the 404 page, or `{ failure }` with the
 * reason the route must not ship.
 */
async function prerenderRoute(route, { render, manifest, template, dist }) {
  // Computed once and used twice: the same value must reach the server render
  // and the browser, or hydration compares two different trees. Calling
  // seedFor() again at injection time would work today and rot the moment it
  // stops being pure.
  const seed = seedFor(manifest, route);

  let rendered;
  try {
    // Only detail routes carry a seed; everything else renders from nothing,
    // exactly as it did before the manifest existed.
    rendered = await render(route, seed);
  } catch (error) {
    return { failure: `${route}: threw — ${error?.message || error}` };
  }

  const problem = renderProblem(route, rendered);
  if (problem) return problem;

  const html = injectIntoTemplate(template, splitHead(rendered.html), route, seed);
  const outPath = outputPathFor(dist, route);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return { bytes: Buffer.byteLength(html) };
}

/**
 * Why a rendered route must not be written: `{ failure }` or `{ skipped: true }`,
 * or null when it is a page.
 */
function renderProblem(route, rendered) {
  if (rendered.errors.length > 0) {
    // An error boundary produces perfectly valid-looking HTML. Without this
    // check the error state would be written out and published as the page.
    return { failure: `${route}: rendered an error — ${rendered.errors[0].message}` };
  }

  const streamed = findStreamedBoundary(rendered.html);
  if (streamed) {
    // A page in Fizz's streamed form passed every check below on 2026-09-06:
    // the shell had header, footer and a spinner, the page itself sat in a
    // hidden segment, and the text count was well above the shell floor.
    // It is not a page — nothing without JavaScript ever sees the content,
    // and the browser cannot run the swap script under this site's CSP.
    return { failure: `${route}: ${streamed} (see prerender-entry.jsx progressiveChunkSize)` };
  }

  if (rendered.html.includes('data-page="not-found"')) {
    // Not an error. `/:provider/<section>` is declared for every provider,
    // and the dispatcher behind it renders the 404 page for the combinations
    // that have no content — /azure/code and /github/frameworks among them.
    // The route list is a candidate grid, so this is the expected answer for
    // a real part of it.
    //
    // It must still be SKIPPED rather than written: the page says "this page
    // does not exist" and would be served at HTTP 200 for a crawler to index
    // as content. Reported so the count is visible and a sudden jump is not.
    return { skipped: true };
  }

  const text = rendered.html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < MIN_TEXT_CHARS) {
    return { failure: `${route}: only ${text.length} characters of text — a shell, not a page` };
  }
  return null;
}

/**
 * The end-of-run checks: the core routes exist, enough documents were
 * written, the skipped routes are listed, and any failure stops the build.
 */
function finishRun({ written, skipped, failures }) {
  // The three routes that must always exist. Everything else is content that
  // can legitimately come and go; these are the site itself, and if one of them
  // starts rendering the 404 page something is broken badly enough that a
  // deploy should stop.
  const CORE = ['/', '/about', '/contact'];
  for (const route of CORE) {
    if (skipped.includes(route)) {
      failures.push(`${route}: rendered the 404 page — this route must always exist`);
    }
  }

  // A floor, not an exact count: sections appear and disappear with content, but
  // a collapse from ~80 to a handful means the render broke rather than that
  // someone unpublished a page.
  const MINIMUM_DOCUMENTS = 60;
  if (written < MINIMUM_DOCUMENTS && failures.length === 0) {
    failures.push(
      `only ${written} documents written, expected at least ${MINIMUM_DOCUMENTS} — ` +
        `${skipped.length} routes rendered the 404 page`
    );
  }

  if (skipped.length > 0) {
    const list = skipped.map((route) => `  ${route}`).join('\n');
    console.log(
      `[prerender] ${skipped.length} route(s) have no content for that provider ` +
        `and were skipped:\n${list}`
    );
  }

  if (failures.length > 0) {
    console.error(`\n[prerender] ${failures.length} route(s) failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      '\nA pre-rendered shell is indistinguishable from a working page once it is\n' +
        'deployed, which is the failure this step exists to prevent. Fix the route\n' +
        'or remove it from routes() in scripts/prerender-entry.jsx.'
    );
    process.exit(1);
  }
}

/** sitemap.xml from the routes kept for it. */
function writeSitemap(dist, routes) {
  const urls = routes
    .map((route) => ['  <url>', `    <loc>${canonicalFor(route)}</loc>`, '  </url>'].join('\n'))
    .join('\n');
  writeFileSync(
    join(dist, 'sitemap.xml'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      urls,
      '</urlset>',
      '',
    ].join('\n')
  );
}

/** The content manifest, or null when this build has none. */
function readManifest(frontend) {
  // Build input, not site content — see build-content-manifest.mjs. Absent is
  // fine and simply means no detail routes this build.
  const manifestPath = join(frontend, 'data', 'content-manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('[prerender] no content manifest — article detail pages will not be pre-rendered');
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(
    `[prerender] manifest: ${manifest.routes?.length || 0} article routes, generated ${manifest.generatedAt || 'unknown'}`
  );
  return manifest;
}

async function main() {
  const { frontend, dist, ssrDist } = paths();
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('dist/index.html is missing — run `vite build` before this step');
  }

  buildSsrBundle(frontend);

  // A DOM has to exist BEFORE the bundle is imported.
  //
  // Article pages sanitise their body with DOMPurify and feed the result to
  // `dangerouslySetInnerHTML`. DOMPurify binds to a window at import time and
  // exposes no `sanitize` without one, so under plain Node every detail route
  // died with "I.sanitize is not a function" — which the pre-render step
  // correctly refused to write, rather than shipping the error page.
  //
  // Skipping sanitisation here was never an option: the output is a static file
  // served to every visitor, so unsanitised markup would be baked in permanently
  // rather than merely rendered once.
  //
  // jsdom is already a devDependency — vitest uses it as the test environment —
  // so this adds no package, and nothing here reaches the browser bundle.
  await installDom();

  const entryUrl = pathToFileURL(join(ssrDist, 'prerender-entry.js')).href;
  const { render, routes } = await import(entryUrl);

  const manifest = readManifest(frontend);

  const template = readFileSync(join(dist, 'index.html'), 'utf8');

  // The app needs a shell of its own, and this is not optional.
  //
  // `staticwebapp.config.json` sends two kinds of request to one bare copy of
  // the app: the private areas (/admin, /preview, ...), which are never
  // pre-rendered, with 200 and noindex; and any address that has no file of
  // its own, with 404 (its `responseOverrides`). The app then renders the
  // page in the browser, the not-found page included. There is no catch-all
  // any more: until #1613 every unknown address got this shell with 200,
  // which Google reports as a "Soft 404".
  //
  // That shell cannot be dist/index.html. Pre-rendering turns dist/index.html
  // into the fully rendered HOME PAGE, so pointing the rules at it would serve
  // the home page's title and body for every unknown address. Measured on the
  // preview host before app-shell.html existed: /definitely-not-real returned
  // 200 with the home page's title and body.
  //
  // So the untouched template is kept as its own file and the rules point at
  // it. Known routes get their pre-rendered document; everything else gets a
  // shell that starts the app.
  writeFileSync(join(dist, 'app-shell.html'), template);

  const targets = dedupeRoutes(routes(manifest));
  const failures = [];
  const skipped = [];
  const publishedRoutes = [];
  let written = 0;
  let bytes = 0;

  for (const route of targets) {
    const outcome = await prerenderRoute(route, { render, manifest, template, dist });
    if (outcome.failure) failures.push(outcome.failure);
    else if (outcome.skipped) skipped.push(route);
    else {
      written += 1;
      bytes += outcome.bytes;
      publishedRoutes.push(route);
    }
  }

  // The sitemap is GENERATED from the routes that were actually written, not
  // hand-maintained. public/sitemap.xml held 51 URLs in the non-trailing form
  // while the live site redirected every one of them to the trailing form — the
  // two had disagreed the whole time, and a static list drifts from the
  // pre-render set the moment either changes. Generating it from
  // `publishedRoutes` means sitemap, canonical and the files on disk cannot
  // disagree: they have one source.
  //
  // Skipped routes are excluded by construction. Advertising a URL that renders
  // the 404 page is worse than omitting it. Section pages known to be empty are
  // rendered but not advertised — see sitemapRoutes. "Empty" needs both the
  // manifest's API counts and the blueprint lists the pages hold themselves,
  // which is what staticSectionItems reads.
  const staticItems = await staticSectionItems(join(frontend, 'src', 'pages'));
  const sitemap = sitemapRoutes(publishedRoutes, manifest, staticItems);
  for (const route of sitemap.dropped) {
    console.log(`[prerender] sitemap: omitted ${route} — no published items for this section`);
  }
  writeSitemap(dist, sitemap.kept);

  // The SSR bundle is a build artefact, not site content. Left in place it would
  // be uploaded with the site — and `dist-ssr` contains a copy of every page's
  // source-mapped server build.
  rmSync(ssrDist, { recursive: true, force: true });

  finishRun({ written, skipped, failures });

  const average = Math.round(bytes / Math.max(written, 1) / 1024);
  console.log(`[prerender] ${written} HTML documents written, ${average} kB average`);
}

// Only when run as a script. `splitHead` and `injectIntoTemplate` are imported
// by prerender.test.js, and an unguarded main() would kick off a full SSR build
// the moment the test file loaded.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[prerender] FAILED: ${error?.message || error}`);
    process.exit(1);
  });
}
