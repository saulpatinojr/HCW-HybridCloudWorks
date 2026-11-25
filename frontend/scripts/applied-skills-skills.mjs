/**
 * The applied skills half of the Learn catalogue (moved out of
 * update-applied-skills.mjs by #1845): the site area a skill belongs to,
 * one skill from the browse API, its detail page and the file, the
 * poster-only skills, and rule 3's kept entries.
 */
import {
  makeCode,
  normalizeTitle,
  normalizeUrl,
  reconcileLifecycle,
  slugFromUrl,
  stripMicrosoftPrefix,
} from './applied-skills-names.mjs';
import {
  POSTER_ONLY_APPLIED_SKILLS,
  extractAppliedPosterTitles,
} from './applied-skills-posters.mjs';
import { fetchDetail } from './applied-skills-sources.mjs';

/**
 * The site's area for an applied skill, from words in its subjects, products
 * and title. The first row with a matching word wins, so the order matters:
 * a Kubernetes security skill is Security, not Containers. "data " keeps its
 * space so that words such as "update" do not count.
 */
const AREA_KEYWORDS = [
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
  const row = AREA_KEYWORDS.find(([, words]) => words.some((word) => combined.includes(word)));
  return row ? row[0] : 'AI';
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
 * What an applied skill's detail page says about its lifecycle: no opinion
 * when the page did not answer; otherwise the retirement banner decides.
 */
function sourcedSkillLifecycle(detail) {
  if (!detail.known) return {};
  if (detail.retirementDate) return { status: 'expiring', expiryDate: detail.retirementDate };
  return { status: 'active' };
}

/** One applied skill from the browse API's record, its detail page and the file's entry. */
function buildSkillFromSource({ result, slug, code, existing, detail, disagreements }) {
  const lifecycle = reconcileLifecycle({
    existing,
    sourced: sourcedSkillLifecycle(detail),
    label: `${code} (${slug})`,
    report: disagreements,
  });
  return {
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
  };
}

/** Every applied skill the browse API lists, each with its detail page read. */
export async function skillsFromSources({
  browseResults,
  existingSkills,
  usedCodes,
  fetchImpl,
  disagreements,
}) {
  const { bySlug, byTitle } = buildExistingIndexes(existingSkills);
  const skills = [];
  for (const result of browseResults) {
    const slug = slugFromUrl(result.url);
    const existing = bySlug.get(slug) || byTitle.get(normalizeTitle(result.title)) || {};
    const detail = await fetchDetail(result, fetchImpl);
    const code =
      existing.code && !usedCodes.has(existing.code) ? existing.code : makeCode(slug, usedCodes);
    usedCodes.add(code);
    skills.push(buildSkillFromSource({ result, slug, code, existing, detail, disagreements }));
  }
  return skills;
}

/** The poster-only skills the Applied Skills poster lists and the API does not, added in place. */
export function addPosterOnlySkills({ nextSkills, appliedPosterText, usedCodes }) {
  const appliedPosterTitles = extractAppliedPosterTitles(appliedPosterText);
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
  return nextSlugs;
}

/**
 * Rule 3: an applied skill the sources no longer list stays, as the file
 * has it. A retired skill drops out of the browse API, and dropping it here
 * would erase the retirement the file records. Added in place, with one
 * report line each on `kept`.
 */
export function keepUnlistedSkills({ nextSkills, nextSlugs, existingSkills, usedCodes, kept }) {
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
