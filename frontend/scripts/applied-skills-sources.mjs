/**
 * Reading the four Learn sources: the two browse API queries and the two
 * posters (PDF), plus each applied skill's detail page. Any of the four that
 * fails or parses to nothing ends the run (rule 2). Split out of
 * update-applied-skills.mjs, which re-exports `collectSources` and
 * `extractCertificationPosterEntries`.
 */
import { PDFParse } from 'pdf-parse';
import { SourceError, assertSourceItems } from './applied-skills-rules.mjs';
import { extractOverview, extractRetirementDate, normalizeUrl } from './applied-skills-text.mjs';

const browseUrl = 'https://learn.microsoft.com/api/contentbrowser/search/credentials';
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

export const POSTER_ONLY_APPLIED_SKILLS = [
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

export function extractAppliedPosterTitles(text) {
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

const POSTER_CODE_PATTERN = /\b[A-Z]{2,4}-\d{3,4}\b/;

// Poster headings that end a title when reading upwards from an exam code.
const POSTER_STOP_LINES = new Set([
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

// The title printed above the code on line `index`: up to eight lines,
// stopping at another code or a heading.
function posterTitleAbove(lines, index) {
  const parts = [];
  for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
    if (POSTER_CODE_PATTERN.test(lines[cursor]) || POSTER_STOP_LINES.has(lines[cursor])) break;
    parts.unshift(lines[cursor]);
  }
  return parts.join(' ').trim();
}

export function extractCertificationPosterEntries(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = new Map();

  lines.forEach((line, index) => {
    const code = line.match(POSTER_CODE_PATTERN)?.[0];
    const title =
      code && (CERTIFICATION_POSTER_TITLE_OVERRIDES[code] || posterTitleAbove(lines, index));
    if (title) entries.set(code, { code, title });
  });

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

/**
 * One applied skill's detail page. A page that does not answer is "no
 * opinion" (`known: false`), not "no retirement": a retired skill's page may
 * be gone, and its absence must not read as a reprieve.
 */
export async function fetchDetail(skill, fetchImpl) {
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
