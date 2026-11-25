/**
 * Parse an official certification study guide into weighted skill areas.
 *
 * One Listen & Learn episode is produced per *skill area* — the top-level
 * functional groups an exam is scored against ("Manage Azure identities and
 * governance (20–25%)"). Everything downstream keys off this structure, so the
 * parser is deliberately strict: it throws rather than silently returning a
 * half-parsed guide, because an empty parse would otherwise publish five
 * confident, contentless episodes.
 *
 * Providers publish guides in different shapes, so parsing sits behind a
 * per-provider adapter. Microsoft Learn is the primary one because its guides
 * are consistently structured HTML — verified against live AZ-104, AZ-305 and
 * GH-500 pages. AWS exam guides span an index plus one page per domain, so
 * that adapter follows sub-pages.
 *
 * Ported from Site-Main `functions/listen-and-learn/studyguide.js` (088f458).
 * The parsing is unchanged — it is pure HTML work with no Firebase surface —
 * beyond the move to ESM and to this repository's cheerio import style.
 */
import { load as loadHtml } from 'cheerio';
import { clean, slugify, StudyGuideError, weightLabel } from './studyguide-text.js';
import { parseMicrosoftLearn } from './studyguide-learn.js';

// The shared text rules live in studyguide-text.js and the Microsoft Learn
// parser in studyguide-learn.js; exported again here so callers keep
// importing from studyguide.js.
export { slugify, StudyGuideError, weightLabel } from './studyguide-text.js';

/**
 * Phrases worth searching YouTube for, most specific first.
 *
 * Sub-headings beat the area name: "Manage Microsoft Entra users and groups"
 * finds teaching content, whereas "Manage Azure identities and governance"
 * mostly finds exam-cram overviews.
 */
export function searchTerms(area) {
  return [...area.subheadings, area.name];
}

/**
 * "Content Domain 1: Design Secure Architectures (30% of scored content)".
 *
 * AWS states a single percentage with trailing prose, where Microsoft states a
 * bare range — hence a separate pattern rather than one over-general regex
 * that would match stray parenthetical percentages elsewhere on the page.
 */
const AWS_DOMAIN =
  /^Content Domain\s+(?<index>\d+)\s*:\s*(?<name>.+?)\s*\(\s*(?<low>\d{1,3})\s*%\s*of scored content\s*\)\s*$/i;

/**
 * AWS writes task headings three different ways across current guides:
 *   "Task 1.1: Design secure access to AWS resources"        (SAA-C03)
 *   "Task Statement 1.1: Define the benefits of the AWS..."  (CLF-C02)
 *   "Task 1: Develop code for applications hosted on AWS"    (DVA-C02)
 * Matching only one spelling silently produced domains with zero objectives,
 * which reads on the page as a real but empty episode rather than an error.
 */
const AWS_TASK = /^Task(?:\s+Statement)?\s+\d+(?:\.\d+)?\s*:/i;

/**
 * AWS exam guides on docs.aws.amazon.com split across pages: the index lists
 * the weighted domains and links to one sub-page per domain, where the task
 * statements and their Knowledge/Skills bullets live. Objectives are what make
 * an episode specific, so the sub-pages are followed rather than skipped.
 */
