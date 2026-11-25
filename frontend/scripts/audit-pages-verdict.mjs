/**
 * How audit-published-pages.mjs turns what it saw on one page into a
 * verdict (moved out of that file by #1845): the empty-state thresholds,
 * the console error classes, the provider-name check and judgeRecord.
 * Pure functions, no browser: audit-published-pages.test.js calls them
 * through the entry's re-exports with hand-made records.
 */

/** First path segment → what the title/og:title must mention. */
export const PROVIDER_NAMES = {
  azure: ['Azure'],
  aws: ['AWS', 'Amazon Web Services'],
  gcp: ['Google Cloud', 'GCP'],
  github: ['GitHub'],
  terraform: ['Terraform'],
  finops: ['FinOps'],
  vmware: ['VMware'],
  ansible: ['Ansible'],
  docker: ['Docker'],
};

/** Below this many characters of main-region text a page is "thin". */
const THIN_MAIN_CHARS = 400;

/** Empty-state copy makes a page "empty" only below this much main text. */
const EMPTY_COPY_MAX_CHARS = 800;

/**
 * The emptiness verdict for a page with no defect, as a pure function so the
 * thresholds are testable (audit-published-pages.test.js):
 *
 *   - under THIN_MAIN_CHARS: `empty`, with the copy (when present) recorded
 *     beside the count — "Coming Soon" is a decision, a bare heading is
 *     missing content, and the row should say which;
 *   - from THIN_MAIN_CHARS up to EMPTY_COPY_MAX_CHARS with empty-state copy:
 *     `empty` — an empty listing with a header and a footer widget;
 *   - at or above EMPTY_COPY_MAX_CHARS with empty-state copy: `works`, and a
 *     note — one widget on a full page (the podcast panel on `/azure`, 2,000+
 *     chars around it). The post-deploy run of 2026-09-06 marked three
 *     landings "empty" on that alone, which is why the cutoff exists;
 *   - otherwise `works`.
 */
export function decideEmptiness({ mainChars, emptyCopy = [] }) {
  const copy = emptyCopy.length ? `empty-state copy: ${emptyCopy.join(' | ')}` : null;
  if (mainChars < THIN_MAIN_CHARS) {
    return {
      verdict: 'empty',
      findings: [`thin main region: ${mainChars} chars`, ...(copy ? [copy] : [])],
      notes: [],
    };
  }
  if (copy && mainChars < EMPTY_COPY_MAX_CHARS) {
    return { verdict: 'empty', findings: [copy], notes: [] };
  }
  if (copy) {
    return { verdict: 'works', findings: [], notes: [`a widget shows ${copy}`] };
  }
  return { verdict: 'works', findings: [], notes: [] };
}

/**
 * Named classes for console errors, so a site-wide error reads as one class
 * across 120 rows instead of 120 unrelated findings. Order matters: first
 * match wins; anything else is `console-other` and keeps its text in the JSON.
 */
const CONSOLE_CLASSES = [
  ['csp-inline-script', /violates the following Content Security Policy directive 'script-src/i],
  ['csp-other', /Content Security Policy/i],
  ['react-hydration-419', /Minified React error #419/],
  ['react-hydration-418', /Minified React error #418/],
  ['react-error', /Minified React error #\d+/],
  ['network-failed', /Failed to load resource/i],
];

function classifyConsole(text) {
  for (const [name, re] of CONSOLE_CLASSES) if (re.test(text)) return name;
  return 'console-other';
}

/**
 * The console errors as findings, one line per kind of error. Chromium's
 * "Failed to load resource" line does not always carry the resource URL, so
 * the page listener cannot always match it to an accepted failure. Each
 * accepted failed response accounts for at most one such line; the remainder
 * is a real finding. Also records the kinds seen on `record.consoleClasses`.
 */
function consoleFindings(record) {
  const byClass = new Map();
  for (const text of record.consoleErrors) {
    const c = classifyConsole(text);
    byClass.set(c, (byClass.get(c) || 0) + 1);
  }
  if (byClass.has('network-failed') && record.acceptedFailures > 0) {
    const left = byClass.get('network-failed') - record.acceptedFailures;
    if (left > 0) byClass.set('network-failed', left);
    else byClass.delete('network-failed');
  }
  record.consoleClasses = [...byClass.keys()];
  return [...byClass].map(([c, n]) => `console ${c}: ${n}`);
}

/**
 * Whether the title, og:title and theme class agree with the provider the
 * URL names (the #183 bug). A blog post's title is the article's, not the
 * section's; the section pages and landings are where the provider name is
 * expected. The theme class is checked everywhere — that is the #183 symptom.
 */
function providerFindings(record) {
  const names = PROVIDER_NAMES[record.provider].map((n) => n.toLowerCase());
  const has = (s) =>
    names.some((n) =>
      String(s || '')
        .toLowerCase()
        .includes(n)
    );
  const isDetail = /\/blog\/[^/]+$/.test(record.path);
  const findings = [];
  if (!isDetail && !has(record.title)) {
    findings.push(`title lacks provider name: "${record.title}"`);
  }
  if (!isDetail && record.ogTitle && !has(record.ogTitle)) {
    findings.push(`og:title lacks provider name: "${record.ogTitle}"`);
  }
  if (record.themeClass && record.themeClass !== `theme-${record.provider}`) {
    findings.push(`theme class ${record.themeClass} on a ${record.provider} URL`);
  }
  return findings;
}

/**
 * Turn what was seen on a page into findings and a verdict, in place: any
 * finding makes the page a `defect`; with none, decideEmptiness says whether
 * it is `empty` or `works`. Exported so a test can hand in a record without
 * starting a browser.
 */
export function judgeRecord(record) {
  const f = record.findings;
  // No document response (navigation threw, timed out, or the host was
  // unreachable) is its own class, not "http null": the page error recorded
  // during navigation carries the reason, and the row must not read as the
  // site answering.
  if (record.status === null) f.push('no response');
  else if (record.status !== 200) f.push(`http ${record.status}`);
  if (record.pageErrors.length) f.push(`page errors: ${record.pageErrors.length}`);
  if (record.consoleErrors.length) f.push(...consoleFindings(record));
  if (record.apiFailures.length) {
    f.push(
      `API failures: ${record.apiFailures.map((a) => `${new URL(a.url).pathname}→${a.status}`).join(', ')}`
    );
  }
  if (record.failedRequests.length) f.push(`failed requests: ${record.failedRequests.length}`);
  if (record.provider) f.push(...providerFindings(record));
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
