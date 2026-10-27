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
 * Folders whose files are not part of the repository: installed packages, built output, test coverage, git's own
 * folder. A pull request cannot change a file there, so an import that lands in one is not a dependency of the
 * filter, and the guard does not open it.
 */
const NOT_REPOSITORY = /(?:^|[\\/])(?:node_modules|dist|coverage|\.git)(?:[\\/]|$)/;

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
 * code (at the top of the module, or in a function the test can reach). A
 * file only reached through `node_modules` or a built folder is not a
 * repository file and is left out, and neither is a package name.
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
  const compDirAbs = join(repoRoot, compDir);
  const testFiles = findTestFiles(compDirAbs);
  const modules = new Map(); // every module the tests pull in, in this package or not: absolute path -> text
  const cameFrom = new Map(); // module -> the module that first imported it, to say how it was reached
  const files = new Set();
  const dirs = new Set();
  const unresolved = [];
  const origins = new Map();
  const toRepoPath = (abs) => relative(repoRoot, abs).replace(/\\/g, '/');
  const remember = (path, where) => {
    if (!origins.has(path)) origins.set(path, new Set());
    origins.get(path).add(where);
  };
  const isRepositoryFile = (abs) => isInside(repoRoot, abs) && !NOT_REPOSITORY.test(relative(repoRoot, abs));
  // The files do not change while the guard runs, and the same import is asked about many times (once by the walk
  // below and again for each name the analysis follows), so each answer from the disk is kept.
  const fileOnDisk = new Map();
  const findFile = (candidate) => {
    if (!fileOnDisk.has(candidate)) fileOnDisk.set(candidate, resolveFile(candidate));
    return fileOnDisk.get(candidate);
  };
  const specAnswers = new Map();

  /** The shortcuts that apply to an import written in `from`: this package's (what the tests run with), and its own package's. */
  const aliasesFor = (from) => {
    const found = [];
    for (const [dir, list] of Object.entries(IMPORT_ALIASES)) {
      const base = join(repoRoot, dir);
      if (dir === compDir || isInside(base, from)) for (const [prefix, target] of list) found.push([prefix, join(base, target)]);
    }
    return found;
  };

  /**
   * What an import written in `from` means: `{ file }` for a repository file that exists, `{ missing }` for a
   * repository path with no file behind it, and `{}` for what is not a repository path (a package name, a file in
   * node_modules or in built output).
   */
  const resolveSpec = (rawSpec, from) => {
    const key = JSON.stringify([from, rawSpec]);
    if (!specAnswers.has(key)) specAnswers.set(key, workOutSpec(rawSpec, from));
    return specAnswers.get(key);
  };
  const workOutSpec = (rawSpec, from) => {
    const spec = rawSpec.replace(/[?#].*$/, ''); // "../guide.md?raw" names the file ../guide.md
    let candidate = null;
    if (spec.startsWith('.')) {
      candidate = resolve(dirname(from), spec);
    } else {
      for (const [prefix, target] of aliasesFor(from)) {
        if (spec.startsWith(prefix)) {
          candidate = join(target, spec.slice(prefix.length));
          break;
        }
      }
    }
    if (candidate === null || !isRepositoryFile(candidate)) return {};
    const file = findFile(candidate);
    if (file === null) return { missing: true };
    return isRepositoryFile(file) ? { file } : {};
  };

  /** How a module was reached from a test, as the chain of modules: [test, module, ..., file]. */
  const route = (file) => {
    const chain = [file];
    for (let from = cameFrom.get(file); from; from = cameFrom.get(from)) chain.unshift(from);
    return chain;
  };
  /**
   * For a message: the chain of modules from a test to `file` ("frontend/src/a.test.jsx > functions/src/lib/b.js"),
   * when a module outside the package is on the way, else "". `file` itself is not part of the text.
   */
  const reachedFrom = (file) => {
    const chain = route(file);
    if (chain.every((module) => isInside(compDirAbs, module))) return '';
    const before = chain.slice(0, -1).map(toRepoPath);
    return before.length > 3 ? `${before[0]} > ... > ${before.slice(-2).join(' > ')}` : before.join(' > ');
  };
  const viaText = (file) => (reachedFrom(file) ? `reached from ${reachedFrom(file)}` : '');

  // 1. Find every module the tests pull in, following imports inside the
  //    component and in other packages, and note the files outside the
  //    component that they import. A module's imports are read from its code
  //    (see listImports), so an import in a comment or a string is not one.
  const missingImports = [];
  const follow = (starts) => {
    const queue = [...starts];
    while (queue.length > 0) {
      const current = queue.shift();
      if (modules.has(current)) continue;
      const content = readFileSync(current, 'utf8');
      const { specs, ast } = listImports(content);
      modules.set(current, { text: content, ast }); // the tree is kept so that findFileReads does not parse the text again
      const outside = !isInside(compDirAbs, current);

      for (const { spec, line } of specs) {
        const { file: resolved, missing } = resolveSpec(spec, current);
        if (missing) {
          // inside the package a missing file is a broken test; outside it, it is a module whose reads and imports are unknown
          if (outside) missingImports.push({ module: current, line, spec });
          continue;
        }
        if (!resolved) continue;
        if (!isInside(compDirAbs, resolved)) {
          files.add(toRepoPath(resolved));
          remember(toRepoPath(resolved), `${toRepoPath(current)} (import${viaText(current) ? `, ${viaText(current)}` : ''})`);
        }
        if (CODE_FILE.test(resolved) && !modules.has(resolved)) {
          if (!cameFrom.has(resolved)) cameFrom.set(resolved, current);
          queue.push(resolved);
        }
      }
    }
  };
  follow(testFiles);

  const usedReviewed = new Set();
  const isReviewed = (repoFile, expression) => {
    const entry = reviewed.find((e) => e.file === repoFile && (e.expression === undefined || e.expression === expression));
    if (entry) usedReviewed.add(entry);
    return Boolean(entry);
  };

  // 2. Work out every file the modules read. An import() or require() whose path is worked out at run time can
  //    still name one file; that file is a module too, so the walk goes on into it and the reads are worked out
  //    again (a few times at most; each round adds files, so it ends).
  const probe = { modules, probeFile: findFile, cwd: compDirAbs };
  const resolveImport = (spec, from) => {
    const { file } = resolveSpec(spec, from);
    return file && modules.has(file) ? file : null;
  };
  let { references } = findFileReads({ ...probe, resolveImport });
  for (let round = 1; ; round++) {
    const named = [];
    for (const reference of references) {
      if (reference.primitive !== 'import()' && reference.primitive !== 'require') continue;
      for (const { kind, path } of reference.results) {
        if (kind === 'file' && CODE_FILE.test(path) && isRepositoryFile(path) && existsSync(path) && !modules.has(path) && !named.some((n) => n.file === path)) named.push({ file: path, reference });
      }
    }
    if (named.length === 0) break;
    if (round > MAX_COMPUTED_IMPORT_ROUNDS) {
      for (const { reference } of named) {
        const readerFile = toRepoPath(reference.file);
        if (isReviewed(readerFile, reference.expression)) continue;
        unresolved.push({
          file: readerFile,
          line: reference.line,
          expression: reference.expression,
          reason: `modules named by an import() or require() whose path is worked out at run time lead more than ${MAX_COMPUTED_IMPORT_ROUNDS} levels deep, so what the last ones read and import is not followed`,
        });
      }
      break;
    }
    for (const { file, reference } of named) if (!cameFrom.has(file)) cameFrom.set(file, reference.file);
    follow(named.map((n) => n.file));
    ({ references } = findFileReads({ ...probe, resolveImport }));
  }

  for (const reference of references) {
    const readerFile = toRepoPath(reference.file);
    const where = `${readerFile}:${reference.line}${viaText(reference.file) ? ` (${viaText(reference.file)})` : ''}`;
    const reviewedRead = isReviewed(readerFile, reference.expression);

    for (const { kind, path } of reference.results) {
      if (isInside(compDirAbs, path) || !isInside(repoRoot, path)) continue;
      // a path that is not there is not being read (a test that checks something is absent)
      if (!existsSync(path)) continue;
      // node_modules and built output are not repository files
      if (NOT_REPOSITORY.test(relative(repoRoot, path))) continue;
      const isFolder = kind === 'dir' || isDirectory(path);
      // new URL(...) of a folder is only a base for building file paths, and a folder that is only
      // checked for, or looked at (existsSync, statSync), is not a dependency on what is in it
      if (isFolder && (reference.primitive === 'new URL' || (kind === 'file' && !LISTS_FOLDER.has(reference.primitive)))) continue;
      // a read a person has looked at is not held to the filter for folders or for what the guard cannot work out;
      // a plain file it names still is, so an exemption can never hide a file the filter should match
      if (reviewedRead && isFolder) continue;
      if (isFolder && relative(repoRoot, path) === '') {
        unresolved.push({ file: readerFile, line: reference.line, expression: reference.expression, reason: 'it reads a file directly under the repository root and the guard does not know which one' });
        continue;
      }
      const repoPath = isFolder ? `${toRepoPath(path)}/` : toRepoPath(path);
      (isFolder ? dirs : files).add(repoPath);
      remember(repoPath, where);
    }
    if (reviewedRead) continue;
    for (const reason of reference.unresolved) {
      unresolved.push({ file: readerFile, line: reference.line, expression: reference.expression, reason });
    }
  }

  // An import whose file cannot be found hides what that file reads and imports in turn.
  for (const { module, line, spec } of missingImports) {
    const readerFile = toRepoPath(module);
    const expression = importExpression(spec);
    if (isReviewed(readerFile, expression)) continue;
    unresolved.push({
      file: readerFile,
      line,
      expression,
      reason:
        'no file is found at that path, so the guard cannot tell what that file reads or imports in turn (it may be made by a build step, or be a path the guard does not understand, or a mistake)' +
        (reachedFrom(module) ? `. The module with this import is reached from ${reachedFrom(module)}` : ''),
    });
  }

  const insideHere = (entry) => isInside(compDirAbs, join(repoRoot, entry.file));
  return { files, dirs, unresolved, unusedReviewed: reviewed.filter((entry) => insideHere(entry) && !usedReviewed.has(entry)), usedReviewed, origins };
}

/** Parse matrix filters from .github/workflows/ci.yml */
export function parseCiFilters(
  ciYmlContent = readFileSync(join(DEFAULT_REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
) {
  const filterRegex = /- name:\s*([^\n]+)\s+dir:\s*([^\n]+)(?:[\s\S]*?)filter:\s*'([^']+)'/g;
  const filters = new Map();
  let m;
  while ((m = filterRegex.exec(ciYmlContent)) !== null) {
    const name = m[1].trim();
    const dir = m[2].trim();
    const filter = m[3].trim();
    filters.set(dir, { name, filter, regex: new RegExp(filter) });
  }
  return filters;
}
