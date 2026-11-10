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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Tags React hoists to the document head, emitted ahead of the body markup. */
const HEAD_TAG = /^\s*<(link|meta|title|style|script|base)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/i;

/**
 * The canonical origin and URL shape. Decided 2026-08-23 from evidence, not
 * preference, because canonical and trailing slash cannot be chosen separately:
 * a canonical pointing at a URL that redirects is worse than no canonical.
 *
 *   - The live Firebase site 301s `/about` to `/about/`, so the form Google
 *     actually resolved and indexed is the TRAILING one.
 *   - Its sitemap advertises `/about`, the non-trailing form. The two have
 *     disagreed the whole time; the sitemap is the half that is wrong.
 *   - Azure was configured `trailingSlash: "never"`, the opposite of live.
 *
 * Trailing looked right — it preserves the indexed form — and was shipped that
 * way for one deploy. It is wrong on this platform.
 *
 * `trailingSlash: "always"` in Static Web Apps applies to EVERY path, files
 * included. Measured live: `/assets/index-*.js`, `/assets/vendor-*.css`,
 * `/icons/hcw-logo.png` and `/sitemap.xml` all returned 301 to a slashed URL.
 * They resolve at the redirect with the correct content type, so nothing broke
 * — it simply cost an extra round trip on every asset on every page load,
 * permanently, to preserve a URL form that a 301 already handles.
 *
 * So: NON-trailing, matching `trailingSlash: "never"`. Existing trailing-form
 * inbound links redirect once and pass their equity on, which is the same
 * mechanism that made the trailing form look preferable in the first place.
 *
 * Apex, not www: every indexed URL and the sitemap use the apex.
 */
export const SITE_ORIGIN = 'https://hybridcloudworks.com';
const DEFAULT_SOCIAL_IMAGE = `${SITE_ORIGIN}/icons/hcw-logo.png`;

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

/** `/azure/blog` -> `https://hybridcloudworks.com/azure/blog` (root keeps its slash) */
export function canonicalFor(route) {
  const clean = String(route).replace(/^\/+|\/+$/g, '');
  return clean ? `${SITE_ORIGIN}/${clean}` : `${SITE_ORIGIN}/`;
}

/** The value of a `<meta>` already present in the rendered head, if any. */
function metaContent(head, attr, name) {
  const match = new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`, 'i').exec(head);
  return match?.[1] || null;
}

/**
 * The head tags a route did not supply itself.
 *
 * WHY THIS IS NOT OPTIONAL. Pre-rendering made these pages legible to crawlers
 * for the first time, and what they read was `index.html`'s hardcoded
 * `<link rel="canonical" href="https://hybridcloudworks.com">` — every page
 * declaring itself a duplicate of the home page. Titles were correct and the
 * canonical said to consolidate all of them onto one URL anyway.
 *
 * Coverage was also uneven rather than absent: `/azure/news` already emitted
 * og:title and og:description from NewsPage, `/about` emitted neither, and the
 * routes with the best metadata of all — the article and architecture detail
 * templates, which set canonical, og:image and more — are the ones not
 * pre-rendered at all. So this fills gaps and never overwrites: a page that
 * says something about itself keeps saying it.
 */
export function socialTags(head, route, title) {
  const canonical = canonicalFor(route);
  const description = metaContent(head, 'name', 'description');
  const ogTitle = metaContent(head, 'property', 'og:title') || title;
  const ogDescription = metaContent(head, 'property', 'og:description') || description;
  const ogImage = metaContent(head, 'property', 'og:image') || DEFAULT_SOCIAL_IMAGE;

  // escapeAttr, like every other tag below. This one was raw until 2026-08-30,
  // when a T-714 escaping test on the route stamp failed by matching the
  // canonical instead — a route of `/a"><script>x` closed the href and emitted
  // a live element into <head>. Routes are not all hardcoded: `manifest.routes`
  // is built from content slugs, so the value does reach here from data.
  const tags = [`<link rel="canonical" href="${escapeAttr(canonical)}" />`];
  const add = (attr, name, content) => {
    if (!content) return;
    if (metaContent(head, attr, name)) return; // the page said it; leave it alone
    tags.push(`<meta ${attr}="${name}" content="${escapeAttr(content)}" />`);
  };

  // og:url must agree with the canonical or the two signals contradict.
  add('property', 'og:url', canonical);
  add('property', 'og:type', 'website');
  add('property', 'og:site_name', 'Hybrid Cloud Works');
  add('property', 'og:title', ogTitle);
  add('property', 'og:description', ogDescription);
  add('property', 'og:image', ogImage);
  add('name', 'twitter:card', 'summary_large_image');
  add('name', 'twitter:title', ogTitle);
  add('name', 'twitter:description', ogDescription);
  add('name', 'twitter:image', ogImage);

  return tags.join('\n    ');
}

