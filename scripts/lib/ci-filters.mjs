/**
 * Derives out-of-component file dependencies (imports and file reads) from tests
 * and asserts that CI path filters in .github/workflows/ci.yml match every one.
 *
 * (QA-4, #979; reads worked out from the parsed code, #1414; imports followed
 * through modules in other packages, #1428)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, parseMatrixRows } from './workflow-text.mjs';
import { findTestFiles } from './ci-filters-paths.mjs';
import { CrossRootWalk } from './ci-filters-reads.mjs';

// How the guard is split: ci-filters-paths.mjs says where a path lands on disk, ci-filters-walk.mjs follows the
// imports from module to module, and ci-filters-reads.mjs holds what the modules read to the filter.
export { findTestFiles };

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const COMPONENTS = [
  { name: 'frontend', dir: 'frontend' },
  { name: 'functions (azure)', dir: 'functions' },
  { name: 'scripts (operations)', dir: 'scripts' },
  { name: 'vps-agent', dir: 'vps-agent' },
  { name: 'edge (availability probe)', dir: 'edge/availability-probe' },
];

/** A name no real file has, to ask "does this filter match something inside this folder". */
export const DIRECTORY_PROBE = '__ci-filter-probe__';

/**
 * Derive the out-of-component files and folders that tests (and the modules
 * and helpers they import, in this package and in others) import or read.
 *
 * The guard starts from the package's test files and follows every import
 * written with a plain path (`import`, `export ... from`, `import('x')`,
 * `require('x')`, `vi.mock('x')`; see `listImports`), through the package's own
 * modules and through the modules of other packages, to the end of the chain.
 * An `import()` or `require()` whose path is worked out at run time is followed
 * too when it names one file (a few levels deep at most). A module outside the
 * package is treated like one inside it: the files it imports are dependencies
 * of the package's tests, and so are the files it reads when a test runs its
 * code (at the top of the module, or in a function the test can reach). What
 * is left out because a pull request cannot change it: a package name, a path
 * through `node_modules` or `.git`, and the `dist` and `coverage` folders that
 * sit beside a `package.json`.
 *
 * `reviewed` lists reads a person has looked at, each as
 * `{ file, expression?, reason }` (see ci-filters.test.mjs). A read matches an
 * entry when it is in `file` and, if the entry has an `expression`, is written
 * exactly that way. For such a read the folders it reads, and whatever the
 * guard could not work out, are not held to the filter; a plain file it names
 * still is. `file` may be in any package: a read made by a functions module
 * that a frontend test imports is reviewed under the functions module's name.
 *
 * Returns:
 *  - `files`: repository paths of files read or imported from outside the
 *    component.
 *  - `dirs`: repository paths (ending in "/") of folders whose contents are
 *    read, where the code builds the file name at run time. A filter must match
 *    something inside each one.
 *  - `unresolved`: reads whose path the guard could not work out, and imports
 *    in modules outside the package whose file cannot be found (written as
 *    `import '<path>'`). These are never skipped; the test fails on them (#1414, #1428).
 *  - `unusedReviewed`: entries of `reviewed` for files inside this package that
 *    matched nothing in this analysis, so a stale entry cannot stay behind. An
 *    entry may be matched by another package's analysis (see `usedReviewed`).
 *  - `usedReviewed`: the entries of `reviewed`, for any package, that matched a
 *    read in this analysis.
 *  - `origins`: for each path above, where it is read, to put in messages.
 */
export function deriveCrossRootReads(compDir, repoRoot = DEFAULT_REPO_ROOT, { reviewed = [] } = {}) {
  const walk = new CrossRootWalk(compDir, repoRoot, reviewed);
  // 1. Find every module the tests pull in, following imports inside the
  //    component and in other packages, and note the files outside the
  //    component that they import. A module's imports are read from its code
  //    (see listImports), so an import in a comment or a string is not one.
  walk.follow(findTestFiles(walk.compDirAbs));
  // 2. Work out every file the modules read, going on into modules an import() or require() names at run time.
  const references = walk.followComputedImports();
  // 3. Hold each read to the filter, or report what could not be worked out.
  for (const reference of references) walk.recordReads(reference);
  // An import whose file cannot be found hides what that file reads and imports in turn.
  walk.reportMissingImports();
  return walk.result();
}

const readCiYml = () => readFileSync(join(DEFAULT_REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/**
 * The rows of the verify job's matrix, as the `changes` job holds them
 * (#1545, the third pull request): the `ROWS` list of its "Build the verify
 * matrix" step (name, id, dir, node-version, the commands, `always`), each
 * joined to the filter of the detect step its `id` names. A row whose step
 * is missing, or a step with no FILTER, throws: a quiet read would let a row
 * fall out of every check that reads this.
 */
export function verifyRows(ciYmlContent = readCiYml()) {
  const changes = parseJobs(ciYmlContent).find((job) => job.key === 'changes');
  if (!changes) throw new Error('ci.yml has no changes job');
  const build = changes.steps.find((step) => step.name === 'Build the verify matrix');
  if (!build?.env.ROWS) throw new Error('the changes job has no "Build the verify matrix" step with a ROWS block');
  const rows = parseMatrixRows(build.env.ROWS.split('\n'), 0);
  if (rows.length === 0) throw new Error('the ROWS block holds no rows');
  return rows.map((row) => {
    const step = changes.steps.find((candidate) => candidate.id === row.id);
    if (!step?.env.FILTER) throw new Error(`verify row ${row.name}: no detect step with id ${row.id} and a FILTER`);
    return { ...row, always: row.always === 'true', filter: step.env.FILTER, regex: new RegExp(step.env.FILTER), step };
  });
}

/** The verify rows' filters by package folder: { name, filter, regex }, as the guard test reads them. */
export function parseCiFilters(ciYmlContent = readCiYml()) {
  const filters = new Map();
  for (const { name, dir, filter, regex } of verifyRows(ciYmlContent)) filters.set(dir, { name, filter, regex });
  return filters;
}

/** The file every detect step adds to its filter: a change to ci.yml runs every verify row. */
const CI_YML = '.github/workflows/ci.yml';

/**
 * What the "Build the verify matrix" step produces for a pull request that
 * changed `changedFiles` (or for any other event, where every row runs),
 * worked out in JavaScript from the same rows and filters: the matrix the
 * verify job reads, `{ include: [...] }`, with the rows in their written
 * order, each carrying `relevant` as a string the way a step output is. The
 * `id` and `always` keys are the build step's own and are left out, as it
 * leaves them out.
 */
export function verifyMatrix(changedFiles, { event = 'pull_request', rows = verifyRows() } = {}) {
  const include = [];
  const buildStepOwn = new Set(['id', 'always', 'filter', 'regex', 'step']);
  for (const row of rows) {
    const matrixRow = Object.fromEntries(Object.entries(row).filter(([key]) => !buildStepOwn.has(key)));
    const relevant = event !== 'pull_request' || changedFiles.some((file) => file === CI_YML || row.regex.test(file));
    if (relevant || row.always) include.push({ ...matrixRow, relevant: String(relevant) });
  }
  return { include };
}
