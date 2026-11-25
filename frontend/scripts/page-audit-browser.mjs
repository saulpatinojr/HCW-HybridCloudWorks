/**
 * What the published pages audit does inside the browser for one page:
 * listen for failures, load it, and copy what the page shows into the
 * page's record. Split out of audit-published-pages.mjs.
 */
import {
  API_HOST,
  CANCELLED_REQUEST,
  CONSOLE_IGNORE,
  EMPTY_COPY,
  FETCH_TIMEOUT_MS,
  KNOWN_ACCEPTED,
} from './page-audit-rules.mjs';

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

/** Records the page's console errors, script errors and failed requests as they happen. */
export function listenForFailures(page, record) {
  page.on('console', (msg) => recordConsoleError(record, msg));
  page.on('pageerror', (err) => record.pageErrors.push(String(err?.message || err).slice(0, 300)));
  // One shape for every entry in failedRequests / apiFailures:
  // { url, kind: 'network' | 'http', status: number | null, error: string | null }.
  page.on('requestfailed', (req) => {
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
  });
  page.on('response', (res) => recordFailedResponse(record, res));
}

function recordConsoleError(record, msg) {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (CONSOLE_IGNORE.some((re) => re.test(text))) return;
  // A "Failed to load resource" for a request the repository has already
  // accepted (KNOWN_ACCEPTED) is the same fact twice; the note covers it.
  const at = msg.location()?.url || '';
  if (at && KNOWN_ACCEPTED.some((k) => k.match(at))) return;
  record.consoleErrors.push(text.slice(0, 300));
}

function recordFailedResponse(record, res) {
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

/** Opens the page, waits for it to settle, and copies what the DOM shows into the record. */
export async function loadPage(page, url, record) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
  }
  record.status = response ? response.status() : null;
  await page.waitForTimeout(1500);

  const dom = await page.evaluate(
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
  Object.assign(record, dom);

  record.media = await Promise.all(
    dom.media.map(async (src) => {
      const abs = new URL(src, url).href;
      return { url: abs, status: await mediaStatus(abs) };
    })
  );
}
