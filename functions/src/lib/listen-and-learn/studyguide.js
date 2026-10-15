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
import { AuthoredError } from '../http/error-response.js';

/**
 * "Manage Azure identities and governance (20–25%)" → name, low, high.
 * Microsoft uses an en dash; a plain hyphen and a single percentage
 * ("Monitor resources (15%)") both appear across providers.
 */
const HEADING_WEIGHT =
  /^(?<name>.+?)\s*\(\s*(?<low>\d{1,3})\s*(?:[-–—]\s*(?<high>\d{1,3})\s*)?%\s*\)\s*$/;

/** h2 sections that end the skills-measured region. */
const TERMINATORS = ['study resources', 'change log', 'related links'];

/** Summary list that repeats every area — parsing it would duplicate them all. */
const GLANCE = 'skills at a glance';

/** Containers whose list items are navigation or link tables, not objectives. */
const SKIPPED = 'nav, table, script, style';

const clean = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

/** `Manage Azure identities` → `manage-azure-identities`. */
export function slugify(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A study guide this module could not read, in its own sentence (a status,
 * a redirect, a layout with no weighted areas). Authored (#945): the job and
 * the episode store it as written.
 */
export class StudyGuideError extends AuthoredError {}

/** `20–25%`, `15%`, or `''` when the guide states no weighting. */
export function weightLabel(low, high) {
  if (low === null || low === undefined) return '';
  if (high === null || high === undefined || high === low) return `${low}%`;
  return `${low}–${high}%`;
}

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
 * Microsoft Learn `resources/study-guides/{exam}` pages have a stable shape
 * across Azure, GitHub and Microsoft 365 exams:
 *
 *   h2  Skills measured as of April 17, 2026
 *   h3  Skills at a glance                        <- summary list, skipped
 *   h3  Manage Azure identities and governance (20–25%)
 *   h4    Manage Microsoft Entra users and groups
 *   li      Create users and groups
 *   h2  Study resources                           <- ends the skills section
 */
function parseMicrosoftLearn(html, { examCode, sourceUrl }) {
  const $ = loadHtml(html);
  $(SKIPPED).remove();

  const areas = [];
  let current = null;
  let inGlance = false;

  const nodes = $('h2, h3, h4, li').toArray();

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    const text = clean($(node).text());
    if (!text) continue;
    const lowered = text.toLowerCase();

    if (tag === 'h2') {
      if (TERMINATORS.some((t) => lowered.startsWith(t))) break;
      inGlance = false;
      continue;
    }

    if (tag === 'h3') {
      inGlance = lowered.startsWith(GLANCE);
      const match = HEADING_WEIGHT.exec(text);
      if (match && !inGlance) {
        const { name, low, high } = match.groups;
        current = {
          name: clean(name),
          slug: slugify(name),
          // The heading's own `id`, read off the DOM rather than derived. Learn
          // builds its anchors from the WHOLE heading — "(20–25%)" becomes
          // "2025" — so `slugify(name)` cannot reproduce them, and a guessed
          // fragment would scroll the reader to the top of the page while
          // looking like a deep link. `null` when the page carries none; the
          // caller renders a plain link rather than a broken one (#498).
          anchor: $(node).attr('id') || null,
          weightLow: Number(low),
          weightHigh: high === undefined ? null : Number(high),
          subheadings: [],
          objectives: [],
          sections: [],
        };
        areas.push(current);
      } else if (!match) {
        // A non-weighted h3 (e.g. "Audience profile") ends the previous area
        // so its bullets are not absorbed as objectives.
        current = null;
      }
      continue;
    }

    if (!current || inGlance) continue;

    if (tag === 'h4') {
      if (!current.subheadings.includes(text)) {
        current.subheadings.push(text);
        current.sections.push({ title: text, objectives: [] });
      }
      continue;
    }

    // Learn repeats some bullets between the objective list and the change
    // log; dedupe so an area is not padded with the same line twice.
    if (!current.objectives.includes(text)) current.objectives.push(text);
    // Also attached to the subsection it sits under, so the script prompt can
    // require coverage section by section rather than as one flat list.
    const section = current.sections.at(-1);
    if (section && !section.objectives.includes(text)) section.objectives.push(text);
  }

  if (areas.length === 0) {
    throw new StudyGuideError(
      `No weighted skill areas found in the study guide for ${examCode}. ` +
        `The page layout may have changed: ${sourceUrl}`
    );
  }

  const title =
    clean($('h1').first().text()) || `Study guide for Exam ${String(examCode).toUpperCase()}`;

  return {
    examCode: String(examCode).toUpperCase(),
    title,
    sourceUrl,
    areas: areas.map((a) => ({ ...a, weightLabel: weightLabel(a.weightLow, a.weightHigh) })),
  };
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
    throw new StudyGuideError(`Study guide fetch failed: HTTP ${response.status} for ${url}`);
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
