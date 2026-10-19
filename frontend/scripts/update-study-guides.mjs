/**
 * Refresh the outlines in src/data/azure/study-guides/ from Microsoft Learn
 * (#498) — one module per guide plus an index (#500; the layout, and why, is
 * in scripts/study-guide-files.mjs).
 *
 * For every Azure certification in src/data/azure/certifications.js that
 * carries a `studyGuideUrl` and is not retired, fetch the official study guide
 * and parse its "Skills measured" section into weighted areas, sub-headings
 * and objectives — the table of contents the certification detail page
 * renders, with each area deep-linked to its heading on Microsoft Learn.
 *
 * WHY STATIC DATA, NOT A RUNTIME FETCH. The Listen & Learn generator already
 * parses these guides (functions/src/lib/listen-and-learn/studyguide.js) and
 * this script reuses that parser rather than writing a second one. But the
 * generator only runs when the owner generates a certification's episodes,
 * and on 2026-09-11 exactly one Azure certification had ever been generated.
 * An outline that existed only after a generation run would be missing from
 * nearly every page. So the outline ships as data, like the catalogue: it is
 * in the prerendered HTML for crawlers and readers with JavaScript off, it is
 * versioned, and its freshness is a date the page can print and a test can
 * check.
 *
 * Run by hand with `npm run data:update:study-guides`, and every Monday by
 * .github/workflows/update-learn-catalogue.yml (#499), which stages the
 * catalogue file and this directory by path and nothing else.
 *
 * The same three rules as update-applied-skills.mjs, because the failure
 * modes are the same:
 *
 *   1. Every run stamps today's date into `DATA_AS_OF` and the header line.
 *   2. If NO guide parses, the file is not written and the run exits 1 with
 *      one plain sentence. A guide that fails on its own — a retired exam
 *      redirects to the browse page, which the parser names — is recorded
 *      per exam and does not stop the run: the previously stored outline for
 *      that exam is kept, so one bad fetch cannot erase a good outline.
 *   3. The parser is strict by design and throws rather than returning a
 *      half-parsed guide, so a layout change on Learn surfaces here as a
 *      named failure rather than as five confident, contentless sections.
 *
 * DATE IS ON THE LOCAL CALENDAR, unlike the sibling script, which stamps UTC
 * because the workflow runs on a UTC runner. The data tests compare
 * `DATA_AS_OF` against `todayIso()` from src/lib/certStatus.js, which reads
 * the local clock — and on 2026-09-10 at 23:11 CDT a UTC stamp of 2026-09-11
 * failed six tests as "in the future". Whichever machine runs this must be
 * able to run the tests on the result, so the stamp follows that machine's
 * calendar. When this moves to the cron the runner's local clock IS UTC and
 * the two agree.
 *
 * THIS IMPORTS ACROSS PACKAGES. The parser and cheerio live under functions/,
 * so `node` resolves cheerio from functions/node_modules — run `npm ci` there
 * once. No frontend script did this before; it is preferred to duplicating a
 * parser that was verified against live AZ-104, AZ-305 and GH-500 pages.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStudyGuides, writeStudyGuides } from './study-guide-files.mjs';
import {
  fetchStudyGuide,
  StudyGuideError,
} from '../../functions/src/lib/listen-and-learn/studyguide.js';
import { eligibleCerts } from './study-guide-eligibility.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const catalogueFile = path.join(repoRoot, 'src', 'data', 'azure', 'certifications.js');
const dataDir = path.join(repoRoot, 'src', 'data', 'azure', 'study-guides');

/** The parser key for Microsoft Learn; Azure and GitHub-on-Learn both use it. */
const PROVIDER = 'microsoft';

/** Polite spacing between fetches: this is a documentation site, not an API. */
const PAUSE_MS = 400;

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

/** `YYYY-MM-DD` on the LOCAL calendar — see the header for why not UTC. */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `https://learn.microsoft.com/.../study-guides/az-104` → `az-104`. */
export function guideKey(studyGuideUrl) {
  const tail = String(studyGuideUrl || '')
    .split('?')[0]
    .replace(/\/+$/, '')
    .split('/')
    .pop();
  return tail ? tail.toLowerCase() : null;
}

/**
 * The outline a page needs and nothing the generator needs. `subheadings` is
 * a prompt aid and duplicates `sections[].title`; `weightLow/High` feed the
 * label and are kept for sorting. Objectives are kept verbatim — they are
 * Microsoft's words, which is the point.
 */
