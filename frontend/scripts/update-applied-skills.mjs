/**
 * Refresh src/data/azure/certifications.js from Microsoft Learn.
 *
 * Sources, all GET, all learn.microsoft.com or the poster CDN it links:
 *   - the credentials browse API (certifications and applied skills),
 *   - each applied skill's detail page (overview text, retirement banner),
 *   - the Certifications poster and the Applied Skills poster (PDF).
 *
 * Run by `.github/workflows/update-learn-catalogue.yml` every Monday and by
 * `npm run data:update:credentials` by hand. Three rules, from #461 item 3,
 * because the file was hand-synced from 2026-04-16 to 2026-09-09 and the
 * page printed "Expiring" for exams Microsoft had retired ten weeks earlier:
 *
 *   1. Every run stamps today's date into `DATA_AS_OF` and the
 *      `Last manual sync` header line, so the page's "checked on" date is the
 *      day the sources were actually read.
 *   2. A source that cannot be fetched, or that parses to zero items, ends the
 *      run with exit code 1 and one plain sentence — the file is not touched.
 *      An empty catalogue is worse than a stale one.
 *   3. Lifecycle only moves forward: beta → active → expiring → retired. When
 *      a source says an entry is earlier in that order than the file does, or
 *      names a different retirement date, the file's value is kept and the
 *      disagreement is printed. #464 retired ten exams by hand from the
 *      credential-retirement page; a poster that still carries them, or an
 *      API that still says "(beta)" for an exam that went GA, must not undo
 *      that. An entry the sources no longer list is kept, not deleted — the
 *      retired cards stay on the page with their dates, and `replacedBy`
 *      links keep resolving.
 *
 * The regenerated blocks are run through Prettier with the repository config,
 * so a run that changes nothing but the date produces a one-line diff.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataFile = path.join(repoRoot, 'src', 'data', 'azure', 'certifications.js');
const browseUrl = 'https://learn.microsoft.com/api/contentbrowser/search/credentials';
const learnBaseUrl = 'https://learn.microsoft.com/en-us';
const appliedSkillsPosterUrl =
  'https://arch-center.azureedge.net/Credentials/microsoft-applied-skills-poster.pdf';
const certificationsPosterUrl = 'https://aka.ms/CertificationsPoster';

// Titles only — the poster's text runs these codes into their neighbours.
// Lifecycle is never asserted here: an override that said "(Beta)" for AB-620
// kept telling rule 3 the exam was in beta after Microsoft had made it GA.
const CERTIFICATION_POSTER_TITLE_OVERRIDES = {
  'AB-100': 'Agentic AI Business Solutions Architect',
  'AB-620': 'AI Agent Builder Associate',
  'AB-900': 'Microsoft 365 Copilot and Agent Administration Fundamentals',
  'AZ-801': 'Windows Server Hybrid Administrator Associate',
  'AI-901': 'Azure AI Fundamentals',
};

const POSTER_ONLY_APPLIED_SKILLS = [
  {
    id: 'apl-openai-semantic-kernel',
    slug: 'develop-generative-ai-apps-azure-openai-semantic-kernel',
    code: 'APL-SK',
    officialCode: 'develop-generative-ai-apps-azure-openai-semantic-kernel',
    title: 'Develop generative AI apps with Azure OpenAI and Semantic Kernel',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build generative AI applications using Azure OpenAI Service and Semantic Kernel SDK, including plugins and orchestration patterns.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-generative-ai-apps-azure-openai-semantic-kernel/',
  },
  {
    id: 'apl-m365-copilot-declarative',
    slug: 'extend-microsoft-365-copilot-with-declarative-agents',
    code: 'APL-M365D',
    officialCode: 'extend-microsoft-365-copilot-with-declarative-agents',
    title: 'Extend Microsoft 365 Copilot with declarative agents by using Visual Studio Code',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build declarative agents for Microsoft 365 Copilot using Visual Studio Code to extend AI capabilities.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/extend-microsoft-365-copilot-with-declarative-agents/',
  },
];

const browserHeaders = {
  accept: 'application/json,text/html',
  referer:
    'https://learn.microsoft.com/en-us/credentials/browse/?credential_types=applied%20skills',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

/**
 * The lifecycle, in the only order it may move. A source that places an
 * entry earlier than the file does is stale, not news.
 */
export const LIFECYCLE_RANK = Object.freeze({ beta: 0, active: 1, expiring: 2, retired: 3 });

