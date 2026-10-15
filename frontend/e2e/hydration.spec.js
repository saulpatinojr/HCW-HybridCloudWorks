import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Routes the pre-renderer actually seeded, read from the build output.
 *
 * NOT scraped from a listing page and NOT hardcoded. Scraping made this test
 * skip itself silently the first time it ran — a green suite that had never
 * exercised the case the whole change exists for. A pinned slug would rot on
 * the next manifest regeneration, which is the same failure one release later.
 */
function seededArticleRoutes() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'index.html') {
        const route = `/${relative(DIST, dirname(full)).split(sep).join('/')}`;
        if (/^\/[^/]+\/blog\/.+/.test(route)) found.push(route);
      }
    }
  };
  try {
    walk(DIST);
  } catch {
    return [];
  }
  return found;
}

/** The first pre-rendered `/azure/education/:certSlug` route, or undefined. */
function firstAzureCertRoute() {
  try {
    const [slug] = readdirSync(join(DIST, 'azure', 'education')).filter((entry) =>
      statSync(join(DIST, 'azure', 'education', entry, 'index.html'), {
        throwIfNoEntry: false,
      })?.isFile()
    );
    return slug ? `/azure/education/${slug}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does hydration actually reuse the pre-rendered DOM? (T-714)
 *
 * The 104 pre-rendered documents were built, shipped and discarded at boot for
 * as long as main.jsx used createRoot. Switching to hydrateRoot is only worth
 * anything if the client's first render matches what the pre-renderer emitted —
 * and a mismatch is SILENT in a production build, because React recovers by
 * throwing the markup away and client-rendering. The page looks right either
 * way. That is precisely why this is checked by driving a browser rather than
 * by reading the code.
 *
 * Two independent signals, because either alone can lie:
 *
 *   1. onRecoverableError in main.jsx logs '[hydration]'. React calls it for a
 *      mismatch even in production. Nothing else in the app emits that prefix.
 *   2. A node identity check. Before hydration the mount point holds server
 *      markup; if React discarded and re-rendered, the element is replaced.
 *      Tagging a node and finding it still attached afterwards proves reuse
 *      rather than coincidental sameness of the HTML.
 *
 * Signal 2 is the only one that sees #604. When a still-dehydrated Suspense
 * boundary receives an update, React 19 client-renders it WITHOUT calling
 * onRecoverableError, so signal 1 stays quiet while the page is thrown away.
 */

/** Console noise unrelated to hydration that must not fail this file. */
function isHydrationError(text) {
  return text.includes('[hydration]') || text.toLowerCase().includes('hydrat');
}

async function collectErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe('pre-render hydration', () => {
  test('the home page hydrates without a mismatch', async ({ page }) => {
    const errors = await collectErrors(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(errors.filter(isHydrationError)).toEqual([]);
  });

  // The home page, and an Azure certification detail page read from the build
  // output for the same reason seededArticleRoutes is (#604).
  for (const route of ['/', firstAzureCertRoute()]) {
    test(`the pre-rendered page content is reused, not replaced: ${route}`, async ({ page }) => {
      // Not a pinned slug and not test.skip — see seededArticleRoutes.
      expect(route, 'the build produced an Azure certification detail page').toBeTruthy();

      // THE PROBE GOES INSIDE <main>, UNDER THE ROUTE'S <Suspense>. It used to
      // tag the first element in #root — the app shell, OUTSIDE that boundary
      // — so it passed while React threw away every page's content (#604): the
      // shell hydrates on its own, and the boundary is client-rendered
      // separately when it receives an update before its lazy chunk arrives.
      await page.addInitScript(() => {
        const mark = () => {
          const node = document.getElementById('main-content')?.firstElementChild;
          if (node) {
            node.setAttribute('data-hydration-probe', '1');
            window.__probePlanted = true;
          }
        };
        document.addEventListener('DOMContentLoaded', mark, { once: true });
      });

      // Hold every lazy chunk back. The failure is a race — something
      // re-rendering the boundary's parent while the page chunk is still on
      // the wire — which a fast local server usually, not always, loses.
      // Delaying everything but the entry makes the slow network the default,
      // so an update that lands during hydration is caught every run.
      await page.route(/\/assets\/(?!index-)[^/]+\.js$/, async (chunkRoute) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await chunkRoute.continue();
      });

      await page.goto(route === '/' ? '/' : `${route}/`);
      expect(await page.evaluate(() => window.__probePlanted === true)).toBe(true);

      await page.waitForLoadState('networkidle');
      // Past requestIdleCallback's 2 s timeout and DeferredChrome's 1.5 s
      // fallback, so the deferred chrome has mounted and cannot still be
      // pending.
      await page.waitForTimeout(3000);
      const survived = await page.locator('main [data-hydration-probe="1"]').count();
      expect(survived, 'the server-rendered page content survived hydration').toBe(1);
    });
  }

  test('the mount point is stamped with the route it was rendered for', async ({ page }) => {
    await page.goto('/');
    const stamped = await page.getAttribute('#root', 'data-prerendered-route');
    expect(stamped).toBe('/');
  });

  test('a seeded article page hydrates its content without a mismatch', async ({ page }) => {
    const errors = await collectErrors(page);

    const [article] = seededArticleRoutes();
    // Not test.skip: an empty list means the build produced no article pages,
    // and quietly passing on that would hide the regression rather than report
    // it. The pre-render step writes 22 of them.
    expect(article, 'the build produced at least one pre-rendered article page').toBeTruthy();

    // WITH the trailing slash. `vite preview` resolves `/a/b/` to
    // `dist/a/b/index.html` but SPA-falls-back `/a/b` to `dist/index.html` —
    // the home page — so the un-slashed form here would be testing the preview
    // server's fallback, not this page. That asymmetry is a property of the
    // dev preview, not of Static Web Apps, which is why it is not asserted as
    // behaviour anywhere; main.jsx normalizes trailing slashes on both sides of
    // the stamp comparison precisely so either form hydrates.
    await page.goto(`${article}/`);
    await page.waitForLoadState('networkidle');

    // The seed is what makes the first client render match; without it the page
    // renders a skeleton and React discards the article markup.
    const seed = await page.evaluate(
      () => document.getElementById('root')?.dataset?.prerenderedSeed?.length ?? 0
    );
    expect(seed, 'the article page carries a pre-render seed').toBeGreaterThan(0);
    expect(errors.filter(isHydrationError)).toEqual([]);
  });

  test('an unprerendered route falls back to a client render instead of hydrating', async ({
    page,
  }) => {
    const errors = await collectErrors(page);

    // navigationFallback serves the HOME PAGE's markup here at HTTP 200. If
    // main.jsx hydrated on "the mount point has children" this would mismatch
    // on every admin route; the route stamp is what makes it a clean client
    // render instead.
    await page.goto('/admin/review-queue');
    await page.waitForLoadState('networkidle');

    const stamped = await page.getAttribute('#root', 'data-prerendered-route');
    expect(stamped, 'the fallback really did serve the home page document').toBe('/');
    expect(errors.filter(isHydrationError)).toEqual([]);
  });
});
