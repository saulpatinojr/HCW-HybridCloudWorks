/**
 * Server entry for the pre-render step.
 *
 * Deliberately NOT `main.jsx`: that entry reaches for
 * `document.getElementById('root')` at module scope and mounts a client root,
 * neither of which exists here. This renders the same tree with a static router
 * instead, and collects the head tags Helmet produces on the way.
 *
 * Everything else — providers, layout, the 42 pages that set their own title —
 * is imported from the real application, because a second copy of the tree
 * would pre-render a site that is not the site.
 */
import React from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { StaticRouter } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import { App, AppProviders } from '@/App';
import { VALID_PROVIDERS } from '@/context/ProviderContext';
import { PrerenderDataContext } from '@/hooks/prerenderData';
import { certifications as azureCertifications } from '@/data/azure/certifications';
import { availableLabs, labPanePath, labsPath, providersWithLabs } from '@/data/labs/catalogue';
import { addonPanePath, addons } from '@/data/addons/catalogue';

/**
 * Sections that exist under every provider, as declared by App.jsx's
 * `/:provider` route block. A provider that has no content for one renders the
 * Coming Soon page, which is a real page and is pre-rendered as such.
 */
const PROVIDER_SECTIONS = [
  'blog',
  'architecture-designs',
  'frameworks',
  'code',
  'coder-corner',
  'education',
  'audio-architecture',
  'audio',
  'news',
  'rss',
];

/**
 * Every route pre-rendered at build time.
 *
 * Derived from `VALID_PROVIDERS` rather than written out, so adding a provider
 * adds its pages automatically — a hand-maintained list is how a route quietly
 * stops being pre-rendered.
 *
 * DETAIL PAGES COME FROM THE MANIFEST, not from the API. `/:provider/blog/:slug`
 * needs its article at render time and the build cannot fetch one — Cloudflare
 * answers a GitHub runner with a managed challenge (#175), and making every
 * deploy depend on a bot-protection exception is the trade that issue rejected.
 * So `frontend/data/content-manifest.json`, written by an Azure-authenticated
 * workflow reading Cosmos directly, supplies both the routes and their content.
 * When the file is absent — a fresh clone, a branch that predates it — detail
 * routes are simply skipped and everything else pre-renders as before.
 *
 * Admin routes are excluded on purpose: they are behind Entra sign-in, have no
 * search value, and pre-rendering them would publish the shell of a private UI.
 * /preview/:id (the signed staging view, T-606) is excluded by the same
 * construction — nothing below enumerates it, and it must stay that way: a
 * prerendered preview would publish an unpublished draft.
 */
/**
 * Public routes that are NOT `/:provider/<section>` and so are not produced by
 * the derivation below (T-737).
 *
 * Eleven indexable routes were declared in App.jsx and reached neither disk nor
 * the sitemap: they fell through to `app-shell.html`, which carries a generic
 * title and no canonical — so a crawler that found one saw the same untitled
 * shell as for every other. `routes-are-complete.test.js` reads App.jsx and
 * fails when a public absolute route is missing from here, which is the part
 * that stops the list going stale again: a hand-maintained list is exactly how
 * a route quietly stops being pre-rendered, and this file already says so.
 *
 * `/templates/*` are submission forms — real public pages with real content,
 * and indexable whether or not anyone wants them to be.
 */
const STANDALONE_ROUTES = [
  // The cross-provider Learn index and the browser labs page (#681). Not
  // `/:provider/education`, so the derivation below never produces them.
  '/education',
  '/education/labs',
  '/finops/tools',
  '/finops/focus',
  '/finops/architectures',
  '/terraform/modules',
  '/terraform/tools',
  '/docker/sandboxes',
  '/docker/building-images',
  '/docker/desktop',
  '/docker/tools',
  '/github/workflows',
  '/github/tools',
  '/ansible/tools',
  '/tools/comparison',
  '/tools/resources',
  '/tools/decisions',
  '/tools/landing-zone',
  '/templates/framework',
  '/templates/architecture',
  '/templates/blog',
  '/templates/coder-corner',
  '/templates/rosetta-stone',
];

/**
 * Azure certification detail pages, one per entry of the shared catalogue
 * (`/azure/education/:certSlug`). These come from a repository file rather
 * than the manifest, so they pre-render on every build with no seed: the page
 * renders its certification from the import, and the Listen & Learn block —
 * the only fetched part — renders nothing without data, which is also what
 * the browser shows until the episodes arrive. Before 2026-09-09 these URLs
 * served the 3 kB SPA shell (#461 item 2).
 */
const AZURE_CERT_ROUTES = azureCertifications.map((cert) => `/azure/education/${cert.slug}`);