/**
 * Exam codes this catalogue must not carry, because another one owns them.
 *
 * GitHub certification moved onto Microsoft Learn, so GH-100, GH-200, GH-300,
 * GH-500, GH-600 and GH-900 are on the Microsoft Certifications poster and in
 * the Learn browse API. Both are this script's sources, so it added all six to
 * the Azure catalogue — where they duplicated
 * `src/data/github/certifications.js` and contradicted it: four of the six
 * disagreed about the level, and GH-200 rendered as Fundamentals under Azure
 * and Associate under GitHub on the same /education screen.
 *
 * The owner decided on 2026-09-11 that the GitHub catalogue owns them (issue
 * #496); PR #507 implemented the removal. The first dispatch of the refreshed
 * workflow (run 34627119281, the same day) put all six straight back, because
 * a decision recorded in a file header is invisible to a script. THAT is what
 * this constant is for: the Monday cron is the thing that has to know, not the
 * reader of the file it writes.
 *
 * A PREFIX, not the six codes. GitHub adding a GH-700 would recreate the
 * duplication exactly, and it belongs to /github/education for the same
 * reason the six do. The Azure `LEVEL_META` has no Professional rung, so a
 * GitHub exam cannot even be stated truthfully here.
 *
 * Skipped entries are reported in the summary rather than dropped silently —
 * a source offering something this catalogue refuses is worth a line in the
 * pull request, or the next person wonders why the poster and the file differ.
 */
export const FOREIGN_CODE_PATTERN = /^GH-\d+$/;

/** Which catalogue owns a code this one refuses, for the summary line. */
export function foreignOwnerFor(code) {
  return FOREIGN_CODE_PATTERN.test(String(code)) ? 'src/data/github/certifications.js' : null;
}

/** A source that cannot be read. Its message is the whole report. */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

/** `YYYY-MM-DD` on the UTC calendar — the workflow runs on a UTC runner. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Rule 2. Zero items from a source that answered is as much a failure as no
 * answer: the browse API returning `{ count: 0 }` would otherwise write an
 * empty catalogue, and nothing downstream would notice until the page did.
 */
export function assertSourceItems(label, items, url) {
  const count = Array.isArray(items) ? items.length : String(items || '').trim().length;
  if (count > 0) return items;
  throw new SourceError(
    `The ${label} (${url}) was fetched but parsed to zero items, so the catalogue was not written.`
  );
}

/**
 * Rule 1. Both markers must be present: the header line is what a reader
 * sees first and `DATA_AS_OF` is what the page renders, and they must agree.
 */
export function stampSyncDate(source, today) {
  const headerRe = /^\/\/ Last manual sync: \d{4}-\d{2}-\d{2}$/m;
  const constRe = /^export const DATA_AS_OF = '\d{4}-\d{2}-\d{2}';$/m;
  if (!headerRe.test(source) || !constRe.test(source)) {
    throw new Error(
      'certifications.js no longer carries both the "// Last manual sync: YYYY-MM-DD" header ' +
        'line and the "export const DATA_AS_OF = \'YYYY-MM-DD\';" constant, so the sync date ' +
        'could not be stamped.'
    );
  }
  return source
    .replace(headerRe, `// Last manual sync: ${today}`)
    .replace(constRe, `export const DATA_AS_OF = '${today}';`);
}

/**
 * Rule 3. `existing` is the entry as the file has it; `sourced` is what the
 * sources say today, where `status` may be undefined when the source has no
 * opinion (the certification sources say "(beta)" or nothing; they never
 * announce a retirement). Returns the `{ status, expiryDate }` to write and
 * pushes one line per disagreement onto `report`.
 */
export function reconcileLifecycle({ existing = {}, sourced = {}, label, report = [] }) {
  const fileStatus = existing.status in LIFECYCLE_RANK ? existing.status : undefined;
  const sourceStatus = sourced.status in LIFECYCLE_RANK ? sourced.status : undefined;
  const keepFile = {
    status: fileStatus || 'active',
    ...(existing.expiryDate ? { expiryDate: existing.expiryDate } : {}),
  };

  if (!fileStatus) {
    return {
      status: sourceStatus || 'active',
      ...(sourced.expiryDate ? { expiryDate: sourced.expiryDate } : {}),
    };
  }

  if (sourceStatus && LIFECYCLE_RANK[sourceStatus] < LIFECYCLE_RANK[fileStatus]) {
    const when = existing.expiryDate ? ` (${existing.expiryDate})` : '';
    report.push(
      `${label}: the source says '${sourceStatus}' but the file says '${fileStatus}'${when}; kept the file's value.`
    );
    return keepFile;
  }

  if (existing.expiryDate && sourced.expiryDate && existing.expiryDate !== sourced.expiryDate) {
    report.push(
      `${label}: the source gives retirement date ${sourced.expiryDate} but the file has ${existing.expiryDate}; kept the file's value.`
    );
    return keepFile;
  }

  return {
    status: sourceStatus || fileStatus,
    ...(sourced.expiryDate || existing.expiryDate
      ? { expiryDate: sourced.expiryDate || existing.expiryDate }
      : {}),
  };
}