/**
 * `>` IS ESCAPED TOO, and that is not cosmetic. A raw `>` inside a quoted
 * attribute value is legal HTML, so nothing rendered wrong — but it makes the
 * attribute value unscannable by any `[^>]*` pattern, and the mount point this
 * writes is scanned by exactly such a pattern in deploy-azure-frontend.yml. A
 * seed containing `>` would have made that check read the tag as ending early.
 * Added 2026-09-01 alongside the guard that depends on it.
 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split React's output into head tags and body markup.
 *
 * React 19 hoists `<title>`, `<meta>` and `<link>` rendered anywhere in the tree
 * to the front of the stream, ahead of the first real element. This consumes
 * that run; whatever is left is the body.
 */
export function splitHead(rendered) {
  let rest = rendered;
  const head = [];
  for (;;) {
    const match = HEAD_TAG.exec(rest);
    if (!match) break;
    head.push(match[0].trim());
    rest = rest.slice(match[0].length);
  }
  return { head: head.join('\n    '), body: rest };
}

/**
 * Fizz's streamed form, which a static file must never carry: a pending
 * boundary marker with its placeholder template, a hidden completion segment,
 * or the inline runtime that swaps one into the other. Returns a description
 * of the first thing found, or null for a fully inline document. The three
 * are checked separately because a future React could emit any subset.
 */
export function findStreamedBoundary(html) {
  const source = String(html || '');
  if (source.includes('<!--$?-->')) return 'pending Suspense boundary (<!--$?-->) in the output';
  if (/<div hidden id="S:\d+">/.test(source))
    return 'hidden completion segment (S:n) in the output';
  if (/\$RC\(|\$RB=\[\]|\$RT=performance\.now\(\)/.test(source)) {
    return 'React streaming runtime script in the output';
  }
  return null;
}

/**
 * Put the rendered markup and head tags into the built index.html.
 *
 * The template's own `<title>` is REPLACED, not appended to. Two title elements
 * in one document is not a tie a crawler resolves the way you would hope, and
 * the template's is the generic one.
 */
/**
 * The attribute `main.jsx` reads the seed from. Agreed in two files; changing
 * it in one and not the other turns hydration back into a full client
 * re-render, silently — the page still works, it just throws away the
 * pre-rendered DOM again, which is precisely the bug T-714 was opened for.
 * `prerender.test.js` pins the pair.
 */
export const SEED_ATTRIBUTE = 'data-prerendered-seed';

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
 * where `/` follows `<` and the match fails. It relies on escapeAttr escaping
 * `>`; see the note there.
 */
export const MOUNT_POINT_PATTERN = '<div id="root"[^>]*><[^/]';

/**
 * Serialize the seed into an attribute on the mount point.
 *
 * WHY THIS EXISTS AT ALL. Hydration requires the client's first render to
 * produce the same tree the pre-render produced. `usePublicData` fetches in an
 * effect, so without the data in hand at mount the client renders a skeleton,
 * React sees a mismatch against the article markup, and discards the whole
 * pre-rendered DOM — the 120 documents would be built, shipped, and thrown away
 * exactly as they were before T-714, only more expensively.
 *
 * WHY AN ATTRIBUTE AND NOT A `<script type="application/json" id="...">`
 * ISLAND, which is the usual shape for this (it is what Next.js does with
 * `__NEXT_DATA__`). An island is found with `document.getElementById`, and
 * `getElementById` returns the FIRST element with that id in document order —
 * any element, not just a script. Article bodies are author-written HTML
 * rendered through `DOMPurify.sanitize`, and DOMPurify's default configuration
 * keeps `id` attributes on ordinary elements: it strips an injected
 * `<script id="__PRERENDER_DATA__">` but passes an injected
 * `<div id="__PRERENDER_DATA__">` through untouched. That div sits inside
 * `#root`, so it comes first, and it would have become the seed for its own
 * page — an author-controlled object flowing into every `href` and `src` on it.
 * That is not theoretical: it was reproduced against this repo's DOMPurify
 * before this attribute replaced the island.
 *
 * `src/lib/sanitizeHtml.js` now prefixes author-written ids as well, so the
 * clobber is closed at the sanitizer too. This attribute stays regardless: it
 * does not depend on that configuration staying right, which was the point.
 *
 * The mount point cannot be shadowed the same way. `<div id="root">` is written
 * by the template, ahead of everything the pre-render puts inside it, so an
 * injected `id="root"` is always later in document order and always loses. The
 * seed therefore stops depending on a sanitizer's configuration staying right.
 *
 * `escapeAttr` handles the quoting, and it escapes `<` as well as `&` and `"`,
 * so a literal `</script>` or `<img onerror=...>` inside article text is inert
 * markup-wise — it is attribute text that only ever reaches `JSON.parse`.
 */
export function seedAttribute(seededData) {
  if (!seededData) return '';
  return ` ${SEED_ATTRIBUTE}="${escapeAttr(JSON.stringify(seededData))}"`;
}

export function injectIntoTemplate(template, { head, body }, route = '/', seededData = null) {
  let html = template;

  if (/<title\b/i.test(head)) {
    html = html.replace(/\s*<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  }

  // The template's canonical is ALWAYS removed, whether or not the route
  // supplies its own. It is hardcoded to the home page, so leaving it means
  // either a wrong canonical or two competing ones — and Google's guidance for
  // JavaScript sites is explicit that the canonical in the served HTML must not
  // contradict the rendered one.
  html = html.replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '');

  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] || '';
  const generated = socialTags(head, route, title);

  // Detail templates set their own canonical via Helmet, so it arrives in
  // `head` — correct in spirit, but the route decides the origin and the
  // trailing-slash form and this step already knows both. Dropping it here and
  // letting socialTags emit one keeps exactly one per document. Leaving it
  // produced TWO on all 24 article pages, which is not a tie a crawler
  // resolves the way anyone hopes.
  const headWithoutCanonical = head.replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '');
  const combined = [headWithoutCanonical, generated].filter(Boolean).join('\n    ');

  if (combined) {
    html = html.replace(/<\/head>/i, `    ${combined}\n  </head>`);
  }

  // The mount point keeps its id: the client bundle still hydrates into it.
  const rootDiv = /<div id="root"><\/div>/;
  if (!rootDiv.test(html)) {
    // `/` is written back to dist/index.html, which is also the template. Run
    // this twice without an intervening `vite build` and the second run reads
    // its own output — an empty mount point is the thing that distinguishes
    // them, so say which case this is rather than "no root div".
    if (/<div id="root">\s*\S/.test(html)) {
      throw new Error(
        'dist/index.html has already been pre-rendered. This step needs the ' +
          'template `vite build` produces — run `npm run build`, which does both in order.'
      );
    }
    throw new Error('dist/index.html has no <div id="root"></div> to render into');
  }
  // The seed rides on the mount point itself. Vite's entry is a module script
  // and therefore deferred, so it runs after parsing and the attribute is
  // always present by the time main.jsx reads it — there is no ordering race
  // to reason about.
  const seed = seedAttribute(seededData);

  // THE ROUTE IS STAMPED ON THE MOUNT POINT, and main.jsx refuses to hydrate
  // unless it matches the URL being displayed. This is not belt-and-braces; it
  // is the difference between hydration working and hydration corrupting every
  // page that was never pre-rendered.
  //
  // A path without a file of its own gets some other page's markup: the
  // client-only areas (/admin, /preview, ...) are rewritten to app-shell.html
  // by staticwebapp.config.json, and any other unknown path gets the same
  // shell with a 404 (#1613). The stamp was added when that fallback was the
  // HOME PAGE's markup (T-714), and it still guards the same thing: hydrating
  // markup rendered for one route against the tree of another is a guaranteed
  // mismatch, so main.jsx only hydrates when the stamp matches the URL.
  //
  // Comparing the stamp to location.pathname turns that from something a future
  // route addition can silently trip into a decision made per page load.
  return html.replace(
    rootDiv,
    `<div id="root" data-prerendered-route="${escapeAttr(route)}"${seed}>${body}</div>`
  );
}

