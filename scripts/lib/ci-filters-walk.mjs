/** Following the imports of a package's tests from module to module, for the CI path-filter guard (ci-filters.mjs). */
import { existsSync, readFileSync } from 'node:fs';
import { findFileReads, listImports } from './js-file-reads.mjs';
import { RepositoryPaths, isInside } from './ci-filters-paths.mjs';

/** Files the guard reads as code. An import of anything else (an image, JSON) is only recorded. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/** The modules found so far by one deriveCrossRootReads run, how each was reached, and the files imported from outside. */
export class ImportWalk extends RepositoryPaths {
  constructor(compDir, repoRoot) {
    super(compDir, repoRoot);
    this.modules = new Map(); // every module the tests pull in, in this package or not: absolute path -> text
    this.cameFrom = new Map(); // module -> the module that first imported it, to say how it was reached
    this.files = new Set();
    this.dirs = new Set();
    this.origins = new Map();
    this.missingImports = [];
  }

  remember(path, where) {
    if (!this.origins.has(path)) this.origins.set(path, new Set());
    this.origins.get(path).add(where);
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
}
