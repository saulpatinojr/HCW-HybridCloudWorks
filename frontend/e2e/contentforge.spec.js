import { test, expect } from '@playwright/test';

/**
 * The admin shell, as a visitor who has not signed in sees it.
 *
 * Until 2026-10-06 this file held sixteen tests that could not fail: every
 * assertion short-circuited on `page.url().includes('admin')`, so a blank
 * shell, a removed auth guard or a broken route all passed (estate review,
 * finding QA-1). No test here signs in; what this file pins is the one journey
 * every admin starts with and the one an attacker would probe:
 *
 *   - an unauthenticated visit to any admin route shows the sign-in card and
 *     NOTHING of the admin: no navigation, no page, no data;
 *   - the sign-in card is reachable by keyboard and named for a screen reader;
 *   - the admin route carries a document title (WCAG 2.4.2);
 *   - at a phone width the page does not scroll sideways (AP-F1).
 *
 * The signed-in journey lives in admin-authenticated.spec.js, behind the
 * credential-free identity in fixtures/entra.js: the callback landing on the
 * route that was asked for, the denial and configuration cards, the one
 * automatic re-authentication on an expired token, and the Pixel 5 drawer.
 *
 * The routes are the menu labels' slugs (AP-F13, #937): `/admin/platform-settings`
 * was once a not-found path beside the real `/admin/platform`, and a signed-out
 * check on it proved only that the guard wraps unknown admin paths too. Now it
 * is the page and `/admin/platform` is its redirect, so the list below names
 * routes the registry declares.
 */

const ADMIN_ROUTES = ['/admin', '/admin/review-queue', '/admin/platform-settings', '/admin/health'];

for (const route of ADMIN_ROUTES) {
  test(`${route}: signed out, the guard shows the sign-in card and none of the admin`, async ({
    page,
  }) => {
    await page.goto(route);
    const signIn = page.getByRole('button', { name: /sign in with microsoft/i });
    await expect(signIn).toBeVisible();
    await expect(page.getByText('Admin Access Required')).toBeVisible();
    // The admin navigation (the registry) must not render for a visitor.
    await expect(page.getByRole('navigation', { name: 'ContentForge' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /review queue/i })).toHaveCount(0);
  });
}

test('the sign-in card is keyboard reachable and the route has a title', async ({ page }) => {
  await page.goto('/admin');
  const signIn = page.getByRole('button', { name: /sign in with microsoft/i });
  await expect(signIn).toBeVisible();
  await signIn.focus();
  await expect(signIn).toBeFocused();
  await expect(page).toHaveTitle(/.+/);
  // One main landmark, with the id the route announcer focuses.
  await expect(page.locator('main#main-content')).toHaveCount(1);
});

test('at a phone width the admin route never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/admin/review-queue');
  await expect(page.getByRole('button', { name: /sign in with microsoft/i })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test('the admin bundle keeps the identity library off public routes', async ({ page }) => {
  // The public home page must not load MSAL (msal-not-on-public-routes.test.js
  // pins the import graph; this pins the network).
  const scripts = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(scripts.some((url) => /vendor-msal/.test(url))).toBe(false);
});
