/**
 * Small text helpers for the Learn catalogue updater: titles, slugs, codes,
 * areas and the parts of a detail page it reads. Split out of
 * update-applied-skills.mjs.
 */

const learnBaseUrl = 'https://learn.microsoft.com/en-us';

export function stripMicrosoftPrefix(title) {
  return title.replace(/^Microsoft Applied Skills:\s*/i, '').trim();
}

export function slugFromUrl(url) {
  return url.split('/').filter(Boolean).pop();
}

export function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${learnBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

export function normalizeTitle(title) {
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

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeCertificationTitle(title) {
  return title
    .replace(/^Microsoft Certified:\s*/i, '')
    .replace(/^Microsoft 365 Certified:\s*/i, '')
    .replace(/^GitHub Certified:\s*/i, 'GitHub ')
    .replace(/\s+Certification\b/gi, '')
    .replace(/\s+\(beta\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferCertificationLevel(result, posterTitle) {
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
export function sourcedCertificationLifecycle(result, posterTitle) {
  if (/\(beta\)/i.test(posterTitle || '') || /\(beta\)/i.test(result?.title || '')) {
    return { status: 'beta' };
  }
  return {};
}

export function extractCodeFromExam(exam) {
  const raw = exam?.display_name || exam?.uid || exam?.localized_uid || '';
  return raw.toUpperCase().match(/\b[A-Z]{2,4}-\d{3,4}\b/)?.[0] || null;
}

// The area an applied skill is filed under: the first row with a word found
// in its subjects, products or title wins, and 'AI' when none matches.
const AREA_RULES = [
  ['Security', ['security', 'compliance', 'identity', 'active directory']],
  [
    'AI Business',
    ['power platform', 'power apps', 'power automate', 'microsoft 365 copilot', 'copilot studio'],
  ],
  ['Operations', ['monitor', 'management task']],
  ['Containers', ['container', 'kubernetes']],
  ['Data', ['data ', 'database', 'sql', 'postgresql', 'fabric']],
  ['DevTools', ['github', 'devops', 'c#', 'app development']],
  ['AI Business', ['business applications']],
  ['Storage', ['storage']],
  ['Networking', ['network']],
];

export function inferArea(skill) {
  const subjects = (skill.display_subjects || []).join(' ').toLowerCase();
  const products = (skill.display_products || []).join(' ').toLowerCase();
  const title = skill.title.toLowerCase();
  const combined = `${subjects} ${products} ${title}`;

  const rule = AREA_RULES.find(([, words]) => words.some((word) => combined.includes(word)));
  return rule ? rule[0] : 'AI';
}

export function makeCode(slug, usedCodes) {
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

export function extractOverview(html) {
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

export function extractRetirementDate(html) {
  const match = html.match(/This credential will retire on ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!match) return null;
  const date = new Date(`${match[1]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
