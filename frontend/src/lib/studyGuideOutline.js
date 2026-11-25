/**
 * Load one Azure study-guide outline on demand (#500).
 *
 * WHY. The outlines used to be one 491 kB module imported by the Azure
 * certification detail page, so every detail page shipped all of them (74 kB
 * gzipped) to render one — which was already in its prerendered HTML. Each
 * guide is now its own module under src/data/azure/study-guides/, and
 * `import.meta.glob` below makes Vite emit one small chunk per guide. The
 * page downloads only the guide it shows.
 *
 * WHY `use()` WITH A CACHED THENABLE, NOT `React.lazy`. Both suspend, and both
 * are hydration-safe inside a <Suspense> boundary for the same reason (see the
 * detail page's SkillsMeasured). The difference is what is being loaded:
 *
 *   - `React.lazy` loads a COMPONENT. A guide module is data, so lazy would
 *     need a synthetic component per exam wrapping the outline, itself cached
 *     per key so that a re-render does not create a new lazy type — which
 *     would remount the subtree and re-suspend on every render.
 *   - `use()` (React 19, which this app runs: react ^19.3.0) reads a promise
 *     directly. The promise must be stable across renders or React warns
 *     about an uncached promise and suspends again each time, so it is cached
 *     here per exam key for the life of the page.
 *
 * The thenable is also stamped `status: 'fulfilled'` / `value` once it
 * settles. That is React's own thenable protocol: `use()` on a thenable that
 * already says fulfilled returns the value synchronously instead of
 * suspending, so a second visit to an exam in the same session renders its
 * outline in one pass with no fallback frame.
 *
 * The prerenderer needs nothing special: react-dom/static's
 * `prerenderToNodeStream` waits for every suspended boundary before it
 * completes (the same mechanism that renders the lazy route pages), and
 * prerender-entry.jsx's `progressiveChunkSize` keeps the finished boundary
 * inline — the findStreamedBoundary gate (prerender-html.mjs) refuses the
 * build if not.
 */
import { use } from 'react';

// Lazy form: one loader per file, and one chunk per guide in the build. The
// index is excluded — it is imported synchronously, never through here.
const modules = import.meta.glob(
  ['@/data/azure/study-guides/*.js', '!@/data/azure/study-guides/index.js'],
  { import: 'default' }
);

/** `…/study-guides/az-104.js` → `az-104`, whatever prefix Vite gives the key. */
const LOADERS = new Map(
  Object.entries(modules).map(([file, load]) => [file.split('/').pop().replace(/\.js$/, ''), load])
);

const cache = new Map();

const NONE = Object.assign(Promise.resolve(null), { status: 'fulfilled', value: null });

/** The guide keys this build can load — for tests that compare it with the index. */
export function loadableGuideKeys() {
  return [...LOADERS.keys()].sort();
}

/**
 * A stable thenable for one exam's outline: the same object on every call for
 * the same key, resolving to the outline, or to null for an unknown key.
 *
 * A failed chunk load (a deploy replaced the hashed file, or the network
 * dropped) resolves to null rather than rejecting, so the page loses its
 * outline section instead of rendering its error boundary; the entry is
 * evicted so the next visit tries again.
 */
export function loadStudyGuideOutline(key) {
  const load = key ? LOADERS.get(key) : null;
  if (!load) return NONE;
  let thenable = cache.get(key);
  if (!thenable) {
    thenable = load().then(
      (outline) => outline ?? null,
      (error) => {
        cache.delete(key);
        console.error(`[study-guides] could not load the ${key} outline`, error);
        return null;
      }
    );
    thenable.then((value) => {
      thenable.status = 'fulfilled';
      thenable.value = value;
    });
    cache.set(key, thenable);
  }
  return thenable;
}

/** Suspends until the outline for `key` has loaded; call inside a <Suspense>. */
export function useStudyGuideOutline(key) {
  return use(loadStudyGuideOutline(key));
}
