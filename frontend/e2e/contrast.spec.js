/**
 * Failsafe contrast guardrail.
 *
 * For each public route × {light, dark}, inject axe-core and assert zero
 * `color-contrast` violations. Run via:
 *   npm run test:e2e -- contrast.spec.js
 *
 * Companion to scripts/axe-theme-scan.mjs (which produces the full report).
 * This spec is the CI gate; the script is the diagnostic tool.
 */
import { createRequire } from 'node:module';
import { test, expect } from './fixtures/entra.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const ADMIN_ROUTES = ['/admin', '/admin/review-queue', '/admin/health'];

const PROVIDERS = ['aws', 'azure', 'gcp', 'github', 'terraform', 'finops', 'docker'];

// Every provider that `ProviderEducationDispatcher` in App.jsx routes to its
// own hub. Covering one of them was not enough: `/aws/education` was the only
// education route here while five sibling hubs carried bare `text-white`
// headings — white on `--background: 0 0% 100%` — and the gate said nothing,
// because the gate never opened those pages.
const EDUCATION_PROVIDERS = [
  'aws',
  'azure',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
];

// Smaller route set than the full scan: covers each layout/template once.
// The full scan runs separately as `npm run a11y:contrast`.
const ROUTES = [
  '/',
  '/about',
  '/contact',
  ...PROVIDERS.map((p) => `/${p}`),
  '/aws/blog',
  '/aws/architecture-designs',
  '/aws/frameworks',
  // The Learn index: nine provider tiles, each with a "Catalogue checked
  // against …" line that read 3.28:1 in light mode until 2026-09-29, while
  // every hub it links to was covered below and this page was not.
  '/education',
  ...EDUCATION_PROVIDERS.map((p) => `/${p}/education`),
  // The detail templates behind those hubs — one certification page per
  // provider that has one, plus the microcredential template.
  '/aws/education/clf-c02',
  '/azure/education/az-900',
  '/aws/education/microcredentials/aws-serverless-demonstrated',
  '/aws/audio-architecture',
  '/github/news',
  '/github/code',
  '/finops/tools',
  '/tools/migration',
  '/tools/comparison',
  '/templates/framework',
];

const THEMES = ['light', 'dark'];

for (const theme of THEMES) {
  test.describe(`color-contrast (${theme})`, () => {
    test.use({ colorScheme: theme });

    for (const route of ROUTES) {
      const testName = route === '/' ? 'root-home-page' : route;
      test(`${testName}`, async ({ page, context }) => {
        await context.addInitScript((selectedTheme) => {
          try {
            window.localStorage.setItem('hcw-theme', selectedTheme);
          } catch {
            /* storage may be unavailable */
          }
        }, theme);

        await page.goto(route, { waitUntil: 'networkidle' });
        await page
          .waitForFunction(
            (t) =>
              t === 'dark'
                ? document.documentElement.classList.contains('dark')
                : !document.documentElement.classList.contains('dark'),
            theme,
            { timeout: 5000 }
          )
          .catch(() => {});

        await page.addScriptTag({ path: AXE_PATH });

        const result = await page.evaluate(async () => {
          return window.axe.run(document, {
            runOnly: { type: 'rule', values: ['color-contrast'] },
          });
        });

        const violations = result.violations.flatMap((v) =>
          v.nodes.map((n) => ({
            target: n.target,
            ratio: n.any?.[0]?.data?.contrastRatio,
            expected: n.any?.[0]?.data?.expectedContrastRatio,
            fg: n.any?.[0]?.data?.fgColor,
            bg: n.any?.[0]?.data?.bgColor,
            html: n.html?.slice(0, 160),
          }))
        );

        expect(
          violations,
          `\nContrast violations on ${theme} ${route}:\n${JSON.stringify(violations, null, 2)}`
        ).toEqual([]);
      });
    }
  });

  test.describe(`authenticated admin color-contrast (${theme})`, () => {
    test.use({ colorScheme: theme });

    for (const route of ADMIN_ROUTES) {
      test(`${route}`, async ({ page, context, identity }) => {
        await context.addInitScript((selectedTheme) => {
          try {
            window.localStorage.setItem('hcw-theme', selectedTheme);
          } catch {
            /* storage may be unavailable */
          }
        }, theme);

        await identity.signIn(route);
        await page
          .waitForFunction(
            (t) =>
              t === 'dark'
                ? document.documentElement.classList.contains('dark')
                : !document.documentElement.classList.contains('dark'),
            theme,
            { timeout: 5000 }
          )
          .catch(() => {});

        await page.addScriptTag({ path: AXE_PATH });

        const result = await page.evaluate(async () => {
          return window.axe.run(document, {
            runOnly: { type: 'rule', values: ['color-contrast'] },
          });
        });

        const violations = result.violations.flatMap((v) =>
          v.nodes.map((n) => ({
            target: n.target,
            ratio: n.any?.[0]?.data?.contrastRatio,
            expected: n.any?.[0]?.data?.expectedContrastRatio,
            fg: n.any?.[0]?.data?.fgColor,
            bg: n.any?.[0]?.data?.bgColor,
            html: n.html?.slice(0, 160),
          }))
        );

        expect(
          violations,
          `\nContrast violations on admin ${theme} ${route}:\n${JSON.stringify(violations, null, 2)}`
        ).toEqual([]);
      });
    }
  });
}

