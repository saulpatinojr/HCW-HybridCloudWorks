/**
 * audit-published-pages.mjs — every URL in the live sitemap, one verdict each.
 *
 * Issue #361: "a review of ALL published pages, as many are not working
 * correctly." This is the crawl that turns that sentence into a matrix. It is
 * an audit, not a gate: it always writes its report and exits 0 unless
 * --strict is passed, in which case a `defect` verdict exits 1.
 *
 * Per page it records, in a real browser (Playwright Chromium):
 *   1. The document's HTTP status.
 *   2. Every request that failed or answered 4xx/5xx, with the API host
 *      called out separately — a public-API failure is the most likely cause
 *      of "the page is not working".
 *   3. Console errors and uncaught page errors.
 *   4. Provider identity: the first path segment names a provider, and the
 *      title, og:title and theme class must agree with it (the #183 class of
 *      bug — VMware and Ansible pages once served Azure and GitHub titles).
 *   5. Empty state: the main region's text length and the site's own
 *      empty-state copy ("No episodes available yet.", "Coming Soon", ...).
 *   6. Broken images (loaded but zero natural width) and audio sources that
 *      do not answer 200/206.
 *
 * Verdicts:
 *   defect — HTTP ≠ 200, page error, console error, API or asset failure,
 *            provider mismatch, broken image or media.
 *   empty  — no defect, but the main region is thin or shows empty-state copy.
 *            Some pages are empty by configuration (aws/gcp/vmware podcasts
 *            until #349); the report says which, the issue decides.
 *   works  — none of the above.
 *
 * Usage:
 *   node scripts/audit-published-pages.mjs [--strict] [--limit N] [--only /azure]
 * Env:
 *   AUDIT_BASE_URL   default https://hybridcloudworks.com
 *   AUDIT_SITEMAP    default <base>/sitemap.xml
 *   AUDIT_OUT        default reports/page-audit   (gitignored: reports/)
 *   AUDIT_CHANNEL    optional Playwright browser channel (e.g. msedge)
 *   AUDIT_CONCURRENCY default 3
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { listenForFailures, loadPage } from './page-audit-browser.mjs';
import {
  FETCH_TIMEOUT_MS,
  PROVIDER_NAMES,
  consoleFindings,
  decideEmptiness,
  providerFindings,
  toMarkdown,
} from './page-audit-rules.mjs';

// The judging rules and report live in page-audit-rules.mjs and the
// in-browser steps in page-audit-browser.mjs. What this file exported before
// is re-exported here, so the test keeps one import path.
export { CANCELLED_REQUEST, decideEmptiness } from './page-audit-rules.mjs';

/**
 * Command line and environment → options. A pure function that throws on a
 * usage error, called from main(): importing this module (the tests do) must
 * never read argv or exit the process.
 */
export function parseOptions(argv, env) {
  const flag = (name) => argv.includes(name);
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const baseUrl = (env.AUDIT_BASE_URL || 'https://hybridcloudworks.com').replace(/\/$/, '');
  const concurrencyRaw = Number.parseInt(env.AUDIT_CONCURRENCY || '3', 10);
  // A bad or missing --limit value is a usage error, not "no limit".
  const limitRaw = opt('--limit', '0');
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 0 || String(limit) !== String(limitRaw).trim()) {
    throw new Error(`--limit expects a non-negative integer, got "${limitRaw}"`);
  }
  return {
    baseUrl,
    sitemap: env.AUDIT_SITEMAP || `${baseUrl}/sitemap.xml`,
    outDir: path.resolve(env.AUDIT_OUT || 'reports/page-audit'),
    channel: env.AUDIT_CHANNEL || undefined,
    concurrency:
      Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 ? Math.min(concurrencyRaw, 8) : 3,
    limit,
    only: opt('--only', ''),
    strict: flag('--strict'),
  };
}

/** Set by main() from parseOptions(); null while the module is merely imported. */
let options = null;

