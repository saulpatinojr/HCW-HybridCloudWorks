import React from 'react';
import ReactDOM from 'react-dom/client';
import AppWrapper from '@/App';
import { HelmetProvider } from 'react-helmet-async';
import { PrerenderDataContext } from '@/hooks/prerenderData';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found. Make sure you have a div with id="root" in your HTML.');
}

/** `/about/` and `/about` are the same route; `/` stays `/`. */
function normalizePath(value) {
  if (!value) return '/';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The data the pre-renderer used, or null.
 *
 * READ FROM THE MOUNT POINT, NOT FROM A `<script id="...">` ISLAND. The island
 * is the usual shape for this, and it is the shape this used to have, but it
 * is found with `document.getElementById` — which returns the first element
 * carrying that id, of any kind. Article bodies are author-written HTML, and
 * DOMPurify's DEFAULT configuration strips an injected `<script>` but keeps
 * `<div id="...">`; such a div sits inside `#root`, so it comes first in
 * document order and would have supplied the seed for its own page. `<div
 * id="root">` comes from the template, ahead of everything the pre-render puts
 * inside it, so nothing an author writes can precede it.
 * scripts/prerender.mjs writes the matching attribute and says the same there.
 *
 * `src/lib/sanitizeHtml.js` now also prefixes author ids, so the clobber is
 * closed on both sides. Neither fix is redundant: this one holds even if the
 * sanitizer is reconfigured, and that one holds for every id the app looks up,
 * not just this one.
 *
 * A malformed value is treated as absent rather than fatal. It would mean the
 * build wrote something JSON.parse rejects, which is a build bug — but taking
 * the whole site down in the browser is a strictly worse response than
 * rendering it the way it rendered before any of this existed.
 */
function readSeed() {
  // dataset.prerenderedSeed is the DOM spelling of data-prerendered-seed.
  const raw = rootElement.dataset.prerenderedSeed;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('Pre-render seed could not be parsed; falling back to a client render.', error);
    return null;
  }
}

/**
 * Is the markup in this document actually for the URL being displayed?
 *
 * THE QUESTION IS NOT "was anything pre-rendered". A path without a file of
 * its own is served markup made for another URL: the client-only areas
 * (/admin, /preview, ...) get app-shell.html, and any other unknown path gets
 * the same shell with a 404 (staticwebapp.config.json, #1613). This check was
 * written when that fallback was the pre-rendered HOME PAGE, and it still
 * matters: asking only whether the mount point has children would hydrate one
 * route's tree against another route's DOM.
 *
 * So the pre-renderer stamps the route it rendered and this compares it to the
 * live path. A mismatch is not an error: it is the fallback working as
 * designed, and the answer is a normal client render.
 */
function prerenderedForThisUrl() {
  const stamped = rootElement.dataset.prerenderedRoute;
  if (!stamped) return false;
  if (!rootElement.firstChild) return false;
  return normalizePath(stamped) === normalizePath(window.location.pathname);
}

const seed = readSeed();

const tree = (
  <React.StrictMode>
    <HelmetProvider>
      {/*
        In a client render this provider holds null and usePrerenderedData
        returns undefined for every key — identical to having no provider at
        all, which is what main.jsx did before. On a hydrated page it holds the
        same object the pre-render used, which is the whole point: the first
        client render has to produce the tree that is already in the DOM, and
        usePublicData fetches in an effect that has not run yet.
      */}
      <PrerenderDataContext.Provider value={seed}>
        <AppWrapper />
      </PrerenderDataContext.Provider>
    </HelmetProvider>
  </React.StrictMode>
);

/**
 * A hydration mismatch is otherwise SILENT in a production build.
 *
 * React recovers by discarding the server markup and client-rendering, so the
 * page looks right and every pre-rendered document is quietly wasted —
 * which is indistinguishable from the createRoot behaviour this replaces. That
 * is exactly how this could regress without anyone noticing, so it is reported
 * rather than swallowed. e2e/hydration.spec.js fails on it.
 */
function onRecoverableError(error, errorInfo) {
  console.error(
    '[hydration] React recovered from an error',
    error,
    errorInfo?.componentStack || ''
  );
}

if (prerenderedForThisUrl()) {
  ReactDOM.hydrateRoot(rootElement, tree, { onRecoverableError });
} else {
  ReactDOM.createRoot(rootElement).render(tree);
}
