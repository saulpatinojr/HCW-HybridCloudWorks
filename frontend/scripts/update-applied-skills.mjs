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
import prettier from 'prettier';
import { buildCatalogue } from './applied-skills-build.mjs';
import { SourceError, stampSyncDate, summarizeChanges, todayIso } from './applied-skills-rules.mjs';
import { collectSources } from './applied-skills-sources.mjs';

// The work is split by job into five sibling files: the rules, the text
// helpers, reading the sources, and building the next catalogue's applied
// skills and certifications. What this
// file used to export is re-exported here, so the test and any caller keep
// one import path.
export {
  LIFECYCLE_RANK,
  FOREIGN_CODE_PATTERN,
  foreignOwnerFor,
  SourceError,
  todayIso,
  assertSourceItems,
  stampSyncDate,
  reconcileLifecycle,
  summarizeChanges,
} from './applied-skills-rules.mjs';
export { extractCertificationPosterEntries, collectSources } from './applied-skills-sources.mjs';
export { buildCatalogue } from './applied-skills-build.mjs';
export { buildCertificationFromSources } from './applied-skills-certs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataFile = path.join(repoRoot, 'src', 'data', 'azure', 'certifications.js');

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

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not locate block between ${startMarker} and ${endMarker}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
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