async function parseAwsExamGuide(indexHtml, { examCode, sourceUrl, fetchPage }) {
  const $ = loadHtml(indexHtml);

  const seen = new Set();
  const domains = [];

  $('a').each((_, el) => {
    const match = AWS_DOMAIN.exec(clean($(el).text()));
    if (!match) return;
    const { index, name, low } = match.groups;
    if (seen.has(index)) return;
    seen.add(index);

    const href = $(el).attr('href');
    domains.push({
      name: clean(name),
      slug: slugify(name),
      weightLow: Number(low),
      weightHigh: null,
      // docs.aws.amazon.com links are relative to the index page.
      url: href ? new URL(href, sourceUrl).toString() : null,
      subheadings: [],
      objectives: [],
      sections: [],
    });
  });

  if (domains.length === 0) {
    throw new StudyGuideError(
      `No weighted content domains found in the exam guide for ${examCode}. ` +
        `The page layout may have changed: ${sourceUrl}`
    );
  }

  for (const domain of domains) {
    if (!domain.url || !fetchPage) continue;
    let domainHtml;
    try {
      domainHtml = await fetchPage(domain.url);
    } catch {
      // A domain page that will not load still yields a usable area from the
      // index — name and weighting — just without its task detail.
      continue;
    }
    collectAwsTasks(loadHtml(domainHtml), domain);
  }

  return {
    examCode: String(examCode).toUpperCase(),
    title: clean($('h1').first().text()) || `Exam guide for ${String(examCode).toUpperCase()}`,
    sourceUrl,
    // `url` is scaffolding for the sub-page fetch above and is dropped here;
    // the site has no use for a per-domain docs link.
    areas: domains.map(({ url: _url, ...area }) => ({
      ...area,
      weightLabel: weightLabel(area.weightLow, area.weightHigh),
    })),
  };
}

function collectAwsTasks($, domain) {
  let inTask = false;

  $('h2, h3, li').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = clean($(el).text());
    if (!text) return;

    if (tag === 'h2' || tag === 'h3') {
      inTask = AWS_TASK.test(text);
      // The nav "Topics" list repeats every task heading as a link; dedupe so
      // sub-headings are not doubled.
      if (inTask && !domain.subheadings.includes(text)) {
        domain.subheadings.push(text);
        domain.sections.push({ title: text, objectives: [] });
      }
      return;
    }

    // Bullets before the first Task heading belong to the page's own nav list.
    if (!inTask) return;
    if (AWS_TASK.test(text)) return;
    if (!domain.objectives.includes(text)) domain.objectives.push(text);
    const section = domain.sections.at(-1);
    if (section && !section.objectives.includes(text)) section.objectives.push(text);
  });
}

const PARSERS = {
  microsoft: { parse: parseMicrosoftLearn, multiPage: false },
  aws: { parse: parseAwsExamGuide, multiPage: true },
};

export const SUPPORTED_PROVIDERS = Object.keys(PARSERS);

/** Default page fetcher; overridden in tests and by callers that cache. */
async function defaultFetchPage(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'HybridCloudWorks/1.0' } });
  if (!response.ok) {
    throw new StudyGuideError(`Study guide fetch failed: HTTP ${response.status} for ${url}`, {
      status: response.status,
    });
  }
  // A retired exam does not 404 — Microsoft Learn quietly redirects it to the
  // credential browse page, which parses as a valid page with no skill areas.
  // Naming the redirect turns "the layout may have changed" into "this exam
  // is gone", which is the actual fix.
  if (response.redirected && new URL(response.url).pathname !== new URL(url).pathname) {
    throw new StudyGuideError(
      `Study guide for this exam redirected to ${response.url} — the exam is likely retired or the URL is stale (${url})`
    );
  }
  return response.text();
}

/**
 * Parse an already-fetched single-page guide. Kept for the Microsoft path and
 * for tests; AWS needs `fetchStudyGuide` because it spans several pages.
 */
export function parseStudyGuide(html, { provider, examCode, sourceUrl, fetchPage }) {
  const adapter = PARSERS[provider];
  if (!adapter) {
    const supported = Object.keys(PARSERS).sort().join(', ') || 'none';
    throw new StudyGuideError(
      `No study-guide parser for provider "${provider}". Supported: ${supported}.`
    );
  }
  return adapter.parse(html, { examCode, sourceUrl, fetchPage });
}

/** Fetch and parse a guide end to end, following sub-pages where needed. */
export async function fetchStudyGuide({
  provider,
  examCode,
  sourceUrl,
  fetchPage = defaultFetchPage,
}) {
  if (!sourceUrl) throw new StudyGuideError(`No study guide URL for ${examCode}`);
  const html = await fetchPage(sourceUrl);
  return parseStudyGuide(html, { provider, examCode, sourceUrl, fetchPage });
}