/**
 * The labs under each provider's Learn section (ADR 0033 §3): one list per
 * provider that has a lab (`/:provider/education/labs`) and one page per lab
 * under each provider that lists it (`/:provider/education/labs/:labId`),
 * plus the index's own pane route per lab (`/education/labs/:labId`, #751),
 * kept for links written before ADR 0033. For the same reason as the
 * certification pages: the rows are a repository file, so every build knows
 * them. The built page is the lab's heading, facts and steps with the pane's
 * opening sentence; the status read and the pane itself start in the
 * browser, and nothing in the first render reads storage or the clock, so
 * hydration matches.
 */
const LAB_ROUTES = [
  ...providersWithLabs().map((provider) => labsPath(provider)),
  ...availableLabs.flatMap((lab) => [
    labPanePath(null, lab.id),
    ...lab.providers.map((provider) => labPanePath(provider, lab.id)),
  ]),
];

/**
 * The AddOn panes (ADR 0035): one page per row of the AddOn catalogue at
 * `/tools/<id>`, available and coming alike. A coming row pre-renders as
 * its explainer page, which is a real page rather than a soft 404. Like the
 * lab pages, the built page is the heading and the opening sentence; the
 * status read and the frame start in the browser.
 */
const ADDON_ROUTES = addons.map(addonPanePath);

/** Every path the site pre-renders: the static routes, the provider routes, the catalogue-driven add-on pages and the content routes from the manifest. */
export function routes(manifest = null) {
  return [
    '/',
    '/about',
    '/contact',
    ...VALID_PROVIDERS.flatMap((provider) => [
      `/${provider}`,
      ...PROVIDER_SECTIONS.map((section) => `/${provider}/${section}`),
    ]),
    ...STANDALONE_ROUTES,
    ...AZURE_CERT_ROUTES,
    ...LAB_ROUTES,
    ...ADDON_ROUTES,
    ...(manifest?.routes || []),
  ];
}

/**
 * @param {string} url Route path to render, e.g. '/about'.
 * @returns {Promise<{html: string, head: string}>}
 */
export async function render(url, seededData = null) {
  const helmetContext = {};

  // `prerenderToNodeStream`, not `renderToString`. Every route in this app is a
  // React.lazy import behind one <Suspense>, and renderToString does not wait:
  // it emits the PageLoader fallback and returns. That produced ~380 characters
  // of identical markup for every URL and no title at all — a shell, which is
  // the exact problem this step exists to fix. The static API resolves every
  // Suspense boundary before it completes.
  //
  // Same nesting as main.jsx: Helmet outermost, then the shared providers, then
  // the router. Only the router differs.
  // Collected rather than logged. A route that renders an error boundary still
  // produces perfectly valid-looking HTML — a shell — so the caller has to be
  // able to tell "rendered" from "rendered the error state", and refuse to
  // publish the second.
  const errors = [];

  const { prelude } = await prerenderToNodeStream(
    <HelmetProvider context={helmetContext}>
      {/*
        The seed is how a detail page renders its article at all: usePublicData
        fetches in an effect, and effects do not run here. Null on every route
        that needs no data, which is the browser's behaviour too.
      */}
      <PrerenderDataContext.Provider value={seededData}>
        <AppProviders>
          <StaticRouter location={url}>
            <App />
          </StaticRouter>
        </AppProviders>
      </PrerenderDataContext.Provider>
    </HelmetProvider>,
    {
      // THE PAGE MUST BE INLINE, NOT STREAMED. Fizz outlines any completed
      // Suspense boundary larger than `progressiveChunkSize` (12.8 kB by
      // default): the shell gets `<!--$?--><template id="B:0">` plus the
      // route's fallback spinner, the real page follows as
      // `<div hidden id="S:0">`, and an inline `$RC` script swaps them in the
      // browser. Every real page here is bigger than that, so until
      // 2026-09-06 every pre-rendered document was a spinner in `<main>`, a
      // hidden copy of the page, and two inline scripts the CSP (no hashes,
      // deliberately) refuses to run — which is React error 419 on every
      // hydration and a crawler reading the fallback (issue #370). Raising the
      // threshold makes Fizz inline every completed boundary, which is the
      // only form a static file should ever carry. prerender.mjs refuses to
      // write the streamed form, so this cannot silently come back.
      progressiveChunkSize: Number.MAX_SAFE_INTEGER,
      onError(error, info) {
        errors.push({
          message: error?.message || String(error),
          stack: info?.componentStack || '',
        });
      },
    }
  );

  const html = await new Promise((resolve, reject) => {
    let out = '';
    prelude.setEncoding('utf8');
    prelude.on('data', (chunk) => {
      out += chunk;
    });
    prelude.on('end', () => resolve(out));
    prelude.on('error', reject);
  });

  // Read AFTER the render completes: Helmet fills the context as components
  // mount, and a lazy page has not mounted until its boundary resolves.
  const { helmet } = helmetContext;
  const head = helmet
    ? [
        helmet.title?.toString(),
        helmet.meta?.toString(),
        helmet.link?.toString(),
        helmet.script?.toString(),
      ]
        .filter(Boolean)
        .join('\n    ')
    : '';

  return { html, head, errors };
}
