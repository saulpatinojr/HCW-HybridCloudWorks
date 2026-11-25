/**
 * Derives out-of-component file dependencies (imports and file reads) from tests
 * and asserts that CI path filters in .github/workflows/ci.yml match every one.
 *
 * (QA-4, #979; reads worked out from the parsed code, #1414; imports followed
 * through modules in other packages, #1428)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFileReads, listImports } from './js-file-reads.mjs';
import { parseJobs, parseMatrixRows } from './workflow-text.mjs';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const COMPONENTS = [
  { name: 'frontend', dir: 'frontend' },
  { name: 'functions (azure)', dir: 'functions' },
  { name: 'scripts (operations)', dir: 'scripts' },
  { name: 'vps-agent', dir: 'vps-agent' },
  { name: 'edge (availability probe)', dir: 'edge/availability-probe' },
];

/**
 * Import shortcuts a package uses, by package folder: an import starting with
 * the first value means the second, inside the package. The frontend's `@` is
 * set in frontend/vitest.config.js and frontend/vite.config.js.
 */
const IMPORT_ALIASES = { frontend: [['@/', 'src/']] };

/** File functions that look inside a folder. The others only ask about it (does it exist, what is its size). */
const LISTS_FOLDER = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir', 'cpSync', 'cp']);

/** Files the guard reads as code. An import of anything else (an image, JSON) is only recorded. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Folders whose files are not part of the repository, wherever they are: installed packages and git's own folder.
 * A pull request cannot change a file there, so an import that lands in one is not a dependency of the filter,
 * and the guard does not open it.
 */
const NEVER_REPOSITORY = /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/;

/**
 * Folders that are a package's built output and test coverage, but only when they sit beside the package's
 * package.json (frontend/dist, scripts/coverage). The same names lower down are ordinary folders that git may well
 * track (docs/coverage), and a file there is a dependency like any other.
 */
const BUILD_OUTPUT_FOLDERS = new Set(['dist', 'coverage']);

/** How many times the walk goes on into a module named by an import() with a computed path. */
const MAX_COMPUTED_IMPORT_ROUNDS = 4;

/** A name no real file has, to ask "does this filter match something inside this folder". */
export const DIRECTORY_PROBE = '__ci-filter-probe__';

/** Recursively discover test files inside a component directory. */
export function findTestFiles(dir) {
  let results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage', 'e2e'].includes(entry.name)) continue;
      results = results.concat(findTestFiles(full));
    } else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function resolveFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  for (const ext of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '/index.js', '/index.jsx', '/index.mjs']) {
    const withExt = candidate + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt;
    }
  }
  return null;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `file` is `dir` itself or inside it. */
