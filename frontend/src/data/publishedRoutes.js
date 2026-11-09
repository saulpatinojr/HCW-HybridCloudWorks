/**
 * The article pages the site builds, read from the content manifest the
 * build uses (#1613, part of #1616).
 *
 * `frontend/data/content-manifest.json` is written from the published content
 * by `scripts/build-content-manifest.mjs` and merged by a daily pull request;
 * the pre-render step writes one page per entry in its `routes`. Since #1613
 * an address with no page of its own answers 404, so a link to an article
 * that is not in this list leads to the not-found page.
 *
 * Only `routes` is imported, by name, so the bundler can leave the rest of
 * the file (every article's full text, over half a megabyte) out of the
 * browser bundle.
 */
import { routes as manifestRoutes } from '../../data/content-manifest.json';

/** Every content page in the manifest, e.g. `/azure/blog/<slug>`. */
export const PUBLISHED_ROUTES = new Set(manifestRoutes || []);
