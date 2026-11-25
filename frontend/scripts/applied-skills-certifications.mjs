/**
 * The certifications half of the Learn catalogue (moved out of
 * update-applied-skills.mjs by #1845): which exams this catalogue refuses
 * because another owns them, how one certification is built from the
 * poster, the Learn API and the file, and the whole list with rule 3's
 * kept entries.
 */
import {
  assertUniqueCodes,
  normalizeTitle,
  normalizeUrl,
  reconcileLifecycle,
  slugFromUrl,
  slugify,
} from './applied-skills-names.mjs';

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
  const api = findCertification(apiIndexes, posterEntry);
  const known = findCertification(existingIndexes, posterEntry);
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
  const name = normalizeCertificationTitle(title);
  const examId = posterEntry.code.toLowerCase();
  const effort = LEVEL_EFFORT.get(level) || DEFAULT_EFFORT;

  return {
    id: existing.id || examId,
    slug,
    code: posterEntry.code,
    officialCode: posterEntry.code,
    title,
    level,
    status: lifecycle.status,
    ...presentFields({
      featured: existing.featured,
      retiredDate: existing.retiredDate,
      expiryDate: lifecycle.expiryDate,
      replacedBy: existing.replacedBy,
      betaEndDate: existing.betaEndDate,
      betaDiscount: existing.betaDiscount,
      gaDate: existing.gaDate,
      // #1091 (2026-10-12): a status read ahead of the vendor's day is stored
      // with the day it was read on, and a row stored before its availability
      // with that day; deriveStatus holds the badge on them until the day.
      // Both are the file's, never the sources', and the 2026-10-19 run
      // proved a field this list omits is a field the next run deletes:
      // PL-400 lost its statusReadDate, turned `retired` two weeks early, and
      // the data test refused the pull request.
      statusReadDate: existing.statusReadDate,
      availableDate: existing.availableDate,
    }),
    ...fileOrDefault(existing, {
      description: `${name} validates role-based Microsoft cloud skills.`,
      longDescription: `${name} validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.`,
      topics: defaultTopics(api, name),
      hours: effort.hours,
      prepTime: effort.prepTime,
      successRate: null,
    }),
    learnUrl,
    ...fileOrDefault(existing, {
      studyGuideUrl: `https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/${examId}`,
      practiceUrl: `https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=${examId}`,
      modules: [],
      appliedSkills: [],
      prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
      nextCerts: [],
    }),
  };
}

/** Up to four of the API's subjects, else of its products, else the certification's own name. */
function defaultTopics(api, name) {
  return api?.display_subjects?.slice(0, 4) || api?.display_products?.slice(0, 4) || [name];
}

/** A certification by the poster entry's code, or failing that its title; null when neither. */
function findCertification(indexes, posterEntry) {
  return (
    indexes.byCode.get(posterEntry.code) ||
    indexes.byTitle.get(normalizeTitle(posterEntry.title)) ||
    null
  );
}

/** The study time a new certification is given, by level, when the file has none. */
const LEVEL_EFFORT = new Map([
  ['Fundamentals', { hours: 10, prepTime: '~4 weeks' }],
  ['Expert', { hours: 60, prepTime: '~10 weeks' }],
]);
const DEFAULT_EFFORT = { hours: 35, prepTime: '~6 weeks' };

/** Only the fields that have a value, in the order given (the order they are written in). */
function presentFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

/**
 * Each field as the file has it, or the default when the file has no value.
 * Keys keep the order of `defaults`, which is the order they are written in.
 */
function fileOrDefault(existing, defaults) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, existing[key] || fallback])
  );
}

/** The certifications, from the poster, the Learn API and the file, with their report lines. */
export function certificationsFromSources({ sources, existingCertifications, report }) {
  const apiCertificationIndexes = buildApiCertificationIndexes(sources.certificationApiResults);
  const existingCertificationIndexes = buildCertificationIndexes(existingCertifications);
  const nextCertifications = [];
  for (const entry of sources.posterCertificationEntries) {
    // Refused before it is built: another catalogue owns this exam (#496).
    const owner = foreignOwnerFor(entry.code);
    if (owner) {
      report.foreign.push(`${entry.code} — ${entry.title} — carried by ${owner}`);
      continue;
    }
    const cert = buildCertificationFromSources(
      entry,
      apiCertificationIndexes,
      existingCertificationIndexes,
      report.disagreements
    );
    if (cert) nextCertifications.push(cert);
    else report.unverified.push(`${entry.code} — ${entry.title}`);
  }

  // Rule 3 again, for certifications: the poster drops a retired exam the
  // month it retires, and the file must not.
  const nextCodes = new Set(nextCertifications.map((cert) => cert.code));
  for (const cert of existingCertifications) {
    if (nextCodes.has(cert.code)) continue;
    nextCertifications.push(cert);
    nextCodes.add(cert.code);
    report.kept.push(`${cert.code} — ${cert.title} (${cert.status})`);
  }
  nextCertifications.sort((a, b) => a.code.localeCompare(b.code));
  assertUniqueCodes(nextCertifications, 'Certifications');
  return nextCertifications;
}