/** `/azure/blog` -> `dist/azure/blog/index.html`; `/` -> `dist/index.html`. */
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

function outputPathFor(dist, route) {
  const clean = route.replace(/^\/+|\/+$/g, '');
  return clean ? join(dist, clean, 'index.html') : join(dist, 'index.html');
}

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

  // Build input, not site content — see build-content-manifest.mjs. Absent is
  // fine and simply means no detail routes this build.
  const manifestPath = join(frontend, 'data', 'content-manifest.json');
  let manifest = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    console.log(
      `[prerender] manifest: ${manifest.routes?.length || 0} article routes, generated ${manifest.generatedAt || 'unknown'}`
    );
  } else {
    console.log('[prerender] no content manifest — article detail pages will not be pre-rendered');
  }

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
      failures.push(`${route}: threw — ${error?.message || error}`);
      continue;
    }

    if (rendered.errors.length > 0) {
      // An error boundary produces perfectly valid-looking HTML. Without this
      // check the error state would be written out and published as the page.
      failures.push(`${route}: rendered an error — ${rendered.errors[0].message}`);
      continue;
    }

    const streamed = findStreamedBoundary(rendered.html);
    if (streamed) {
      // A page in Fizz's streamed form passed every check below on 2026-09-06:
      // the shell had header, footer and a spinner, the page itself sat in a
      // hidden segment, and the text count was well above the shell floor.
      // It is not a page — nothing without JavaScript ever sees the content,
      // and the browser cannot run the swap script under this site's CSP.
      failures.push(`${route}: ${streamed} (see prerender-entry.jsx progressiveChunkSize)`);
      continue;
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
      skipped.push(route);
      continue;
    }

    const text = rendered.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < MIN_TEXT_CHARS) {
      failures.push(`${route}: only ${text.length} characters of text — a shell, not a page`);
      continue;
    }

    const html = injectIntoTemplate(template, splitHead(rendered.html), route, seed);
    const outPath = outputPathFor(dist, route);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    written += 1;
    bytes += Buffer.byteLength(html);
    publishedRoutes.push(route);
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

  // The SSR bundle is a build artefact, not site content. Left in place it would
  // be uploaded with the site — and `dist-ssr` contains a copy of every page's
  // source-mapped server build.
  rmSync(ssrDist, { recursive: true, force: true });

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
