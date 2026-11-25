/**
 * Reading the Learn catalogue updater's sources (moved out of
 * update-applied-skills.mjs by #1845): the credentials browse API, each
 * applied skill's detail page and the two posters, every one held to rule 2
 * (a source that cannot be read, or parses to nothing, ends the run and
 * nothing is written). All GET, all learn.microsoft.com or the poster CDN.
 */
import { PDFParse } from 'pdf-parse';

import { normalizeUrl } from './applied-skills-names.mjs';
import { extractCertificationPosterEntries } from './applied-skills-posters.mjs';

const browseUrl = 'https://learn.microsoft.com/api/contentbrowser/search/credentials';
const appliedSkillsPosterUrl =
  'https://arch-center.azureedge.net/Credentials/microsoft-applied-skills-poster.pdf';
const certificationsPosterUrl = 'https://aka.ms/CertificationsPoster';

const browserHeaders = {
  accept: 'application/json,text/html',
  referer:
    'https://learn.microsoft.com/en-us/credentials/browse/?credential_types=applied%20skills',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

/** A source that cannot be read. Its message is the whole report. */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
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
