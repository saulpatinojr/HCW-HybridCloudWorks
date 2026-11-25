/**
 * The module-level view the log-line tests (log-scan.test-helper.js, whose
 * header explains them) take of functions/src: every source module read,
 * and for one module what it imports and which functions it defines and
 * exports. This file is test code: nothing the deployed functions run
 * imports it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eachChild, isFunction, unwrap } from './ast-walk.test-helper.js';

/** The functions source root, `functions/src`. */
const SRC = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Resolve a relative import to a tree key.
 *
 * @param {string} file - the importing module's tree key
 * @param {string} specifier - the import source
 * @returns {string | null}
 */
export function resolveImport(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/** A variable declarator that holds a function, with that function; null otherwise. */
const declaredFunction = (d) => (d.id.type === 'Identifier' && isFunction(unwrap(d.init)) ? unwrap(d.init) : null);

/** Every named function below the top level, for the log wrappers among them. */
function nestedFunctions(program) {
  const nested = new Map();
  /** Record a named function that is not a top-level statement. */
  const findNested = (node, top) => {
    if (!top && node.type === 'FunctionDeclaration' && node.id) nested.set(node.id.name, node);
    if (!top && node.type === 'VariableDeclarator' && declaredFunction(node)) {
      nested.set(node.id.name, declaredFunction(node));
    }
    eachChild(node, (child) => findNested(child, top && !isFunction(node)));
  };
  findNested(program, true);
  return nested;
}

/** Record a top-level statement's functions. */
function define(statement, functions) {
  if (statement?.type === 'FunctionDeclaration' && statement.id) functions.set(statement.id.name, statement);
  if (statement?.type !== 'VariableDeclaration') return;
  for (const d of statement.declarations) {
    const fn = declaredFunction(d);
    if (fn) functions.set(d.id.name, fn);
  }
}

/** Record what an import statement brings in, by local name. */
function recordImport(file, statement, imports) {
  const from = resolveImport(file, statement.source.value);
  for (const spec of statement.specifiers) {
    if (spec.type === 'ImportSpecifier') imports.set(spec.local.name, { from, name: spec.imported.name ?? spec.imported.value });
  }
}

/** Record what an `export` statement exports, by exported name. */
function recordExports(statement, exports) {
  const declaration = statement.declaration;
  if (declaration?.type === 'FunctionDeclaration') exports.set(declaration.id.name, declaration.id.name);
  if (declaration?.type === 'VariableDeclaration') {
    for (const d of declaration.declarations) if (d.id.type === 'Identifier') exports.set(d.id.name, d.id.name);
  }
  if (statement.source) return;
  for (const spec of statement.specifiers ?? []) exports.set(spec.exported.name ?? spec.exported.value, spec.local.name);
}

/**
 * What a module imports and what functions it defines and exports.
 *
 * @param {string} file - tree key
 * @param {object} program - the parsed module
 * @returns {{ imports: Map<string, { from: string | null, name: string }>, functions: Map<string, object>,
 *   exports: Map<string, string>, nested: Map<string, object> }}
 */
export function moduleTable(file, program) {
  const imports = new Map();
  const functions = new Map();
  const exports = new Map();
  const nested = nestedFunctions(program);
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      recordImport(file, statement, imports);
    } else if (statement.type === 'ExportNamedDeclaration') {
      define(statement.declaration, functions);
      recordExports(statement, exports);
    } else {
      define(statement, functions);
    }
  }
  for (const name of functions.keys()) nested.delete(name);
  return { imports, functions, exports, nested };
}

/**
 * Every source module under a directory, tests left out.
 *
 * @param {string} dir - absolute directory to walk
 * @returns {string[]}
 */
export function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.(c|m)?js$/.test(entry) && !/\.(test|spec)\.(c|m)?js$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The real tree: every module under functions/src.
 *
 * @returns {Record<string, string>}
 */
export function realTree() {
  const modules = {};
  for (const full of sourceFiles(SRC)) {
    modules[relative(SRC, full).split('\\').join('/')] = readFileSync(full, 'utf8');
  }
  return modules;
}
