/**
 * Works out which files a set of JavaScript (or JSX) modules read (#1414).
 *
 * The CI path-filter guard (ci-filters.mjs) needs every file outside a package
 * that the package's tests read. Cutting the text of a call at the first comma
 * cannot find them: `readFileSync(join(HERE, '..', 'functions', 'x.js'))` was
 * read as `join(HERE` and dropped. So this file splits each module into its
 * parts with a parser (`espree`, the one ESLint uses; the result is a "syntax
 * tree") and follows the path the way Node would:
 *
 *  - `join`, `resolve`, `dirname`, `fileURLToPath`, `new URL(x, import.meta.url)`,
 *    `process.cwd()`, `__dirname` and `import.meta.dirname` are worked out;
 *  - a path built in a variable, in a loop, or inside a helper such as
 *    `const read = (name) => readFileSync(join(ROOT, name))` is followed back to
 *    the values the helper is called with, in this file or another one;
 *  - temporary folders (`mkdtempSync`, `tmpdir()`) are recognised and ignored;
 *  - when only the start of a path is known (`join(INFRA, someName)`), the code
 *    depends on "something inside that folder" and is reported as a directory;
 *  - only reads that a test can run are reported: code that only runs when a
 *    script is started from the command line (`if (process.argv[1] === ...)`)
 *    is left out;
 *  - a read it recognises but cannot work out is reported as unresolved, and so
 *    is any use of the file functions it cannot see through (stored, handed to
 *    other code, looked up by a name). The caller decides what to do with it;
 *    ci-filters.test.mjs fails the build unless a person has written down why.
 *
 * It cannot follow everything. The list of what it does not see is at the top
 * of ci-filters.test.mjs. Only source text is looked at; nothing is run.
 */
import { createAnalysis } from './js-file-reads/analysis.mjs';
import { scanModules } from './js-file-reads/scan.mjs';

// The parts, each in its own file under js-file-reads/:
//   values, text-values     the values a path can have, and how they are compared and described
//   syntax, declarations,   parsing, and the table of names (which name is declared where)
//     load-module
//   list-imports            the modules a file names with the path written out (listImports)
//   uses, command-line      how each name is used, and which code only runs from the command line
//   analysis, links         the state of one run, and following a name across modules
//   evaluate*, builtins,    working out the values of an expression
//     path-join, methods
//   scan, scan-calls,       finding the places that read files, and writing them down
//     report, file-functions
export { listImports } from './js-file-reads/list-imports.mjs';

/**
 * @param {object} options
 * @param {Map<string, string | {text: string, ast: object | null}>} options.modules  absolute file path -> source text,
 *        or the text with its syntax tree when the caller has parsed it already (`listImports` returns the tree).
 *        A tree serves one analysis; one that was used before is not used again, the text is parsed instead.
 * @param {(file: string) => boolean} [options.reportIn]  which of the modules to report reads from
 *        (default all). The others are parsed only so the values they export can be followed.
 * @param {(path: string) => (string|null)} [options.probeFile]  finds the file a path means when it is written without
 *        its ending (../lib means ../lib/index.js)
 * @param {string} options.cwd  the folder the tests run in (a package folder)
 * @param {(spec: string, fromFile: string) => (string|null)} options.resolveImport
 *        maps an import to the absolute path of a module in `modules` (or null)
 * @returns {{references: Array<{file: string, line: number, expression: string,
 *   primitive: string, results: Array<{kind: 'file'|'dir', path: string}>,
 *   unresolved: string[]}>}}
 *   one entry per place that reads a file: the files and directories it can
 *   touch, and the reasons (if any) the guard could not tell what it touches
 */
export function findFileReads({ modules, reportIn = () => true, cwd, resolveImport, probeFile = () => null }) {
  const an = createAnalysis({ modules, reportIn, cwd, resolveImport, probeFile });
  scanModules(an);
  return { references: an.references };
}
