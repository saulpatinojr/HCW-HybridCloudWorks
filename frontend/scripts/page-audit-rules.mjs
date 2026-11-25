/**
 * How the published pages audit judges a page: the lists it checks against,
 * the emptiness and console rules, the provider checks, and the Markdown
 * report. Pure functions and constants only. Split out of
 * audit-published-pages.mjs, which explains the audit in its header and
 * re-exports `CANCELLED_REQUEST` and `decideEmptiness`.
 */

export const API_HOST = 'api-azure.hybridcloudworks.com';

/** Every fetch outside the browser is bounded, so a hung host stalls one
 * request, not a lane and not the 40-minute workflow. */
export const FETCH_TIMEOUT_MS = 15000;

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

/** The site's own empty-state copy (grep of frontend/src, 2026-09-06). */
export const EMPTY_COPY = [
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
export const KNOWN_ACCEPTED = [
  {
    match: (u) => /\/data\/(certifications|speakerevents)\.json$/.test(u),
    note: 'static data snapshot absent (issue #175: Cloudflare challenges the CI generator; the page falls back to the API at runtime)',
  },
];

/**
 * A request the browser cancelled rather than one the network failed to
 * serve. See the `requestfailed` handler (page-audit-browser.mjs) for why
 * this is not a defect.
 */
export const CANCELLED_REQUEST = /net::ERR_ABORTED/i;

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

/** Console noise that is not a page defect. Keep this list short and named. */
export const CONSOLE_IGNORE = [/Third-party cookie will be blocked/i, /favicon\.ico/i];

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

/** Console errors by class, less the network lines an accepted failure explains. */
export function consoleFindings(record) {
  if (!record.consoleErrors.length) return;
  const f = record.findings;
  const byClass = new Map();
  for (const text of record.consoleErrors) {
    const c = classifyConsole(text);
    byClass.set(c, (byClass.get(c) || 0) + 1);
  }
  // Chromium's "Failed to load resource" line does not always carry the
  // resource URL, so the listener in page-audit-browser.mjs cannot always
  // match it to an accepted failure. Each accepted failed response accounts
  // for at most one such line; the remainder is a real finding.
  if (byClass.has('network-failed') && record.acceptedFailures > 0) {
    const left = byClass.get('network-failed') - record.acceptedFailures;
    if (left > 0) byClass.set('network-failed', left);
    else byClass.delete('network-failed');
  }
  record.consoleClasses = [...byClass.keys()];
  for (const [c, n] of byClass) f.push(`console ${c}: ${n}`);
}

/** The page's title, og:title and theme class against the provider in its URL. */
export function providerFindings(record) {
  const f = record.findings;
  const names = PROVIDER_NAMES[record.provider].map((n) => n.toLowerCase());
  const has = (s) =>
    names.some((n) =>
      String(s || '')
        .toLowerCase()
        .includes(n)
    );
  // A blog post's title is the article's, not the section's; the section
  // pages and landings are where the provider name is expected. The theme
  // class is checked everywhere — that is the #183 symptom.
  const isDetail = /\/blog\/[^/]+$/.test(record.path);
  const titleOk = isDetail || has(record.title);
  const ogOk = isDetail || !record.ogTitle || has(record.ogTitle);
  const themeOk = !record.themeClass || record.themeClass === `theme-${record.provider}`;
  if (!titleOk) f.push(`title lacks provider name: "${record.title}"`);
  if (!ogOk) f.push(`og:title lacks provider name: "${record.ogTitle}"`);
  if (!themeOk) f.push(`theme class ${record.themeClass} on a ${record.provider} URL`);
}

/** A table cell: backslashes first, then pipes, so neither breaks the row. */
function escapeCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export function toMarkdown(records, meta) {
  const counts = { works: 0, empty: 0, defect: 0 };
  for (const r of records) counts[r.verdict] += 1;
  const lines = [
    `# Published pages audit — ${meta.startedAt.slice(0, 10)}`,
    '',
    `Base: ${meta.baseUrl} · sitemap entries: ${meta.sitemapTotal} (${meta.sitemapDuplicates} duplicate) · URLs crawled: ${records.length} · works ${counts.works} · empty ${counts.empty} · defect ${counts.defect}`,
    '',
    '| Path | HTTP | Verdict | Findings |',
    '| --- | ---: | --- | --- |',
  ];
  for (const r of records) {
    const cells = [...r.findings, ...r.notes.map((n) => `note: ${n}`)];
    lines.push(
      `| \`${r.path}\` | ${r.status ?? '—'} | **${r.verdict}** | ${escapeCell(cells.join('; ')) || '—'} |`
    );
  }
  lines.push('', '## Defect classes', '');
  const classes = new Map();
  for (const r of records) {
    if (r.verdict !== 'defect') continue;
    for (const finding of r.findings) {
      const key = finding
        .split(': ')[0]
        .replace(/\s+\d+$/, '')
        .replace(/ lacks .*$/, ' lacks provider name');
      if (!classes.has(key)) classes.set(key, []);
      classes.get(key).push(r.path);
    }
  }
  if (classes.size === 0) lines.push('None.');
  for (const [key, paths] of classes) {
    lines.push(
      `- **${key}** — ${paths.length} page(s): ${paths
        .slice(0, 12)
        .map((p) => `\`${p}\``)
        .join(', ')}${paths.length > 12 ? ', …' : ''}`
    );
  }
  return lines.join('\n') + '\n';
}
