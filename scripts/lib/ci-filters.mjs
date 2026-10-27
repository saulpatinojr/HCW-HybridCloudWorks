/**
 * Derives out-of-component file dependencies (imports and file reads) from tests
 * and asserts that CI path filters in .github/workflows/ci.yml match every one.
 *
 * (QA-4, #979; reads worked out from the parsed code, #1414)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFileReads } from './js-file-reads.mjs';

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

/**
 * The paths a module imports that start with a dot or with one of the aliases:
 * static and dynamic imports, require, and the module paths vi.mock and its
 * relatives name. Only paths written out as plain text are found here; one
 * worked out at run time is found by lib/js-file-reads.mjs.
 */
function importSpecs(content, aliases) {
  const prefixes = ['\\.', ...aliases.map(([prefix]) => prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))];
  const opener =
    '(?:(?:import|export|from|require)\\s*(?:\\(\\s*)?|(?:vi|jest)\\s*\\.\\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual)\\s*\\(\\s*)';
  const pattern = new RegExp(`${opener}['"]((?:${prefixes.join('|')})[^'"]*)['"]`, 'g');
  return [...content.matchAll(pattern)].map((m) => m[1]);
}

/**
 * Derive the out-of-component files and folders that tests (and the modules
 * and helpers they import) import or read.
 *
 * `reviewed` lists reads a person has looked at, each as
 * `{ file, expression?, reason }` (see ci-filters.test.mjs). A read matches an
 * entry when it is in `file` and, if the entry has an `expression`, is written
 * exactly that way. For such a read the folders it reads, and whatever the
 * guard could not work out, are not held to the filter; a plain file it names
 * still is.
 *
 * Returns:
 *  - `files`: repository paths of files read or imported from outside the
 *    component.
 *  - `dirs`: repository paths (ending in "/") of folders whose contents are
 *    read, where the code builds the file name at run time. A filter must match
 *    something inside each one.
 *  - `unresolved`: reads whose path the guard could not work out. These are
 *    never skipped; the test fails on them (#1414).
 *  - `unusedReviewed`: entries of `reviewed` for this package that matched no
 *    read, so a stale entry cannot stay behind.
 *  - `origins`: for each path above, where it is read, to put in messages.
 */
export function deriveCrossRootReads(compDir, repoRoot = DEFAULT_REPO_ROOT, { reviewed = [] } = {}) {
  const compDirAbs = join(repoRoot, compDir);
  const aliases = IMPORT_ALIASES[compDir] ?? [];
  const testFiles = findTestFiles(compDirAbs);
  const modules = new Map();
  const queue = [...testFiles];
  const outsideModules = new Map();
  const files = new Set();
  const dirs = new Set();
  const unresolved = [];
  const origins = new Map();
  const toRepoPath = (abs) => relative(repoRoot, abs).replace(/\\/g, '/');
  const remember = (path, where) => {
    if (!origins.has(path)) origins.set(path, new Set());
    origins.get(path).add(where);
  };

  const resolveSpec = (rawSpec, from) => {
    const spec = rawSpec.replace(/[?#].*$/, ''); // "../guide.md?raw" names the file ../guide.md
    if (spec.startsWith('.')) return resolveFile(resolve(dirname(from), spec));
    for (const [prefix, target] of aliases) {
      if (spec.startsWith(prefix)) return resolveFile(join(compDirAbs, target, spec.slice(prefix.length)));
    }
    return null;
  };

  // 1. Find every module the tests pull in, following imports inside the
  //    component, and note the imports that leave it.
  while (queue.length > 0) {
    const current = queue.shift();
    if (modules.has(current)) continue;
    const content = readFileSync(current, 'utf8');
    modules.set(current, content);

    for (const spec of importSpecs(content, aliases)) {
      const resolved = resolveSpec(spec, current);
      if (!resolved) continue;
      if (!isInside(compDirAbs, resolved)) {
        files.add(toRepoPath(resolved));
        remember(toRepoPath(resolved), `${toRepoPath(current)} (import)`);
        // kept so the values it exports (constants, helpers) can be followed; its own reads are not reported
        if (CODE_FILE.test(resolved) && !outsideModules.has(resolved)) outsideModules.set(resolved, readFileSync(resolved, 'utf8'));
      } else if (CODE_FILE.test(resolved) && !modules.has(resolved) && !resolved.includes('node_modules')) {
        queue.push(resolved);
      }
    }
  }

  // 2. Work out every file the modules read.
  const { references } = findFileReads({
    modules: new Map([...modules, ...outsideModules]),
    reportIn: (file) => modules.has(file),
    cwd: compDirAbs,
    resolveImport: (spec, from) => {
      const resolved = resolveSpec(spec, from);
      return resolved && (modules.has(resolved) || outsideModules.has(resolved)) ? resolved : null;
    },
  });

  const reviewedHere = reviewed.filter((entry) => isInside(compDirAbs, join(repoRoot, entry.file)));
  const usedReviewed = new Set();
  const isReviewed = (repoFile, expression) => {
    const entry = reviewedHere.find((e) => e.file === repoFile && (e.expression === undefined || e.expression === expression));
    if (entry) usedReviewed.add(entry);
    return Boolean(entry);
  };

  for (const reference of references) {
    const readerFile = toRepoPath(reference.file);
    const where = `${readerFile}:${reference.line}`;
    const reviewedRead = isReviewed(readerFile, reference.expression);

    for (const { kind, path } of reference.results) {
      if (isInside(compDirAbs, path) || !isInside(repoRoot, path)) continue;
      // a path that is not there is not being read (a test that checks something is absent)
      if (!existsSync(path)) continue;
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

  return { files, dirs, unresolved, unusedReviewed: reviewedHere.filter((entry) => !usedReviewed.has(entry)), origins };
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
