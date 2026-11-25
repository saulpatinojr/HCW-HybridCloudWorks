/**
 * Refresh the Azure certification catalogue from Microsoft Learn.
 *
 * Writes two files. The certification and applied-skill rows go to
 * src/data/azure/generated/certifications.js, which this script rewrites
 * whole (#1845: in a folder .qlty/qlty.toml excludes, so Qlty's duplicate
 * finder skips rows that look alike by design). src/data/azure/certifications.js
 * re-exports them and keeps the hand-written parts; this script only stamps
 * its sync date there.
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
import prettier from 'prettier';

import { certificationsFromSources } from './applied-skills-certifications.mjs';
import { assertUniqueCodes } from './applied-skills-names.mjs';
import {
  addPosterOnlySkills,
  keepUnlistedSkills,
  skillsFromSources,
} from './applied-skills-skills.mjs';
import { SourceError, collectSources } from './applied-skills-sources.mjs';

// The work is split by job into sibling modules (#1845): the sources and
// their rule 2 in applied-skills-sources.mjs, the poster text in
// applied-skills-posters.mjs, the shared names and rule 3 in
// applied-skills-names.mjs, and each catalogue in
// applied-skills-certifications.mjs and applied-skills-skills.mjs. What
// update-applied-skills.test.js reads is re-exported here.
export {
  FOREIGN_CODE_PATTERN,
  buildCertificationFromSources,
  foreignOwnerFor,
} from './applied-skills-certifications.mjs';
export { LIFECYCLE_RANK, reconcileLifecycle } from './applied-skills-names.mjs';
export { extractCertificationPosterEntries } from './applied-skills-posters.mjs';
export { inferArea } from './applied-skills-skills.mjs';
export { SourceError, assertSourceItems, collectSources } from './applied-skills-sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
// certifications.js keeps DATA_AS_OF, the sync-date header and the
// hand-written history; generated/certifications.js holds the rows.
const dataFile = path.join(repoRoot, 'src', 'data', 'azure', 'certifications.js');
const generatedFile = path.join(repoRoot, 'src', 'data', 'azure', 'generated', 'certifications.js');

/** `YYYY-MM-DD` on the UTC calendar — the workflow runs on a UTC runner. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
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
  return `${lines.join('\n').trimEnd()}\n`;
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

// The generated file's opening comment is kept as it stands: everything
// before the first block marker, so an edit to that explanation is not undone
// by the next run.
const CERTIFICATION_MARKER = "// status: 'active' | 'beta' | 'expiring' | 'retired'";

function generatedHeader(source) {
  const start = source.indexOf(CERTIFICATION_MARKER);
  if (start === -1) {
    throw new Error(
      `generated/certifications.js no longer starts its rows with "${CERTIFICATION_MARKER}", so the header could not be kept.`
    );
  }
  return source.slice(0, start);
}

async function formatLike(file, text) {
  return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
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
  const report = { kept: [], disagreements: [], unverified: [], foreign: [] };
  const usedCodes = new Set();

  const nextSkills = await skillsFromSources({
    browseResults: sources.browseResults,
    existingSkills,
    usedCodes,
    fetchImpl,
    disagreements: report.disagreements,
  });
  const nextSlugs = addPosterOnlySkills({
    nextSkills,
    appliedPosterText: sources.appliedPosterText,
    usedCodes,
  });
  keepUnlistedSkills({ nextSkills, nextSlugs, existingSkills, usedCodes, kept: report.kept });
  nextSkills.sort((a, b) => a.title.localeCompare(b.title));
  assertUniqueCodes(nextSkills, 'Applied Skills');

  const nextCertifications = certificationsFromSources({
    sources,
    existingCertifications,
    report,
  });

  return { nextSkills, nextCertifications, ...report };
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
  const moduleUrl = pathToFileURL(generatedFile).href;
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

  // Read both files before writing either, so a failure to stamp the date
  // (rule 1) leaves both untouched.
  const generatedSource = await fs.readFile(generatedFile, 'utf8');
  const source = await fs.readFile(dataFile, 'utf8');
  const nextSource = await formatLike(dataFile, stampSyncDate(source, today));
  const nextGenerated = await formatLike(
    generatedFile,
    `${generatedHeader(generatedSource)}${renderCertificationBlock(nextCertifications)}${renderAppliedSkillsBlock(nextSkills)}`
  );

  await fs.writeFile(generatedFile, nextGenerated);
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
      generatedFile
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
