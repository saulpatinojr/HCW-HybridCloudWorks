#!/usr/bin/env node
/**
 * Site-wide accessibility contrast scanner.
 *
 * Crawls every public route in both light and dark themes, runs axe-core
 * (WCAG 2.0/2.1 A + AA), and writes:
 *   - documentation/reports/axe-theme-scan.json   (full violations payload)
 *   - documentation/reports/axe-theme-scan.md     (human-readable summary)
 *
 * Exits non-zero if any color-contrast violation is found, so CI can gate on it.
 *
 * Usage:
 *   # Start a preview server first (or set BASE_URL):
 *   npm run build && npm run preview &
 *   node scripts/axe-theme-scan.mjs
 *
 * Env:
 *   BASE_URL              default: http://127.0.0.1:4173
 *   AXE_FAIL_ON           rules that should fail the run, comma separated
 *                         default: color-contrast
 *   AXE_INCLUDE_INCOMPLETE 'true' to count "incomplete" as violations too
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { IdentityStub } from '../e2e/fixtures/entra.js';
import { buildMarkdown, errorResult, routeResult } from './axe-theme-report.mjs';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const FAIL_ON = (process.env.AXE_FAIL_ON || 'color-contrast')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_INCOMPLETE = process.env.AXE_INCLUDE_INCOMPLETE === 'true';

const PROVIDERS = ['aws', 'azure', 'gcp', 'github', 'terraform', 'finops'];

// Authenticated admin routes covered for colour-contrast (AP-F9).
const ADMIN_ROUTES = ['/admin', '/admin/review-queue', '/admin/health'];

// All publicly reachable routes (no auth required).
const ROUTES = [
  '/',
  '/about',
  '/contact',
  '/login',
  '/not-found-deliberate',
  // The Learn index (its catalogue lines failed contrast until 2026-09-29).
  '/education',
  // Provider landing + standard subpages
  ...PROVIDERS.flatMap((p) => [
    `/${p}`,
    `/${p}/blog`,
    `/${p}/architecture-designs`,
    `/${p}/frameworks`,
    `/${p}/code`,
    `/${p}/education`,
    `/${p}/audio-architecture`,
    `/${p}/news`,
  ]),
  // Provider-specific extras
  '/azure/frameworks-pillars',
  '/finops/tools',
  '/finops/focus',
  '/finops/architectures',
  '/terraform/code',
  '/terraform/modules',
  '/terraform/tools',
  '/github/workflows',
  '/github/code',
  '/github/tools',
  // Tools
  '/tools/migration',
  '/tools/comparison',
  '/tools/resources',
  '/tools/decisions',
  // Templates
  '/templates/framework',
  '/templates/architecture',
  '/templates/blog',
  '/templates/coder-corner',
  '/templates/rosetta-stone',
];

const THEMES = ['light', 'dark'];

async function runAxeOnPage(page) {
  await page.addScriptTag({
    path: AXE_PATH,
  });
  return page.evaluate(async () => {
    const runOnly = { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] };
    return window.axe.run(document, { runOnly });
  });
}

/**
 * Wait until the page shows the requested theme: the `dark` class on <html>
 * for dark, and its absence for light. Hydration sets it, so this also waits
 * for the app to start.
 */
function waitForTheme(page, theme) {
  return page.waitForFunction(
    (t) =>
      t === 'dark'
        ? document.documentElement.classList.contains('dark')
        : !document.documentElement.classList.contains('dark'),
    theme,
    { timeout: 5000 }
  );
}

/** One public route, on the theme's shared page. */
async function scanPublicRoute(page, theme, route) {
  const url = `${BASE_URL}${route}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    // Wait for hydration; theme class must be present on <html>.
    await waitForTheme(page, theme);
    return routeResult(theme, route, url, await runAxeOnPage(page));
  } catch (err) {
    return errorResult(theme, route, url, err);
  }
}

/** One admin route, on a page of its own that is signed in first. */
async function scanAdminRoute(context, theme, route) {
  const url = `${BASE_URL}${route}`;
  const adminPage = await context.newPage();
  adminPage.setDefaultTimeout(20_000);
  try {
    const stub = new IdentityStub(adminPage, BASE_URL);
    await stub.install();
    await stub.signIn(route);
    await waitForTheme(adminPage, theme);
    return routeResult(theme, route, url, await runAxeOnPage(adminPage));
  } catch (err) {
    return errorResult(theme, route, url, err);
  } finally {
    await adminPage.close().catch(() => {});
  }
}

/** Every route, public then admin, in one theme. */
async function scanTheme(browser, theme) {
  const results = [];
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
  });

  // Force the saved-theme path so the pre-hydration script in index.html
  // applies the requested theme deterministically.
  await context.addInitScript((selectedTheme) => {
    try {
      window.localStorage.setItem('hcw-theme', selectedTheme);
    } catch {
      /* storage may be unavailable */
    }
  }, theme);

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  for (const route of ROUTES) results.push(await scanPublicRoute(page, theme, route));
  for (const route of ADMIN_ROUTES) results.push(await scanAdminRoute(context, theme, route));

  await context.close();
  return results;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const startedAt = new Date().toISOString();

  try {
    for (const theme of THEMES) results.push(...(await scanTheme(browser, theme)));
  } finally {
    await browser.close();
  }

  const reportDir = path.join('documentation', 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, 'axe-theme-scan.json'),
    JSON.stringify({ startedAt, baseUrl: BASE_URL, results }, null, 2)
  );

  const allRoutesCount = ROUTES.length + ADMIN_ROUTES.length;
  const { markdown, totalContrast, totalAll } = buildMarkdown(results, {
    startedAt,
    baseUrl: BASE_URL,
    routeCount: allRoutesCount,
    themeCount: THEMES.length,
  });
  await fs.writeFile(path.join(reportDir, 'axe-theme-scan.md'), markdown);

  // Console output (kept short)
  const failures = results.flatMap((r) =>
    r.violations
      .filter((v) => FAIL_ON.includes(v.id))
      .map((v) => ({ theme: r.theme, route: r.route, id: v.id, nodes: v.nodeCount }))
  );
  const errors = results.filter((r) => r.error);
  const incompleteCount = INCLUDE_INCOMPLETE
    ? results.reduce((n, r) => n + r.incomplete.reduce((m, v) => m + v.nodeCount, 0), 0)
    : 0;

  console.log(`Routes scanned: ${allRoutesCount} × ${THEMES.length}`);
  console.log(`Contrast violation nodes: ${totalContrast}`);
  console.log(`Other violation nodes: ${totalAll - totalContrast}`);
  if (errors.length > 0) {
    console.error(`Route errors: ${errors.length}`);
    for (const e of errors) {
      console.error(`  - [${e.theme}] ${e.route}: ${e.error}`);
    }
  }
  console.log(`Reports written to: ${reportDir}/axe-theme-scan.{json,md}`);

  if (failures.length > 0 || incompleteCount > 0 || errors.length > 0) {
    console.error(
      `\nFAIL: Scan encountered failures (failures: ${failures.length}, incomplete: ${incompleteCount}, errors: ${errors.length}).`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
