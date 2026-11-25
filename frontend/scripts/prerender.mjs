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

import { canonicalFor, injectIntoTemplate, judgeRender, splitHead } from './prerender-html.mjs';
import {
  dedupeRoutes,
  outputPathFor,
  seedFor,
  sitemapRoutes,
  staticSectionItems,
} from './prerender-routes.mjs';

// What goes into a document is in prerender-html.mjs and which routes are
// built and advertised is in prerender-routes.mjs (#1845). Both are
// re-exported, so prerender.test.js and the other importers keep one path.
export * from './prerender-html.mjs';
export * from './prerender-routes.mjs';

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
 * The shape of a pre-rendered mount point, as a string a shell `grep` can use.
 *
 * WHY THIS IS EXPORTED RATHER THAN WRITTEN OUT IN THE WORKFLOW. It was written
 * out in the workflow, as `<div id="root"><[^/]`, and #296 then added
 * `data-prerendered-route` to the mount point below. The literal stopped
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
 * where `/` follows `<` and the match fails. It relies on escapeAttr (in
 * prerender-html.mjs) escaping `>`; see the note there.
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
 * The content manifest, or null when there is none.
 *
 * Build input, not site content — see build-content-manifest.mjs. Absent is
 * fine and simply means no detail routes this build.
 */
function readManifest(frontend) {
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

/**
 * Render every route and write the ones that pass judgeRender. Returns the
 * failures, the routes skipped as the 404 page, the routes written (in
 * order, for the sitemap), and the count and size of what was written.
 */
async function renderRoutes({ render, targets, manifest, template, dist }) {
  const result = { failures: [], skipped: [], publishedRoutes: [], written: 0, bytes: 0 };

  for (const route of targets) {
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
      result.failures.push(`${route}: threw — ${error?.message || error}`);
      continue;
    }

    const verdict = judgeRender(route, rendered);
    if (verdict.failure) {
      result.failures.push(verdict.failure);
      continue;
    }
    if (verdict.skip) {
      result.skipped.push(route);
      continue;
    }

    const html = injectIntoTemplate(template, splitHead(rendered.html), route, seed);
    const outPath = outputPathFor(dist, route);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    result.written += 1;
    result.bytes += Buffer.byteLength(html);
    result.publishedRoutes.push(route);
  }
  return result;
}

/**
 * The sitemap is GENERATED from the routes that were actually written, not
 * hand-maintained. public/sitemap.xml held 51 URLs in the non-trailing form
 * while the live site redirected every one of them to the trailing form — the
 * two had disagreed the whole time, and a static list drifts from the
 * pre-render set the moment either changes. Generating it from
 * `publishedRoutes` means sitemap, canonical and the files on disk cannot
 * disagree: they have one source.
 *
 * Skipped routes are excluded by construction. Advertising a URL that renders
 * the 404 page is worse than omitting it. Section pages known to be empty are
 * rendered but not advertised — see sitemapRoutes. "Empty" needs both the
 * manifest's API counts and the blueprint lists the pages hold themselves,
 * which is what staticSectionItems reads.
 */
async function writeSitemap({ frontend, dist, publishedRoutes, manifest }) {
  const staticItems = await staticSectionItems(join(frontend, 'src', 'pages'));
  const sitemap = sitemapRoutes(publishedRoutes, manifest, staticItems);
  for (const route of sitemap.dropped) {
    console.log(`[prerender] sitemap: omitted ${route} — no published items for this section`);
  }
  const urls = sitemap.kept
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

/**
 * The run-level failures, added to the per-route ones: a core route that
 * rendered the 404 page, or too few documents written.
 */
function checkRun({ failures, skipped, written }) {
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
}

/** The build log's closing lines; a failure ends the process with exit code 1. */
function report({ failures, skipped, written, bytes }) {
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

  const average = Math.round(bytes / Math.max(written, 1) / 1024);
  console.log(`[prerender] ${written} HTML documents written, ${average} kB average`);
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
  const result = await renderRoutes({ render, targets, manifest, template, dist });

  await writeSitemap({ frontend, dist, publishedRoutes: result.publishedRoutes, manifest });

  // The SSR bundle is a build artefact, not site content. Left in place it would
  // be uploaded with the site — and `dist-ssr` contains a copy of every page's
  // source-mapped server build.
  rmSync(ssrDist, { recursive: true, force: true });

  checkRun(result);
  report(result);
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
