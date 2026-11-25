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
import { toMarkdown } from './audit-pages-report.mjs';
import { PROVIDER_NAMES, judgeRecord } from './audit-pages-verdict.mjs';

// The verdict and the report live in sibling modules (#1845); the verdict's
// pure functions are re-exported so audit-published-pages.test.js imports
// from one place.
export { decideEmptiness, judgeRecord } from './audit-pages-verdict.mjs';

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

const API_HOST = 'api-azure.hybridcloudworks.com';

/** Every fetch outside the browser is bounded, so a hung host stalls one
 * request, not a lane and not the 40-minute workflow. */
const FETCH_TIMEOUT_MS = 15000;

/** The site's own empty-state copy (grep of frontend/src, 2026-09-06). */
const EMPTY_COPY = [
  'No episodes available yet.',
  'Coming Soon',
  'coming soon',
  'Nothing here.',
  'No articles in this category yet.',
  'No content available.',
  'Check back soon for updates.',
  'No published frameworks found for',
  's published yet.',
];

/**
 * Failures the repository has already decided to live with. They are recorded
 * on the page (notes) but do not make it a defect, because re-raising a
 * decided item on every crawl is noise that hides the next real one. Each
 * entry names the decision.
 */
const KNOWN_ACCEPTED = [
  {
    match: (u) => /\/data\/(certifications|speakerevents)\.json$/.test(u),
    note: 'static data snapshot absent (issue #175: Cloudflare challenges the CI generator; the page falls back to the API at runtime)',
  },
];

/**
 * A request the browser cancelled rather than one the network failed to
 * serve. See the `requestfailed` handler for why this is not a defect.
 */
export const CANCELLED_REQUEST = /net::ERR_ABORTED/i;

/** Console noise that is not a page defect. Keep this list short and named. */
const CONSOLE_IGNORE = [/Third-party cookie will be blocked/i, /favicon\.ico/i];

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

/**
 * Is the media reachable? HEAD first; hosts that refuse HEAD (405/501) or
 * Range-on-HEAD get one ranged GET, which costs a single byte, so a host
 * that serves audio fine is never reported as "not served".
 */
async function mediaStatus(url) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if ([200, 206].includes(head.status)) return head.status;
    if (![405, 501, 403, 416].includes(head.status)) return head.status;
  } catch {
    // fall through to the ranged GET
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await res.body?.cancel?.();
    return res.status;
  } catch {
    return 0;
  }
}

/** A page's record before anything is seen: every field the JSON report carries. */
function newRecord(url) {
  return {
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
}

/** Console errors the page logs, less the named noise and accepted failures. */
function recordConsole(record, msg) {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (CONSOLE_IGNORE.some((re) => re.test(text))) return;
  // A "Failed to load resource" for a request the repository has already
  // accepted (KNOWN_ACCEPTED) is the same fact twice; the note covers it.
  const at = msg.location()?.url || '';
  if (at && KNOWN_ACCEPTED.some((k) => k.match(at))) return;
  record.consoleErrors.push(text.slice(0, 300));
}

// One shape for every entry in failedRequests / apiFailures:
// { url, kind: 'network' | 'http', status: number | null, error: string | null }.

/** A request the network failed to serve. */
function recordRequestFailed(record, req) {
  const error = req.failure()?.errorText || 'failed';
  // A cancelled request is not a failed one. Chromium reports
  // `net::ERR_ABORTED` when the browser drops a request in flight — the
  // crawler navigating away, the page closing, or the app's own
  // AbortController firing on unmount. On 2026-09-07 this made the home page
  // a defect for `public/platform-health`, which answered 200 with a valid
  // body when asked directly a minute later. Recording it as a defect hides
  // the next real one, which is the whole reason KNOWN_ACCEPTED exists.
  if (CANCELLED_REQUEST.test(error)) return;
  record.failedRequests.push({ url: req.url(), kind: 'network', status: null, error });
}

/** A response of 400 or above: an accepted failure's note, an API failure, or a failed request. */
function recordResponse(record, res) {
  const st = res.status();
  if (st < 400) return;
  const u = res.url();
  const entry = { url: u, kind: 'http', status: st, error: null };
  const accepted = KNOWN_ACCEPTED.find((k) => k.match(u));
  if (accepted) {
    if (!record.notes.includes(accepted.note)) record.notes.push(accepted.note);
    record.acceptedFailures += 1;
    return;
  }
  if (new URL(u).host === API_HOST) record.apiFailures.push(entry);
  else record.failedRequests.push(entry);
}

/** Wire the page's events to the record before it navigates. */
function watchPage(page, record) {
  page.on('console', (msg) => recordConsole(record, msg));
  page.on('pageerror', (err) => record.pageErrors.push(String(err?.message || err).slice(0, 300)));
  page.on('requestfailed', (req) => recordRequestFailed(record, req));
  page.on('response', (res) => recordResponse(record, res));
}

/** Navigate, waiting for the network to settle, or for the DOM when it never does. */
async function openPage(page, url) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
  }
  return response;
}

/** What the rendered document shows. The callback runs inside the page. */
function readDom(page) {
  return page.evaluate(
    ({ emptyCopy }) => {
      const q = (s) => document.querySelector(s);
      const main = q('main') || document.body;
      const text = (main?.innerText || '').replace(/\s+/g, ' ').trim();
      const themed = document.querySelector('[class*="theme-"]');
      const themeClass = themed ? (themed.className.match(/\btheme-[a-z]+\b/) || [''])[0] : '';
      return {
        title: document.title || '',
        ogTitle: q('meta[property="og:title"]')?.getAttribute('content') || '',
        canonical: q('link[rel="canonical"]')?.getAttribute('href') || '',
        themeClass,
        h1: (q('h1')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        mainChars: text.length,
        emptyCopy: emptyCopy.filter((c) => text.includes(c)),
        brokenImages: [...document.images]
          .filter((img) => img.complete && img.naturalWidth === 0 && img.getAttribute('src'))
          .map((img) => img.getAttribute('src'))
          .slice(0, 10),
        media: [
          ...document.querySelectorAll(
            'audio[src], audio source[src], video[src], video source[src]'
          ),
        ]
          .map((el) => el.getAttribute('src'))
          .filter(Boolean)
          .slice(0, 10),
      };
    },
    { emptyCopy: EMPTY_COPY }
  );
}

/** Load the page and fill the record from it; a navigation that throws is a page error. */
async function inspectPage(page, url, record) {
  try {
    const response = await openPage(page, url);
    record.status = response ? response.status() : null;
    await page.waitForTimeout(1500);

    const dom = await readDom(page);
    Object.assign(record, dom);

    record.media = await Promise.all(
      dom.media.map(async (src) => {
        const abs = new URL(src, url).href;
        return { url: abs, status: await mediaStatus(abs) };
      })
    );
  } catch (error) {
    record.pageErrors.push(`navigation: ${String(error?.message || error).slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function auditPage(context, url) {
  const page = await context.newPage();
  const record = newRecord(url);
  watchPage(page, record);
  await inspectPage(page, url, record);
  judgeRecord(record);
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
