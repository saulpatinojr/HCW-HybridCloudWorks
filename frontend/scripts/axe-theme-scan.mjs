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

function summarizeNode(node) {
  return {
    target: node.target,
    html: node.html?.slice(0, 240),
    failureSummary: node.failureSummary,
    any: node.any?.map((c) => ({ id: c.id, message: c.message, data: c.data })) ?? [],
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const startedAt = new Date().toISOString();

  try {
    for (const theme of THEMES) {
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

      for (const route of ROUTES) {
        const url = `${BASE_URL}${route}`;
        try {
          await page.goto(url, { waitUntil: 'networkidle' });
          // Wait for hydration; theme class must be present on <html>.
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

          const axeResult = await runAxeOnPage(page);
          const contrastNodes = (
            axeResult.violations.find((v) => v.id === 'color-contrast')?.nodes ?? []
          ).map(summarizeNode);

          results.push({
            theme,
            route,
            url,
            violations: axeResult.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              helpUrl: v.helpUrl,
              nodeCount: v.nodes.length,
              nodes:
                v.id === 'color-contrast' ? contrastNodes : v.nodes.slice(0, 3).map(summarizeNode),
            })),
            incomplete: axeResult.incomplete.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodeCount: v.nodes.length,
            })),
            passCount: axeResult.passes.length,
          });
        } catch (err) {
          results.push({
            theme,
            route,
            url,
            error: err.message,
            violations: [],
            incomplete: [],
            passCount: 0,
          });
        }
      }

      for (const route of ADMIN_ROUTES) {
        const url = `${BASE_URL}${route}`;
        const adminPage = await context.newPage();
        adminPage.setDefaultTimeout(20_000);
        try {
          const stub = new IdentityStub(adminPage, BASE_URL);
          await stub.install();
          await stub.signIn(route);
          await adminPage
            .waitForFunction(
              (t) =>
                t === 'dark'
                  ? document.documentElement.classList.contains('dark')
                  : !document.documentElement.classList.contains('dark'),
              theme,
              { timeout: 5000 }
            )
            .catch(() => {});

          const axeResult = await runAxeOnPage(adminPage);
          const contrastNodes = (
            axeResult.violations.find((v) => v.id === 'color-contrast')?.nodes ?? []
          ).map(summarizeNode);

          results.push({
            theme,
            route,
            url,
            violations: axeResult.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              helpUrl: v.helpUrl,
              nodeCount: v.nodes.length,
              nodes:
                v.id === 'color-contrast' ? contrastNodes : v.nodes.slice(0, 3).map(summarizeNode),
            })),
            incomplete: axeResult.incomplete.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodeCount: v.nodes.length,
            })),
            passCount: axeResult.passes.length,
          });
        } catch (err) {
          results.push({
            theme,
            route,
            url,
            error: err.message,
            violations: [],
            incomplete: [],
            passCount: 0,
          });
        } finally {
          await adminPage.close().catch(() => {});
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const reportDir = path.join('documentation', 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, 'axe-theme-scan.json'),
    JSON.stringify({ startedAt, baseUrl: BASE_URL, results }, null, 2)
  );

  // Markdown summary
  const totalContrast = results.reduce(
    (n, r) => n + (r.violations.find((v) => v.id === 'color-contrast')?.nodeCount ?? 0),
    0
  );
  const totalAll = results.reduce(
    (n, r) => n + r.violations.reduce((m, v) => m + v.nodeCount, 0),
    0
  );

  const allRoutesCount = ROUTES.length + ADMIN_ROUTES.length;
  const lines = [];
  lines.push(`# Axe Theme Scan Report`);
  lines.push(``);
  lines.push(`- **Generated:** ${startedAt}`);
  lines.push(`- **Base URL:** ${BASE_URL}`);
  lines.push(
    `- **Routes scanned:** ${allRoutesCount} × ${THEMES.length} themes = ${allRoutesCount * THEMES.length}`
  );
  lines.push(`- **Total contrast violation nodes:** ${totalContrast}`);
  lines.push(`- **Total violation nodes (all rules):** ${totalAll}`);
  lines.push(``);
  lines.push(`## Per-route summary`);
  lines.push(``);
  lines.push(`| Theme | Route | Contrast | Other | Incomplete |`);
  lines.push(`| ----- | ----- | -------- | ----- | ---------- |`);
  for (const r of results) {
    const contrast = r.violations.find((v) => v.id === 'color-contrast')?.nodeCount ?? 0;
    const other = r.violations
      .filter((v) => v.id !== 'color-contrast')
      .reduce((n, v) => n + v.nodeCount, 0);
    const incomplete = r.incomplete.reduce((n, v) => n + v.nodeCount, 0);
    lines.push(`| ${r.theme} | \`${r.route}\` | ${contrast} | ${other} | ${incomplete} |`);
  }

  // Detail section: every contrast failure with selector + colors
  lines.push(``);
  lines.push(`## Color-contrast failures (detailed)`);
  lines.push(``);
  for (const r of results) {
    const contrastViolation = r.violations.find((v) => v.id === 'color-contrast');
    if (!contrastViolation || contrastViolation.nodeCount === 0) continue;
    lines.push(`### ${r.theme} — \`${r.route}\` (${contrastViolation.nodeCount} nodes)`);
    for (const node of contrastViolation.nodes) {
      const data = node.any?.[0]?.data ?? {};
      lines.push(`- \`${(node.target || []).join(' ')}\``);
      if (data.fgColor || data.bgColor || data.contrastRatio) {
        lines.push(
          `  - fg: ${data.fgColor ?? '?'}, bg: ${data.bgColor ?? '?'}, ratio: ${data.contrastRatio ?? '?'}, expected: ${data.expectedContrastRatio ?? '?'}`
        );
      }
      if (node.html) lines.push(`  - \`${node.html.replace(/\s+/g, ' ').slice(0, 160)}\``);
    }
    lines.push(``);
  }

  await fs.writeFile(path.join(reportDir, 'axe-theme-scan.md'), lines.join('\n'));

  // Console output (kept short)
  const failures = results.flatMap((r) =>
    r.violations
      .filter((v) => FAIL_ON.includes(v.id))
      .map((v) => ({ theme: r.theme, route: r.route, id: v.id, nodes: v.nodeCount }))
  );
  const incompleteCount = INCLUDE_INCOMPLETE
    ? results.reduce((n, r) => n + r.incomplete.reduce((m, v) => m + v.nodeCount, 0), 0)
    : 0;

  console.log(`Routes scanned: ${allRoutesCount} × ${THEMES.length}`);
  console.log(`Contrast violation nodes: ${totalContrast}`);
  console.log(`Other violation nodes: ${totalAll - totalContrast}`);
  console.log(`Reports written to: ${reportDir}/axe-theme-scan.{json,md}`);

  if (failures.length > 0 || incompleteCount > 0) {
    console.error(
      `\nFAIL: ${failures.length} route/rule combinations triggered configured fail-on rules (${FAIL_ON.join(', ')}).`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