async function readSitemap() {
  const res = await fetch(options.sitemap, {
    headers: { 'User-Agent': 'HCW-page-audit/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sitemap ${options.sitemap} answered ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const all = locs.map((u) => (u.startsWith('http') ? u : `${options.baseUrl}${u}`));
  // The live sitemap has carried repeated <loc> entries; one verdict per URL
  // means one crawl per URL. The duplicate count is reported, because a
  // sitemap with repeats is itself a finding for whoever generates it.
  const unique = [...new Set(all)];
  sitemapStats.total = all.length;
  sitemapStats.duplicates = all.length - unique.length;
  const urls = unique.filter((u) => !options.only || new URL(u).pathname.startsWith(options.only));
  return options.limit ? urls.slice(0, options.limit) : urls;
}

const sitemapStats = { total: 0, duplicates: 0 };

function providerOf(url) {
  const seg = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
  return PROVIDER_NAMES[seg] ? seg : null;
}

async function auditPage(context, url) {
  const page = await context.newPage();
  const record = {
    url,
    path: new URL(url).pathname,
    provider: providerOf(url),
    status: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    apiFailures: [],
    title: '',
    ogTitle: '',
    canonical: '',
    themeClass: '',
    h1: '',
    mainChars: 0,
    emptyCopy: [],
    brokenImages: [],
    media: [],
    notes: [],
    acceptedFailures: 0,
    findings: [],
    verdict: 'works',
  };

  listenForFailures(page, record);

  try {
    await loadPage(page, url, record);
  } catch (error) {
    record.pageErrors.push(`navigation: ${String(error?.message || error).slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
  }

  // ── Findings ──────────────────────────────────────────────────────────
  const f = record.findings;
  // No document response (navigation threw, timed out, or the host was
  // unreachable) is its own class, not "http null": the page error above
  // carries the reason, and the row must not read as the site answering.
  if (record.status === null) f.push('no response');
  else if (record.status !== 200) f.push(`http ${record.status}`);
  if (record.pageErrors.length) f.push(`page errors: ${record.pageErrors.length}`);
  consoleFindings(record);
  if (record.apiFailures.length) {
    f.push(
      `API failures: ${record.apiFailures.map((a) => `${new URL(a.url).pathname}→${a.status}`).join(', ')}`
    );
  }
  if (record.failedRequests.length) f.push(`failed requests: ${record.failedRequests.length}`);
  if (record.provider) providerFindings(record);
  if (record.brokenImages.length) f.push(`broken images: ${record.brokenImages.length}`);
  const badMedia = record.media.filter((m) => ![200, 206].includes(m.status));
  if (badMedia.length) f.push(`media not served: ${badMedia.map((m) => m.status).join(',')}`);

  if (f.length) {
    record.verdict = 'defect';
  } else {
    const decision = decideEmptiness(record);
    record.verdict = decision.verdict;
    f.push(...decision.findings);
    record.notes.push(...decision.notes);
  }
  return record;
}

async function runPool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
      process.stdout.write(
        `${String(i + 1).padStart(3)}/${items.length} ${results[i].verdict.padEnd(6)} ${results[i].path}\n`
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return results;
}

async function main() {
  options = parseOptions(process.argv.slice(2), process.env);
  const startedAt = new Date().toISOString();
  const urls = await readSitemap();
  if (urls.length === 0) throw new Error('sitemap yielded no URLs');
  fs.mkdirSync(options.outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, channel: options.channel });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 HCW-page-audit/1.0',
    viewport: { width: 1366, height: 900 },
  });
  let records;
  try {
    records = await runPool(urls, (u) => auditPage(context, u), options.concurrency);
  } finally {
    await browser.close().catch(() => {});
  }

  const meta = {
    startedAt,
    baseUrl: options.baseUrl,
    sitemap: options.sitemap,
    sitemapTotal: sitemapStats.total,
    sitemapDuplicates: sitemapStats.duplicates,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(options.outDir, 'audit.json'),
    JSON.stringify({ meta, records }, null, 2)
  );
  fs.writeFileSync(path.join(options.outDir, 'audit.md'), toMarkdown(records, meta));
  const counts = records.reduce(
    (acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc),
    {}
  );
  console.log(
    `\nsitemap ${sitemapStats.total} entries (${sitemapStats.duplicates} duplicate) · works=${counts.works || 0} empty=${counts.empty || 0} defect=${counts.defect || 0} → ${options.outDir}`
  );
  if (options.strict && counts.defect) process.exit(1);
}

// Run only when executed directly, so the test file can import the pure
// helpers without starting a crawl.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`audit failed: ${error?.message || error}`);
    process.exit(2);
  });
}
