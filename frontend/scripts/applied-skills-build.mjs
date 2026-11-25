/**
 * Building the next catalogue from the sources and the file: one row per
 * source entry, with rule 3 deciding lifecycle, and every entry the sources
 * dropped kept as the file has it. Split out of update-applied-skills.mjs,
 * which re-exports `buildCatalogue` and `buildCertificationFromSources`.
 */
import { foreignOwnerFor, reconcileLifecycle } from './applied-skills-rules.mjs';
import {
  POSTER_ONLY_APPLIED_SKILLS,
  extractAppliedPosterTitles,
  fetchDetail,
} from './applied-skills-sources.mjs';
import {
  extractCodeFromExam,
  inferArea,
  inferCertificationLevel,
  makeCode,
  normalizeCertificationTitle,
  normalizeTitle,
  normalizeUrl,
  slugFromUrl,
  slugify,
  sourcedCertificationLifecycle,
  stripMicrosoftPrefix,
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
  const usedCodes = new Set();

  const nextSkills = await sourcedSkills({
    browseResults: sources.browseResults,
    indexes: buildExistingIndexes(existingSkills),
    usedCodes,
    disagreements,
    fetchImpl,
  });

  const nextSlugs = new Set(nextSkills.map((skill) => skill.slug));
  addPosterOnlySkills({
    nextSkills,
    nextSlugs,
    usedCodes,
    appliedPosterText: sources.appliedPosterText,
  });
  keepUnlistedSkills({ existingSkills, nextSkills, nextSlugs, usedCodes, kept });

  nextSkills.sort((a, b) => a.title.localeCompare(b.title));
  assertUniqueCodes(nextSkills, 'Applied Skills');

  const nextCertifications = sourcedCertifications({
    sources,
    existingCertifications,
    report: { disagreements, unverified, foreign },
  });
  keepUnlistedCertifications({ existingCertifications, nextCertifications, kept });
  nextCertifications.sort((a, b) => a.code.localeCompare(b.code));
  assertUniqueCodes(nextCertifications, 'Certifications');

  return { nextSkills, nextCertifications, kept, disagreements, unverified, foreign };
}

// The phases of buildCatalogue, in the order it runs them.

/** One applied skill per browse result, each read through its detail page. */
async function sourcedSkills({ browseResults, indexes, usedCodes, disagreements, fetchImpl }) {
  const { bySlug, byTitle } = indexes;
  const nextSkills = [];
  for (const result of browseResults) {
    const slug = slugFromUrl(result.url);
    const existing = bySlug.get(slug) || byTitle.get(normalizeTitle(result.title)) || {};
    const detail = await fetchDetail(result, fetchImpl);
    const code =
      existing.code && !usedCodes.has(existing.code) ? existing.code : makeCode(slug, usedCodes);
    usedCodes.add(code);

    const lifecycle = reconcileLifecycle({
      existing,
      sourced: lifecycleFromDetail(detail),
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
  return nextSkills;
}

// No opinion when the page did not answer; otherwise the banner decides.
function lifecycleFromDetail(detail) {
  if (!detail.known) return {};
  return detail.retirementDate
    ? { status: 'expiring', expiryDate: detail.retirementDate }
    : { status: 'active' };
}

/** The applied skills only the poster lists, added when the poster still shows them. */
function addPosterOnlySkills({ nextSkills, nextSlugs, usedCodes, appliedPosterText }) {
  const appliedPosterTitles = extractAppliedPosterTitles(appliedPosterText);
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
}

// Rule 3: an applied skill the sources no longer list stays, as the file
// has it. A retired skill drops out of the browse API, and dropping it here
// would erase the retirement the file records.
function keepUnlistedSkills({ existingSkills, nextSkills, nextSlugs, usedCodes, kept }) {
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
}

/** One certification per poster entry that a source confirms. */
function sourcedCertifications({ sources, existingCertifications, report }) {
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
function keepUnlistedCertifications({ existingCertifications, nextCertifications, kept }) {
  const nextCodes = new Set(nextCertifications.map((cert) => cert.code));
  for (const cert of existingCertifications) {
    if (nextCodes.has(cert.code)) continue;
    nextCertifications.push(cert);
    nextCodes.add(cert.code);
    kept.push(`${cert.code} — ${cert.title} (${cert.status})`);
  }
}