/**
 * The lines a pull request body needs: what was added, what changed status
 * or date, what the sources no longer list, and where they disagreed with
 * the file. Keyed on `code` because ids and slugs are derived from it.
 */
export function summarizeChanges({
  before,
  after,
  today,
  kept = [],
  disagreements = [],
  unverified = [],
  foreign = [],
}) {
  const lines = [];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push(`### ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };

  const diffList = (label, prev, next) => {
    const prevByCode = new Map(prev.map((e) => [e.code, e]));
    const nextByCode = new Map(next.map((e) => [e.code, e]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [code, entry] of nextByCode) {
      const old = prevByCode.get(code);
      if (!old) {
        added.push(`${code} — ${entry.title} (${entry.status})`);
        continue;
      }
      const deltas = [];
      for (const field of ['status', 'expiryDate', 'betaEndDate', 'gaDate', 'title', 'level']) {
        if ((old[field] ?? null) !== (entry[field] ?? null)) {
          deltas.push(`${field} ${old[field] ?? '—'} → ${entry[field] ?? '—'}`);
        }
      }
      if (deltas.length) changed.push(`${code}: ${deltas.join(', ')}`);
    }
    for (const [code, entry] of prevByCode) {
      if (!nextByCode.has(code)) removed.push(`${code} — ${entry.title}`);
    }
    section(`${label} added`, added);
    section(`${label} changed`, changed);
    section(`${label} removed`, removed);
    return added.length + changed.length + removed.length;
  };

  lines.push(`Catalogue checked against Microsoft Learn on ${today}.`, '');
  const certCount = diffList('Certifications', before.certifications, after.certifications);
  const skillCount = diffList('Applied Skills', before.appliedSkills, after.appliedSkills);
  if (certCount + skillCount === 0) {
    lines.push('No entry changed; only the sync date moved.', '');
  }
  section('Kept from the file (absent from the current sources)', kept);
  section('Source disagreed with the file (file kept)', disagreements);
  section('On the poster but in neither the Learn catalogue nor the file (not added)', unverified);
  section('Refused because another catalogue owns the exam (#496)', foreign);
  return lines.join('\n').trimEnd() + '\n';
}

function stripMicrosoftPrefix(title) {
  return title.replace(/^Microsoft Applied Skills:\s*/i, '').trim();
}

function slugFromUrl(url) {
  return url.split('/').filter(Boolean).pop();
}

function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${learnBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

function normalizeTitle(title) {
  return stripMicrosoftPrefix(title)
    .replace(/^Microsoft Certified:\s*/i, '')
    .replace(/^Microsoft 365 Certified:\s*/i, '')
    .replace(/^GitHub Certified:\s*/i, 'GitHub ')
    .replace(/\s+Certification\b/gi, '')
    .replace(/\s+\(beta\)/gi, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCertificationTitle(title) {
  return title
    .replace(/^Microsoft Certified:\s*/i, '')
    .replace(/^Microsoft 365 Certified:\s*/i, '')
    .replace(/^GitHub Certified:\s*/i, 'GitHub ')
    .replace(/\s+Certification\b/gi, '')
    .replace(/\s+\(beta\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCertificationLevel(result, posterTitle) {
  const credentialTypes = result?.credential_types || [];
  const title = posterTitle || result?.title || '';
  if (credentialTypes.includes('fundamentals') || /\bFundamentals\b/i.test(title)) {
    return 'Fundamentals';
  }
  if (credentialTypes.includes('specialty') || /\bSpecialty\b/i.test(title)) return 'Specialty';
  if (credentialTypes.includes('business')) return 'Associate';
  if (/\bExpert\b/i.test(title)) return 'Expert';
  return 'Associate';
}

/**
 * What the certification sources say about lifecycle: "(beta)" in the poster
 * or API title, and otherwise nothing — neither source announces a
 * retirement, so `status` is left undefined rather than asserted as active.
 */
function sourcedCertificationLifecycle(result, posterTitle) {
  if (/\(beta\)/i.test(posterTitle || '') || /\(beta\)/i.test(result?.title || '')) {
    return { status: 'beta' };
  }
  return {};
}

function extractCodeFromExam(exam) {
  const raw = exam?.display_name || exam?.uid || exam?.localized_uid || '';
  return raw.toUpperCase().match(/\b[A-Z]{2,4}-\d{3,4}\b/)?.[0] || null;
}

function inferArea(skill) {
  const subjects = (skill.display_subjects || []).join(' ').toLowerCase();
  const products = (skill.display_products || []).join(' ').toLowerCase();
  const title = skill.title.toLowerCase();
  const combined = `${subjects} ${products} ${title}`;

  if (
    combined.includes('security') ||
    combined.includes('compliance') ||
    combined.includes('identity') ||
    combined.includes('active directory')
  ) {
    return 'Security';
  }
  if (
    combined.includes('power platform') ||
    combined.includes('power apps') ||
    combined.includes('power automate') ||
    combined.includes('microsoft 365 copilot') ||
    combined.includes('copilot studio')
  ) {
    return 'AI Business';
  }
  if (combined.includes('monitor') || combined.includes('management task')) return 'Operations';
  if (combined.includes('container') || combined.includes('kubernetes')) return 'Containers';
  if (
    combined.includes('data ') ||
    combined.includes('database') ||
    combined.includes('sql') ||
    combined.includes('postgresql') ||
    combined.includes('fabric')
  ) {
    return 'Data';
  }
  if (
    combined.includes('github') ||
    combined.includes('devops') ||
    combined.includes('c#') ||
    combined.includes('app development')
  ) {
    return 'DevTools';
  }
  if (combined.includes('business applications')) return 'AI Business';
  if (combined.includes('storage')) return 'Storage';
  if (combined.includes('network')) return 'Networking';
  return 'AI';
}

function makeCode(slug, usedCodes) {
  const words = slug
    .replace(/microsoft|azure|using|with|and|for|the|by|in|to|of/g, '')
    .split('-')
    .filter(Boolean);
  const acronym = words
    .slice(0, 5)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  let code = `APL-${acronym || 'SKILL'}`;
  let suffix = 2;
  while (usedCodes.has(code)) {
    code = `APL-${acronym || 'SKILL'}${suffix}`;
    suffix += 1;
  }
  usedCodes.add(code);
  return code;
}

function extractOverview(html) {
  const overviewStart = html.search(/<h2[^>]*>\s*Overview\s*<\/h2>/i);
  if (overviewStart === -1) return null;

  const overviewEnd = html.indexOf('</section>', overviewStart);
  const overviewHtml = html.slice(overviewStart, overviewEnd === -1 ? undefined : overviewEnd);
  const text = overviewHtml
    .replace(/<div class="WARNING">[\s\S]*?<\/div>/i, '')
    .replace(/<h2[^>]*>[\s\S]*?<\/h2>/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text || null;
}

function extractRetirementDate(html) {
  const match = html.match(/This credential will retire on ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!match) return null;
  const date = new Date(`${match[1]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** A network failure or a non-2xx answer, as one sentence naming the source. */
async function fetchOrExplain(label, url, fetchImpl, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new SourceError(
      `The ${label} (${url}) could not be fetched (${error?.message || error}), so the catalogue was not written.`
    );
  }
  if (!response.ok) {
    throw new SourceError(
      `The ${label} (${url}) answered HTTP ${response.status}, so the catalogue was not written.`
    );
  }
  return response;
}

async function fetchCredentialBrowseResults(label, filter, fetchImpl) {
  const results = [];
  let count = 0;
  for (let skip = 0; skip <= count; skip += 100) {
    const params = new URLSearchParams();
    params.append('locale', 'en-us');
    for (const facet of ['roles', 'products', 'levels', 'subjects', 'credential_types']) {
      params.append('facet', facet);
    }
    params.append('$filter', filter);
    params.append('$orderBy', 'title');
    params.append('$top', '100');
    params.append('$skip', String(skip));
    params.append('fuzzySearch', 'false');

    const response = await fetchOrExplain(label, `${browseUrl}?${params}`, fetchImpl, {
      headers: browserHeaders,
    });
    const payload = await response.json();
    count = payload.count || 0;
    results.push(...(payload.results || []));
    if (results.length >= count) break;
  }

  return results;
}

async function fetchPdfText(label, url, fetchImpl) {
  const response = await fetchOrExplain(label, url, fetchImpl, {
    headers: browserHeaders,
    redirect: 'follow',
  });
  let parser;
  try {
    parser = new PDFParse({ data: new Uint8Array(await response.arrayBuffer()) });
    // pageJoiner: '' suppresses the default '-- page_number of total_number --'
    // marker pdf-parse v2 appends to every page. extractCertificationPosterEntries
    // walks backwards from a certification code to build its title, so a marker
    // left in the text would be absorbed into that title.
    const parsed = await parser.getText({ pageJoiner: '' });
    return parsed.text || '';
  } catch (error) {
    throw new SourceError(
      `The ${label} (${url}) could not be parsed as a PDF (${error?.message || error}), so the catalogue was not written.`
    );
  } finally {
    await parser?.destroy();
  }
}

function extractAppliedPosterTitles(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const titles = [
    ...POSTER_ONLY_APPLIED_SKILLS.map((skill) => skill.title),
    'Accelerate app development by using GitHub Copilot',
    'Build a generative AI chat app',
    'Create an AI agent',
    'Secure AI solutions in the cloud',
    'Streamline business workflows with AI chat',
  ];
  return titles.filter((title) =>
    normalized.toLowerCase().includes(title.toLowerCase().replace('AI-assisted', 'app'))
  );
}

export function extractCertificationPosterEntries(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const codeRegex = /\b[A-Z]{2,4}-\d{3,4}\b/;
  const stopLines = new Set([
    'Role-based',
    'Specialty',
    'Business',
    'Fundamentals',
    'Expand your technical skill set',
    'Deepen your technical skills and',
    'manage industry solutions',
    'Expand your AI skills',
    'for business roles',
    'Master the basics',
    'AI Business SolutionsSecurityCloud & AI Platforms',
  ]);
  const entries = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index].match(codeRegex)?.[0];
    if (!code) continue;
    const parts = [];
    for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
      if (codeRegex.test(lines[cursor]) || stopLines.has(lines[cursor])) break;
      parts.unshift(lines[cursor]);
    }
    const title = CERTIFICATION_POSTER_TITLE_OVERRIDES[code] || parts.join(' ').trim();
    if (title) entries.set(code, { code, title });
  }

  // The overrides repair titles on a poster that parsed; applied to a poster
  // that parsed to nothing they would turn an empty source into five entries,
  // and rule 2 would never fire.
  if (entries.size > 0) {
    for (const [code, title] of Object.entries(CERTIFICATION_POSTER_TITLE_OVERRIDES)) {
      entries.set(code, { code, title });
    }
  }

  return [...entries.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function buildApiCertificationIndexes(apiResults) {
  const byCode = new Map();
  const byTitle = new Map();
  for (const result of apiResults) {
    const title = normalizeTitle(result.title);
    byTitle.set(title, result);
    for (const exam of result.exams || []) {
      const code = extractCodeFromExam(exam);
      if (code && !byCode.has(code)) byCode.set(code, result);
    }
  }
  return { byCode, byTitle };
}

function buildCertificationIndexes(certifications) {
  const byCode = new Map();
  const byTitle = new Map();
  for (const cert of certifications) {
    byCode.set(cert.code, cert);
    byTitle.set(normalizeTitle(cert.title), cert);
  }
  return { byCode, byTitle };
}

/**
 * One certification from the poster entry, the Learn API's record for it
 * and the file's. Returns null for a poster entry that neither the API nor
 * the file knows: the poster is a marketing PDF whose text parses into
 * things like "MB-300 — Full certification title" (a template label, seen
 * 2026-09-09), and an exam that Microsoft's own catalogue does not list is
 * not added on the strength of a PDF.
 */
export function buildCertificationFromSources(
  posterEntry,
  apiIndexes,
  existingIndexes,
  disagreements = []
) {
  const api =
    apiIndexes.byCode.get(posterEntry.code) ||
    apiIndexes.byTitle.get(normalizeTitle(posterEntry.title)) ||
    null;
  const known =
    existingIndexes.byCode.get(posterEntry.code) ||
    existingIndexes.byTitle.get(normalizeTitle(posterEntry.title)) ||
    null;
  if (!api && !known) return null;
  const existing = known || {};
  const title = existing.title || `Microsoft Certified: ${posterEntry.title}`;
  const slug = existing.slug || slugFromUrl(api?.url || '') || slugify(posterEntry.title);
  const learnUrl =
    existing.learnUrl || normalizeUrl(api?.url || `/credentials/certifications/${slug}/`);
  const level = existing.level || inferCertificationLevel(api, posterEntry.title);
  const lifecycle = reconcileLifecycle({
    existing,
    sourced: sourcedCertificationLifecycle(api, posterEntry.title),
    label: posterEntry.code,
    report: disagreements,
  });

  return {
    id: existing.id || posterEntry.code.toLowerCase(),
    slug,
    code: posterEntry.code,
    officialCode: posterEntry.code,
    title,
    level,
    status: lifecycle.status,
    ...(existing.featured ? { featured: existing.featured } : {}),
    ...(existing.retiredDate ? { retiredDate: existing.retiredDate } : {}),
    ...(lifecycle.expiryDate ? { expiryDate: lifecycle.expiryDate } : {}),
    ...(existing.replacedBy ? { replacedBy: existing.replacedBy } : {}),
    ...(existing.betaEndDate ? { betaEndDate: existing.betaEndDate } : {}),
    ...(existing.betaDiscount ? { betaDiscount: existing.betaDiscount } : {}),
    ...(existing.gaDate ? { gaDate: existing.gaDate } : {}),
    // #1091 (2026-10-12): a status read ahead of the vendor's day is stored
    // with the day it was read on, and a row stored before its availability
    // with that day; deriveStatus holds the badge on them until the day. Both
    // are the file's, never the sources', and the 2026-10-19 run proved a
    // field this list omits is a field the next run deletes: PL-400 lost its
    // statusReadDate, turned `retired` two weeks early, and the data test
    // refused the pull request.
    ...(existing.statusReadDate ? { statusReadDate: existing.statusReadDate } : {}),
    ...(existing.availableDate ? { availableDate: existing.availableDate } : {}),
    description:
      existing.description ||
      `${normalizeCertificationTitle(title)} validates role-based Microsoft cloud skills.`,
    longDescription:
      existing.longDescription ||
      `${normalizeCertificationTitle(title)} validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.`,
    topics: existing.topics ||
      api?.display_subjects?.slice(0, 4) ||
      api?.display_products?.slice(0, 4) || [normalizeCertificationTitle(title)],
    hours: existing.hours || (level === 'Fundamentals' ? 10 : level === 'Expert' ? 60 : 35),
    prepTime:
      existing.prepTime ||
      (level === 'Fundamentals' ? '~4 weeks' : level === 'Expert' ? '~10 weeks' : '~6 weeks'),
    successRate: existing.successRate || null,
    learnUrl,
    studyGuideUrl:
      existing.studyGuideUrl ||
      `https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/${posterEntry.code.toLowerCase()}`,
    practiceUrl:
      existing.practiceUrl ||
      `https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=${posterEntry.code.toLowerCase()}`,
    modules: existing.modules || [],
    appliedSkills: existing.appliedSkills || [],
    prerequisites:
      existing.prerequisites ||
      'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: existing.nextCerts || [],
  };
}

function formatObject(obj, indent = 2) {
  return JSON.stringify(obj, null, 2)
    .split('\n')
    .map((line) => `${' '.repeat(indent)}${line}`)
    .join('\n');
}

function formatCertification(cert) {
  return formatObject(cert, 2);
}

function assertUniqueCodes(items, label) {
  const seen = new Set();
  const seenOfficial = new Set();
  const duplicates = [];
  const officialDuplicates = [];
  for (const item of items) {
    if (!item.code) throw new Error(`${label} item is missing code: ${item.title}`);
    if (seen.has(item.code)) duplicates.push(item.code);
    seen.add(item.code);
    if (item.officialCode) {
      if (seenOfficial.has(item.officialCode)) officialDuplicates.push(item.officialCode);
      seenOfficial.add(item.officialCode);
    }
  }
  if (duplicates.length) {
    throw new Error(`${label} duplicate codes: ${duplicates.join(', ')}`);
  }
  if (officialDuplicates.length) {
    throw new Error(`${label} duplicate official codes: ${officialDuplicates.join(', ')}`);
  }
}

/**
 * One applied skill's detail page. A page that does not answer is "no
 * opinion" (`known: false`), not "no retirement": a retired skill's page may
 * be gone, and its absence must not read as a reprieve.
 */
async function fetchDetail(skill, fetchImpl) {
  const url = normalizeUrl(skill.url);
  let response;
  try {
    response = await fetchImpl(url, { headers: browserHeaders });
  } catch {
    return { known: false, description: null, retirementDate: null };
  }
  if (!response.ok) {
    return { known: false, description: null, retirementDate: null };
  }

  const html = await response.text();
  return {
    known: true,
    description: extractOverview(html),
    retirementDate: extractRetirementDate(html),
  };
}

function buildExistingIndexes(existingSkills) {
  const bySlug = new Map();
  const byTitle = new Map();

  for (const skill of existingSkills) {
    if (skill.slug) bySlug.set(skill.slug, skill);
    byTitle.set(normalizeTitle(skill.title), skill);
    if (skill.learnUrl) bySlug.set(slugFromUrl(skill.learnUrl), skill);
  }

  return { bySlug, byTitle };
}

function formatSkill(skill) {
  const ordered = {
    id: skill.id,
    slug: skill.slug,
    code: skill.code,
    ...(skill.officialCode ? { officialCode: skill.officialCode } : {}),
    title: skill.title,
    area: skill.area,
    level: skill.level,
    status: skill.status,
    ...(skill.expiryDate ? { expiryDate: skill.expiryDate } : {}),
    description: skill.description,
    learnUrl: skill.learnUrl,
  };

  return JSON.stringify(ordered, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function renderCertificationBlock(certifications) {
  return `// status: 'active' | 'beta' | 'expiring' | 'retired'
// Updated by scripts/update-applied-skills.mjs from Microsoft Learn API and the Certifications poster.
export const certifications = [
${certifications.map(formatCertification).join(',\n')},
];

`;
}

function renderAppliedSkillsBlock(skills) {
  return `// Applied Skills — sourced from official Applied Skills Poster
// Updated by scripts/update-applied-skills.mjs from Microsoft Learn API, detail pages, and the Applied Skills poster.
// status: 'active' | 'expiring' | 'retired'
export const appliedSkills = [
${skills.map(formatSkill).join(',\n')},
];

`;
}

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not locate block between ${startMarker} and ${endMarker}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

/**
 * The four sources, fetched together and each held to rule 2. Exported so a
 * test can hand in a stub `fetchImpl` (and a stub `readPdf`, so it need not
 * forge a PDF) and watch the refusal.
 */
export async function collectSources({ fetchImpl = fetch, readPdf = fetchPdfText } = {}) {
  const [browseResults, certificationApiResults, appliedPosterText, certificationPosterText] =
    await Promise.all([
      fetchCredentialBrowseResults(
        'applied skills browse API',
        "(credential_types/any(c: c eq 'applied skills'))",
        fetchImpl
      ),
      fetchCredentialBrowseResults(
        'certifications browse API',
        "(credential_types/any(c: c eq 'certification'))",
        fetchImpl
      ),
      readPdf('Applied Skills poster', appliedSkillsPosterUrl, fetchImpl),
      readPdf('Certifications poster', certificationsPosterUrl, fetchImpl),
    ]);

  assertSourceItems('applied skills browse API', browseResults, browseUrl);
  assertSourceItems('certifications browse API', certificationApiResults, browseUrl);
  assertSourceItems('Applied Skills poster', appliedPosterText, appliedSkillsPosterUrl);
  const posterCertificationEntries = assertSourceItems(
    'Certifications poster',
    extractCertificationPosterEntries(certificationPosterText),
    certificationsPosterUrl
  );

  return {
    browseResults,
    certificationApiResults,
    appliedPosterText,
    posterCertificationEntries,
  };
}

/**
 * The next catalogue from the sources and the file, with the report lines.
 * Pure apart from the per-skill detail fetches, which go through `fetchImpl`.
 */
export async function buildCatalogue({
  existingSkills,
  existingCertifications,
  sources,
  fetchImpl,
}) {
  const kept = [];
  const disagreements = [];
  const unverified = [];
  const foreign = [];
  const { bySlug, byTitle } = buildExistingIndexes(existingSkills);
  const usedCodes = new Set();

  const nextSkills = [];
  for (const result of sources.browseResults) {
    const slug = slugFromUrl(result.url);
    const existing = bySlug.get(slug) || byTitle.get(normalizeTitle(result.title)) || {};
    const detail = await fetchDetail(result, fetchImpl);
    const code =
      existing.code && !usedCodes.has(existing.code) ? existing.code : makeCode(slug, usedCodes);
    usedCodes.add(code);

    // No opinion when the page did not answer; otherwise the banner decides.
    const sourced = !detail.known
      ? {}
      : detail.retirementDate
        ? { status: 'expiring', expiryDate: detail.retirementDate }
        : { status: 'active' };
    const lifecycle = reconcileLifecycle({
      existing,
      sourced,
      label: `${code} (${slug})`,
      report: disagreements,
    });

    nextSkills.push({
      id: existing.id || slug,
      slug,
      code,
      officialCode: result.uid || slug,
      title: stripMicrosoftPrefix(result.title),
      area: inferArea(result),
      level: result.display_levels?.[0] || existing.level || 'Intermediate',
      status: lifecycle.status,
      expiryDate: lifecycle.expiryDate,
      description:
        detail.description ||
        existing.description ||
        `Validate hands-on skills for ${stripMicrosoftPrefix(result.title)}.`,
      learnUrl: normalizeUrl(result.url),
    });
  }

  const appliedPosterTitles = extractAppliedPosterTitles(sources.appliedPosterText);
  const nextSlugs = new Set(nextSkills.map((skill) => skill.slug));
  for (const posterOnlySkill of POSTER_ONLY_APPLIED_SKILLS) {
    const posterHasSkill = appliedPosterTitles.some(
      (title) => normalizeTitle(title) === normalizeTitle(posterOnlySkill.title)
    );
    if (posterHasSkill && !nextSlugs.has(posterOnlySkill.slug)) {
      nextSkills.push(posterOnlySkill);
      nextSlugs.add(posterOnlySkill.slug);
      usedCodes.add(posterOnlySkill.code);
    }
  }

  // Rule 3: an applied skill the sources no longer list stays, as the file
  // has it. A retired skill drops out of the browse API, and dropping it here
  // would erase the retirement the file records.
  const nextSkillTitles = new Set(nextSkills.map((skill) => normalizeTitle(skill.title)));
  for (const skill of existingSkills) {
    if (nextSlugs.has(skill.slug) || nextSkillTitles.has(normalizeTitle(skill.title))) continue;
    // The code written is the one reported: when a skill from the sources
    // has taken this code, the kept entry gets a fresh one and the summary
    // says so, or a reviewer would look for a code the file no longer has.
    const code = usedCodes.has(skill.code) ? makeCode(skill.slug, usedCodes) : skill.code;
    usedCodes.add(code);
    nextSkills.push({ ...skill, code });
    kept.push(
      code === skill.code
        ? `${code} — ${skill.title} (${skill.status})`
        : `${code} — ${skill.title} (${skill.status}) — kept as ${code} (was ${skill.code}, now taken by a sourced skill)`
    );
  }

  nextSkills.sort((a, b) => a.title.localeCompare(b.title));
  assertUniqueCodes(nextSkills, 'Applied Skills');

  const apiCertificationIndexes = buildApiCertificationIndexes(sources.certificationApiResults);
  const existingCertificationIndexes = buildCertificationIndexes(existingCertifications);
  const nextCertifications = [];
  for (const entry of sources.posterCertificationEntries) {
    // Refused before it is built: another catalogue owns this exam (#496).
    const owner = foreignOwnerFor(entry.code);
    if (owner) {
      foreign.push(`${entry.code} — ${entry.title} — carried by ${owner}`);
      continue;
    }
    const cert = buildCertificationFromSources(
      entry,
      apiCertificationIndexes,
      existingCertificationIndexes,
      disagreements
    );
    if (cert) nextCertifications.push(cert);
    else unverified.push(`${entry.code} — ${entry.title}`);
  }

  // Rule 3 again, for certifications: the poster drops a retired exam the
  // month it retires, and the file must not.
  const nextCodes = new Set(nextCertifications.map((cert) => cert.code));
  for (const cert of existingCertifications) {
    if (nextCodes.has(cert.code)) continue;
    nextCertifications.push(cert);
    nextCodes.add(cert.code);
    kept.push(`${cert.code} — ${cert.title} (${cert.status})`);
  }
  nextCertifications.sort((a, b) => a.code.localeCompare(b.code));
  assertUniqueCodes(nextCertifications, 'Certifications');

  return { nextSkills, nextCertifications, kept, disagreements, unverified, foreign };
}

function parseArgs(argv) {
  const args = { summaryPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--summary') {
      args.summaryPath = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const { summaryPath } = parseArgs(argv);
  const today = todayIso();
  const moduleUrl = pathToFileURL(dataFile).href;
  const { appliedSkills: existingSkills, certifications: existingCertifications } = await import(
    `${moduleUrl}?t=${Date.now()}`
  );

  const sources = await collectSources({ fetchImpl: fetch });
  const { nextSkills, nextCertifications, kept, disagreements, unverified, foreign } =
    await buildCatalogue({
      existingSkills,
      existingCertifications,
      sources,
      fetchImpl: fetch,
    });

  const source = await fs.readFile(dataFile, 'utf8');
  const certificationStartMarker = "// status: 'active' | 'beta' | 'expiring' | 'retired'";
  const startMarker = '// Applied Skills — sourced from official Applied Skills Poster';
  const endMarker = '// Timeline events';

  let nextSource = replaceBetween(
    source,
    certificationStartMarker,
    startMarker,
    renderCertificationBlock(nextCertifications)
  );
  nextSource = replaceBetween(
    nextSource,
    startMarker,
    endMarker,
    renderAppliedSkillsBlock(nextSkills)
  );
  nextSource = stampSyncDate(nextSource, today);
  nextSource = await prettier.format(nextSource, {
    ...(await prettier.resolveConfig(dataFile)),
    filepath: dataFile,
  });

  await fs.writeFile(dataFile, nextSource);

  const summary = summarizeChanges({
    before: { certifications: existingCertifications, appliedSkills: existingSkills },
    after: { certifications: nextCertifications, appliedSkills: nextSkills },
    today,
    kept,
    disagreements,
    unverified,
    foreign,
  });
  if (summaryPath) await fs.writeFile(summaryPath, summary);

  console.log(
    `Updated ${nextCertifications.length} Certifications and ${nextSkills.length} Applied Skills in ${path.relative(
      repoRoot,
      dataFile
    )}; DATA_AS_OF is now ${today}.`
  );
  console.log('');
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // One sentence for a source failure; the stack only for a bug.
    if (error instanceof SourceError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