export function toOutline(guide) {
  return {
    examCode: guide.examCode,
    title: guide.title,
    sourceUrl: guide.sourceUrl,
    areas: guide.areas.map((area) => ({
      name: area.name,
      slug: area.slug,
      anchor: area.anchor || null,
      weightLabel: area.weightLabel || '',
      weightLow: area.weightLow ?? null,
      weightHigh: area.weightHigh ?? null,
      sections: (area.sections || []).map((section) => ({
        title: section.title,
        objectives: [...section.objectives],
      })),
      // Objectives that sat under no h4 — a few guides list them flat.
      objectives: area.sections?.length ? [] : [...(area.objectives || [])],
    })),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and parse every eligible guide. One failure does not stop the run;
 * it is returned by exam so the summary can name it and the writer can keep
 * the previous outline for that exam.
 */
export async function collectOutlines(
  certs,
  { fetchGuide = fetchStudyGuide, pauseMs = PAUSE_MS } = {}
) {
  const outlines = {};
  const failures = [];
  for (const cert of certs) {
    const key = guideKey(cert.studyGuideUrl);
    if (!key) continue;
    try {
      const guide = await fetchGuide({
        provider: PROVIDER,
        examCode: cert.code,
        sourceUrl: cert.studyGuideUrl,
      });
      outlines[key] = toOutline(guide);
    } catch (error) {
      failures.push({
        key,
        code: cert.code,
        reason: error instanceof StudyGuideError ? error.message : `${error?.message || error}`,
      });
    }
    if (pauseMs) await sleep(pauseMs);
  }
  return { outlines, failures };
}

// eligibleCerts lives in study-guide-eligibility.mjs, which carries no import
// beyond certStatus, so its test runs without the parser's dependencies.
export { eligibleCerts };

function parseArgs(argv) {
  const args = { summaryPath: null, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--summary') {
      args.summaryPath = argv[index + 1] || null;
      index += 1;
    } else if (argv[index] === '--limit') {
      args.limit = Number(argv[index + 1]) || null;
      index += 1;
    }
  }
  return args;
}

async function readExisting() {
  try {
    return await readStudyGuides(dataDir);
  } catch {
    return {};
  }
}

async function main(argv = process.argv.slice(2)) {
  const { summaryPath, limit } = parseArgs(argv);
  const today = todayIso();

  const { certifications } = await import(`${pathToFileURL(catalogueFile).href}?t=${Date.now()}`);
  let certs = eligibleCerts(certifications);
  if (limit) certs = certs.slice(0, limit);
  if (certs.length === 0) {
    throw new SourceError(
      'No Azure certification carries a studyGuideUrl, so nothing was written.'
    );
  }

  const existing = await readExisting();
  const { outlines, failures } = await collectOutlines(certs);

  // Rule 2: nothing parsed means the source is unreachable or has changed
  // shape for everyone; an empty file would be worse than the old one.
  if (Object.keys(outlines).length === 0) {
    throw new SourceError(
      `None of ${certs.length} study guides parsed (first failure: ${failures[0]?.reason || 'unknown'}), so the outlines were not written.`
    );
  }

  // Keep a previously stored outline for any exam that failed this run.
  let kept = 0;
  for (const { key } of failures) {
    if (existing[key] && !outlines[key]) {
      outlines[key] = existing[key];
      kept += 1;
    }
  }

  // One module per guide plus the index. A module whose exam is no longer
  // eligible is deleted, so no orphan outline outlives its catalogue row.
  const { removed } = await writeStudyGuides({ dir: dataDir, outlines, today });

  const lines = [
    `# Study-guide outlines refreshed ${today}`,
    '',
    `- Parsed: ${Object.keys(outlines).length - kept} of ${certs.length} eligible guides`,
    `- Kept from the previous file after a failed fetch: ${kept}`,
    `- Failed: ${failures.length}`,
    ...failures.map((f) => `  - ${f.code} (${f.key}): ${f.reason}`),
    `- Removed because the exam is no longer eligible: ${removed.length}`,
    ...removed.map((name) => `  - ${name}`),
    '',
  ];
  const summary = lines.join('\n');
  if (summaryPath) await fs.writeFile(summaryPath, summary);

  console.log(
    `Wrote ${Object.keys(outlines).length} outlines to ${path.relative(repoRoot, dataDir)}; DATA_AS_OF is now ${today}.`
  );
  console.log('');
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof SourceError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
