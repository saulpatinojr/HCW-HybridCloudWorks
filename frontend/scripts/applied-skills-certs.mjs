/**
 * Building the certification half of the next catalogue: one row per
 * poster entry a source confirms, with rule 3 deciding lifecycle, and every
 * certification the poster dropped kept as the file has it. Split out of
 * applied-skills-build.mjs; update-applied-skills.mjs re-exports
 * `buildCertificationFromSources`.
 */
import { foreignOwnerFor, reconcileLifecycle } from './applied-skills-rules.mjs';
import {
  extractCodeFromExam,
  inferCertificationLevel,
  normalizeCertificationTitle,
  normalizeTitle,
  normalizeUrl,
  slugFromUrl,
  slugify,
  sourcedCertificationLifecycle,
} from './applied-skills-text.mjs';

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

/** The record an index holds for a poster entry: by code first, then by title. */
function lookUpCertification(indexes, posterEntry) {
  return (
    indexes.byCode.get(posterEntry.code) ||
    indexes.byTitle.get(normalizeTitle(posterEntry.title)) ||
    null
  );
}

// Fields a certification keeps from the file when it has them, in the order
// they are written: the first list before `expiryDate`, the second after.
const CARRIED_BEFORE_EXPIRY = ['featured', 'retiredDate'];
const CARRIED_AFTER_EXPIRY = [
  'replacedBy',
  'betaEndDate',
  'betaDiscount',
  'gaDate',
  // #1091 (2026-10-12): a status read ahead of the vendor's day is stored
  // with the day it was read on, and a row stored before its availability
  // with that day; deriveStatus holds the badge on them until the day. Both
  // are the file's, never the sources', and the 2026-10-19 run proved a
  // field this list omits is a field the next run deletes: PL-400 lost its
  // statusReadDate, turned `retired` two weeks early, and the data test
  // refused the pull request.
  'statusReadDate',
  'availableDate',
];

/** The listed fields of `source` that are filled in (truthy), in list order. */
function filledFields(source, fields) {
  return Object.fromEntries(fields.filter((field) => source[field]).map((f) => [f, source[f]]));
}

/** Study hours and preparation time for a new certification row, by level. */
function defaultEffort(level) {
  if (level === 'Fundamentals') return { hours: 10, prepTime: '~4 weeks' };
  if (level === 'Expert') return { hours: 60, prepTime: '~10 weeks' };
  return { hours: 35, prepTime: '~6 weeks' };
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
  const api = lookUpCertification(apiIndexes, posterEntry);
  const known = lookUpCertification(existingIndexes, posterEntry);
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
    ...filledFields(existing, CARRIED_BEFORE_EXPIRY),
    ...(lifecycle.expiryDate ? { expiryDate: lifecycle.expiryDate } : {}),
    ...filledFields(existing, CARRIED_AFTER_EXPIRY),
    description:
      existing.description ||
      `${normalizeCertificationTitle(title)} validates role-based Microsoft cloud skills.`,
    longDescription:
      existing.longDescription ||
      `${normalizeCertificationTitle(title)} validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.`,
    topics: existing.topics ||
      api?.display_subjects?.slice(0, 4) ||
      api?.display_products?.slice(0, 4) || [normalizeCertificationTitle(title)],
    hours: existing.hours || defaultEffort(level).hours,
    prepTime: existing.prepTime || defaultEffort(level).prepTime,
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

/** One certification per poster entry that a source confirms. */
export function sourcedCertifications({ sources, existingCertifications, report }) {
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
  return nextCertifications;
}

// Rule 3 again, for certifications: the poster drops a retired exam the
// month it retires, and the file must not.
export function keepUnlistedCertifications({ existingCertifications, nextCertifications, kept }) {
  const nextCodes = new Set(nextCertifications.map((cert) => cert.code));
  for (const cert of existingCertifications) {
    if (nextCodes.has(cert.code)) continue;
    nextCertifications.push(cert);
    nextCodes.add(cert.code);
    kept.push(`${cert.code} — ${cert.title} (${cert.status})`);
  }
}
