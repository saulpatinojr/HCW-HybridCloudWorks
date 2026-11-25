/** Holding the reads one deriveCrossRootReads run found to the filter, or noting what could not be worked out (ci-filters.mjs). */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ImportWalk } from './ci-filters-walk.mjs';
import { isDirectory, isInside } from './ci-filters-paths.mjs';

/** File functions that look inside a folder. The others only ask about it (does it exist, what is its size). */
const LISTS_FOLDER = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir', 'cpSync', 'cp']);

/** How many times the walk goes on into a module named by an import() with a computed path. */
const MAX_COMPUTED_IMPORT_ROUNDS = 4;

/** The `import '<path>'` text a missing import is reported under, and written under in REVIEWED_READS. */
const importExpression = (spec) => `import '${spec}'`;

/** The state of one deriveCrossRootReads run: the modules found so far, and the files, folders and problems noted. */
export class CrossRootWalk extends ImportWalk {
  constructor(compDir, repoRoot, reviewed) {
    super(compDir, repoRoot);
    this.reviewed = reviewed;
    this.unresolved = [];
    this.usedReviewed = new Set();
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

  isReviewed(repoFile, expression) {
    const entry = this.reviewed.find((e) => e.file === repoFile && (e.expression === undefined || e.expression === expression));
    if (entry) this.usedReviewed.add(entry);
    return Boolean(entry);
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