function isInside(dir, file) {
  const rel = relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The `import '<path>'` text a missing import is reported under, and written under in REVIEWED_READS. */
const importExpression = (spec) => `import '${spec}'`;

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

/** The state of one deriveCrossRootReads run: the modules found so far, and the files, folders and problems noted. */
class CrossRootWalk {
  constructor(compDir, repoRoot, reviewed) {
    this.compDir = compDir;
    this.repoRoot = repoRoot;
    this.reviewed = reviewed;
    this.compDirAbs = join(repoRoot, compDir);
    this.modules = new Map(); // every module the tests pull in, in this package or not: absolute path -> text
    this.cameFrom = new Map(); // module -> the module that first imported it, to say how it was reached
    this.files = new Set();
    this.dirs = new Set();
    this.unresolved = [];
    this.origins = new Map();
    this.missingImports = [];
    this.usedReviewed = new Set();
    // The files do not change while the guard runs, and the same import is asked about many times (once by the walk
    // below and again for each name the analysis follows), so each answer from the disk is kept.
    this.fileOnDisk = new Map();
    this.specAnswers = new Map();
    this.packageFolders = new Map(); // folder -> whether it holds a package.json
  }

  toRepoPath(abs) {
    return relative(this.repoRoot, abs).replace(/\\/g, '/');
  }

  remember(path, where) {
    if (!this.origins.has(path)) this.origins.set(path, new Set());
    this.origins.get(path).add(where);
  }

  findFile(candidate) {
    if (!this.fileOnDisk.has(candidate)) this.fileOnDisk.set(candidate, resolveFile(candidate));
    return this.fileOnDisk.get(candidate);
  }

  hasPackageJson(folder) {
    if (!this.packageFolders.has(folder)) this.packageFolders.set(folder, existsSync(join(folder, 'package.json')));
    return this.packageFolders.get(folder);
  }

  /** Whether `abs` is in a package's own dist or coverage folder, the build output and coverage report that git does not track. */
  isBuildOutput(abs) {
    let folder = this.repoRoot;
    for (const part of relative(this.repoRoot, abs).split(/[\\/]/)) {
      if (BUILD_OUTPUT_FOLDERS.has(part) && this.hasPackageJson(folder)) return true;
      folder = join(folder, part);
    }
    return false;
  }

  /** Whether `abs` is a path a pull request can change: inside the repository, and not installed or built. */
  isRepositoryFile(abs) {
    return isInside(this.repoRoot, abs) && !NEVER_REPOSITORY.test(relative(this.repoRoot, abs)) && !this.isBuildOutput(abs);
  }

  /** The shortcuts that apply to an import written in `from`: this package's (what the tests run with), and its own package's. */
  aliasesFor(from) {
    const found = [];
    for (const [dir, list] of Object.entries(IMPORT_ALIASES)) {
      const base = join(this.repoRoot, dir);
      if (dir === this.compDir || isInside(base, from)) for (const [prefix, target] of list) found.push([prefix, join(base, target)]);
    }
    return found;
  }

  /**
   * What an import written in `from` means: `{ file }` for a repository file that exists, `{ missing }` for a
   * repository path with no file behind it, and `{}` for what is not a repository path (a package name, a file in
   * node_modules or in built output).
   */
  resolveSpec(rawSpec, from) {
    const key = JSON.stringify([from, rawSpec]);
    if (!this.specAnswers.has(key)) this.specAnswers.set(key, this.workOutSpec(rawSpec, from));
    return this.specAnswers.get(key);
  }

  workOutSpec(rawSpec, from) {
    const spec = rawSpec.replace(/[?#].*$/, ''); // "../guide.md?raw" names the file ../guide.md
    const candidate = this.candidateFor(spec, from);
    if (candidate === null || !this.isRepositoryFile(candidate)) return {};
    const file = this.findFile(candidate);
    if (file === null) return { missing: true };
    return this.isRepositoryFile(file) ? { file } : {};
  }

  /** The path an import names before any file ending is tried: relative to `from`, or through a shortcut; null for a package name. */
  candidateFor(spec, from) {
    if (spec.startsWith('.')) return resolve(dirname(from), spec);
    const alias = this.aliasesFor(from).find(([prefix]) => spec.startsWith(prefix));
    return alias ? join(alias[1], spec.slice(alias[0].length)) : null;
  }

  /** How a module was reached from a test, as the chain of modules: [test, module, ..., file]. */
  route(file) {
    const chain = [file];
    for (let from = this.cameFrom.get(file); from; from = this.cameFrom.get(from)) chain.unshift(from);
    return chain;
  }

  /**
   * For a message: the chain of modules from a test to `file` ("frontend/src/a.test.jsx > functions/src/lib/b.js"),
   * when a module outside the package is on the way, else "". `file` itself is not part of the text.
   */
  reachedFrom(file) {
    const chain = this.route(file);
    if (chain.every((module) => isInside(this.compDirAbs, module))) return '';
    const before = chain.slice(0, -1).map((abs) => this.toRepoPath(abs));
    return before.length > 3 ? `${before[0]} > ... > ${before.slice(-2).join(' > ')}` : before.join(' > ');
  }

  viaText(file) {
    return this.reachedFrom(file) ? `reached from ${this.reachedFrom(file)}` : '';
  }

  /** Read each module from `starts` on, and every module it imports in turn. */
  follow(starts) {
    const queue = [...starts];
    while (queue.length > 0) {
      const current = queue.shift();
      if (this.modules.has(current)) continue;
      const content = readFileSync(current, 'utf8');
      const { specs, ast } = listImports(content);
      this.modules.set(current, { text: content, ast }); // the tree is kept so that findFileReads does not parse the text again
      for (const { spec, line } of specs) this.followImport(current, spec, line, queue);
    }
  }

  /** One import in module `current`: note a file outside the component, and queue a code file not read yet. */
  followImport(current, spec, line, queue) {
    const { file: resolved, missing } = this.resolveSpec(spec, current);
    if (missing) {
      // inside the package a missing file is a broken test; outside it, it is a module whose reads and imports are unknown
      if (!isInside(this.compDirAbs, current)) this.missingImports.push({ module: current, line, spec });
      return;
    }
    if (!resolved) return;
    if (!isInside(this.compDirAbs, resolved)) {
      const via = this.viaText(current);
      this.files.add(this.toRepoPath(resolved));
      this.remember(this.toRepoPath(resolved), `${this.toRepoPath(current)} (import${via ? `, ${via}` : ''})`);
    }
    if (CODE_FILE.test(resolved) && !this.modules.has(resolved)) {
      if (!this.cameFrom.has(resolved)) this.cameFrom.set(resolved, current);
      queue.push(resolved);
    }
  }

  isReviewed(repoFile, expression) {
    const entry = this.reviewed.find((e) => e.file === repoFile && (e.expression === undefined || e.expression === expression));
    if (entry) this.usedReviewed.add(entry);
    return Boolean(entry);
  }

  /** Every module's reads, as findFileReads works them out over the modules found so far. */
  analyse() {
    const resolveImport = (spec, from) => {
      const { file } = this.resolveSpec(spec, from);
      return file && this.modules.has(file) ? file : null;
    };
    return findFileReads({ modules: this.modules, probeFile: (candidate) => this.findFile(candidate), cwd: this.compDirAbs, resolveImport }).references;
  }

  /** Whether `path`, named by an import() or require() worked out at run time, is a repository module not read yet. */
  isNewModule(path) {
    return CODE_FILE.test(path) && this.isRepositoryFile(path) && existsSync(path) && !this.modules.has(path);
  }

  /** The repository modules the references' import() and require() calls name that the walk has not read yet. */
  newlyNamedModules(references) {
    const named = [];
    for (const reference of references) {
      if (reference.primitive !== 'import()' && reference.primitive !== 'require') continue;
      for (const { kind, path } of reference.results) {
        if (kind === 'file' && this.isNewModule(path) && !named.some((n) => n.file === path)) named.push({ file: path, reference });
      }
    }
    return named;
  }

  /**
   * Work out every file the modules read. An import() or require() whose path is worked out at run time can
   * still name one file; that file is a module too, so the walk goes on into it and the reads are worked out
   * again (a few times at most; each round adds files, so it ends). Returns the last round's references.
   */
  followComputedImports() {
    let references = this.analyse();
    for (let round = 1; ; round++) {
      const named = this.newlyNamedModules(references);
      if (named.length === 0) break;
      if (round > MAX_COMPUTED_IMPORT_ROUNDS) {
        this.reportTooDeep(named);
        break;
      }
      for (const { file, reference } of named) if (!this.cameFrom.has(file)) this.cameFrom.set(file, reference.file);
      this.follow(named.map((n) => n.file));
      references = this.analyse();
    }
    return references;
  }

  reportTooDeep(named) {
    for (const { reference } of named) {
      const readerFile = this.toRepoPath(reference.file);
      if (this.isReviewed(readerFile, reference.expression)) continue;
      this.unresolved.push({
        file: readerFile,
        line: reference.line,
        expression: reference.expression,
        reason: `modules named by an import() or require() whose path is worked out at run time lead more than ${MAX_COMPUTED_IMPORT_ROUNDS} levels deep, so what the last ones read and import is not followed`,
      });
    }
  }

  /** Whether a path a reference reads is outside the component and a repository file that is there. */
  isOutsideRead(path) {
    if (isInside(this.compDirAbs, path) || !isInside(this.repoRoot, path)) return false;
    // a path that is not there is not being read (a test that checks something is absent)
    if (!existsSync(path)) return false;
    // installed packages and built output are not repository files
    return this.isRepositoryFile(path);
  }

  /** Note the files and folders one reference reads, and what about it could not be worked out. */
  recordReads(reference) {
    const readerFile = this.toRepoPath(reference.file);
    const via = this.viaText(reference.file);
    const where = `${readerFile}:${reference.line}${via ? ` (${via})` : ''}`;
    const reviewedRead = this.isReviewed(readerFile, reference.expression);

    for (const { kind, path } of reference.results) {
      if (!this.isOutsideRead(path)) continue;
      this.recordRead(reference, { kind, path, readerFile, where, reviewedRead });
    }
    if (reviewedRead) return;
    for (const reason of reference.unresolved) {
      this.unresolved.push({ file: readerFile, line: reference.line, expression: reference.expression, reason });
    }
  }

  recordRead(reference, { kind, path, readerFile, where, reviewedRead }) {
    const isFolder = kind === 'dir' || isDirectory(path);
    // new URL(...) of a folder is only a base for building file paths, and a folder that is only
    // checked for, or looked at (existsSync, statSync), is not a dependency on what is in it
    if (isFolder && (reference.primitive === 'new URL' || (kind === 'file' && !LISTS_FOLDER.has(reference.primitive)))) return;
    // a read a person has looked at is not held to the filter for folders or for what the guard cannot work out;
    // a plain file it names still is, so an exemption can never hide a file the filter should match
    if (reviewedRead && isFolder) return;
    if (isFolder && relative(this.repoRoot, path) === '') {
      this.unresolved.push({ file: readerFile, line: reference.line, expression: reference.expression, reason: 'it reads a file directly under the repository root and the guard does not know which one' });
      return;
    }
    const repoPath = isFolder ? `${this.toRepoPath(path)}/` : this.toRepoPath(path);
    (isFolder ? this.dirs : this.files).add(repoPath);
    this.remember(repoPath, where);
  }

  reportMissingImports() {
    for (const { module, line, spec } of this.missingImports) {
      const readerFile = this.toRepoPath(module);
      const expression = importExpression(spec);
      if (this.isReviewed(readerFile, expression)) continue;
      const reached = this.reachedFrom(module);
      this.unresolved.push({
        file: readerFile,
        line,
        expression,
        reason:
          'no file is found at that path, so the guard cannot tell what that file reads or imports in turn (it may be made by a build step, or be a path the guard does not understand, or a mistake)' +
          (reached ? `. The module with this import is reached from ${reached}` : ''),
      });
    }
  }

  result() {
    const insideHere = (entry) => isInside(this.compDirAbs, join(this.repoRoot, entry.file));
    const unusedReviewed = this.reviewed.filter((entry) => insideHere(entry) && !this.usedReviewed.has(entry));
    return { files: this.files, dirs: this.dirs, unresolved: this.unresolved, unusedReviewed, usedReviewed: this.usedReviewed, origins: this.origins };
  }
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
