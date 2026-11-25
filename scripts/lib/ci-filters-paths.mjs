/**
 * Where an import or a read lands on disk, for the CI path-filter guard (ci-filters.mjs): which file a path names
 * once a file ending is tried, and whether that file is one a pull request can change.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Import shortcuts a package uses, by package folder: an import starting with
 * the first value means the second, inside the package. The frontend's `@` is
 * set in frontend/vitest.config.js and frontend/vite.config.js.
 */
const IMPORT_ALIASES = { frontend: [['@/', 'src/']] };

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

export function resolveFile(candidate) {
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

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `file` is `dir` itself or inside it. */
export function isInside(dir, file) {
  const rel = relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The answers about the disk one deriveCrossRootReads run needs, each worked out once. */
export class RepositoryPaths {
  constructor(compDir, repoRoot) {
    this.compDir = compDir;
    this.repoRoot = repoRoot;
    this.compDirAbs = join(repoRoot, compDir);
    // The files do not change while the guard runs, and the same import is asked about many times (once by the walk
    // below and again for each name the analysis follows), so each answer from the disk is kept.
    this.fileOnDisk = new Map();
    this.specAnswers = new Map();
    this.packageFolders = new Map(); // folder -> whether it holds a package.json
  }

  toRepoPath(abs) {
    return relative(this.repoRoot, abs).replace(/\\/g, '/');
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
}
