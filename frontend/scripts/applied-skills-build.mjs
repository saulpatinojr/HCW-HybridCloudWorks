/**
 * Building the next catalogue from the sources and the file: one row per
 * source entry, with rule 3 deciding lifecycle, and every entry the sources
 * dropped kept as the file has it. The applied skills are built here and the
 * certifications in applied-skills-certs.mjs. Split out of
 * update-applied-skills.mjs, which re-exports `buildCatalogue`.
 */
import { keepUnlistedCertifications, sourcedCertifications } from './applied-skills-certs.mjs';
import { reconcileLifecycle } from './applied-skills-rules.mjs';
import {
  POSTER_ONLY_APPLIED_SKILLS,
  extractAppliedPosterTitles,
  fetchDetail,
} from './applied-skills-sources.mjs';
import {
  inferArea,
  makeCode,
  normalizeTitle,
  normalizeUrl,
  slugFromUrl,
  stripMicrosoftPrefix,
} from './applied-skills-text.mjs';

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
