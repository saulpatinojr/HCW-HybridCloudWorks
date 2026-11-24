/**
 * The shared tools of the two log-line tests beside this file:
 * `no-raw-error-in-logs.test.js` (no error text in a log line, #1794) and
 * `no-ids-in-logs.test.js` (no stored id in a log line, #1802).
 *
 * Both read every module under functions/src as a syntax tree (parsed with
 * Vite's `parseSync`, which vitest brings), find the calls that write a log
 * line, and judge what each one is given. What a log line is, how a module is
 * parsed and walked, and how a list of kept sites is checked are the same
 * for both, so they live here once. This file is test code: nothing the
 * deployed functions run imports it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

/** The functions source root, `functions/src`. */
const SRC = fileURLToPath(new URL('../..', import.meta.url));

export const LOG_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace', 'verbose']);
export const LOG_RECEIVERS = new Set(['context', 'ctx', 'console', 'log', 'logger', 'invocationContext']);
/** A bare call to one of these names is an injected logger function. */
export const LOG_FUNCTION_NAMES = new Set(['log', 'logger', 'warn', 'logWarn']);

/** Calls whose result is a yes/no or a number, never the text they read. */
export const PREDICATES = new Set([
  'test',
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'search',
  'has',
  'localeCompare',
  'Boolean',
  'Number',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'isInteger',
]);

/**
 * The expression beneath parentheses, optional chains and `await`.
 *
 * @param {object} node - an ESTree expression
 * @returns {object}
 */
export function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression' ||
      current.type === 'AwaitExpression')
  ) {
    current = current.expression ?? current.argument;
  }
  return current;
}

/**
 * A member expression's property name, when it is statically known.
 *
 * @param {object} member - an ESTree MemberExpression
 * @returns {string | null}
 */
export function memberName(member) {
  const p = member.property;
  if (!member.computed && (p.type === 'Identifier' || p.type === 'PrivateIdentifier')) return p.name;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  return null;
}

/**
 * The last name in a callee or object: `warn` for `warn` and `context.warn`.
 *
 * @param {object} node - an ESTree expression
 * @returns {string | null}
 */
export function lastName(node) {
  const n = unwrap(node);
  if (n?.type === 'Identifier') return n.name;
  if (n?.type === 'MemberExpression') return memberName(n);
  return null;
}

/** Whether `node` is a function of any form. */
export const isFunction = (node) =>
  node?.type === 'FunctionDeclaration' ||
  node?.type === 'FunctionExpression' ||
  node?.type === 'ArrowFunctionExpression';

/**
 * Visit every child node of `node`.
 *
 * @param {object} node - an ESTree node
 * @param {(child: object) => void} fn - called per child node
 */
export function eachChild(node, fn) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'parent' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') fn(item);
    } else if (typeof value.type === 'string') {
      fn(value);
    }
  }
}

/**
 * Whether an expression is a logger method: `context.warn`, `ctx.log.error`,
 * with or without `?.` and `.bind(...)`.
 *
 * @param {object} callee - an ESTree expression
 * @returns {boolean}
 */
export function isLoggerMember(callee) {
  const c = unwrap(callee);
  if (c?.type === 'CallExpression' && lastName(c.callee) === 'bind') return isLoggerMember(unwrap(c.callee).object);
  if (c?.type === 'LogicalExpression') return isLoggerMember(c.left) || isLoggerMember(c.right);
  if (c?.type !== 'MemberExpression' || !LOG_METHODS.has(memberName(c))) return false;
  return LOG_RECEIVERS.has(lastName(c.object));
}

/**
 * Parse one module, failing loudly, and give every node its parent.
 *
 * @param {string} file - path used for the parser and the message
 * @param {string} source - module text
 * @returns {object} the ESTree Program
 */
export function parse(file, source) {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file} did not parse: ${errors[0].message}`);
  /** Record each node's parent, without making it enumerable to eachChild. */
  const link = (node) =>
    eachChild(node, (child) => {
      Object.defineProperty(child, 'parent', { value: node, enumerable: false });
      link(child);
    });
  link(program);
  return program;
}

/** The names a binding pattern declares, each with the property it was read from (or null). */
export function patternNames(pattern, from = null, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push({ name: pattern.name, from });
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, from, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, '...', out);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((el) => patternNames(el, '[]', out));
  else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') patternNames(prop.argument, '...', out);
      else {
        const key = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : (prop.key.value ?? '[]');
        patternNames(prop.value, String(key), out);
      }
    }
  }
  return out;
}

/** The nearest enclosing function, catch clause or the program: where a name is declared. */
export function scopeOf(node) {
  let current = node.parent;
  while (current && !isFunction(current) && current.type !== 'CatchClause' && current.type !== 'Program') {
    current = current.parent;
  }
  return current;
}

/** The name of the function a node sits in, for a site's key. */
export function functionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunction(current)) continue;
    if (current.id?.name) return current.id.name;
    const holder = current.parent;
    if (holder?.type === 'VariableDeclarator' && holder.id.type === 'Identifier') return holder.id.name;
    if ((holder?.type === 'Property' || holder?.type === 'MethodDefinition') && holder.key?.name) return holder.key.name;
    if (holder?.type === 'AssignmentExpression') return lastName(holder.left) ?? '(anonymous)';
  }
  return '(module)';
}


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
  /** Every named function below the top level, for the log wrappers among them. */
  const nested = new Map();
  /** Record a named function that is not a top-level statement. */
  const findNested = (node, top) => {
    if (!top && node.type === 'FunctionDeclaration' && node.id) nested.set(node.id.name, node);
    if (!top && node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunction(unwrap(node.init))) {
      nested.set(node.id.name, unwrap(node.init));
    }
    eachChild(node, (child) => findNested(child, top && !isFunction(node)));
  };
  findNested(program, true);
  /** Record a top-level statement's functions. */
  const define = (statement) => {
    if (statement?.type === 'FunctionDeclaration' && statement.id) functions.set(statement.id.name, statement);
    if (statement?.type === 'VariableDeclaration') {
      for (const d of statement.declarations) {
        if (d.id.type === 'Identifier' && isFunction(unwrap(d.init))) functions.set(d.id.name, unwrap(d.init));
      }
    }
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      const from = resolveImport(file, statement.source.value);
      for (const spec of statement.specifiers) {
        if (spec.type === 'ImportSpecifier') imports.set(spec.local.name, { from, name: spec.imported.name ?? spec.imported.value });
      }
    } else if (statement.type === 'ExportNamedDeclaration') {
      define(statement.declaration);
      if (statement.declaration?.type === 'FunctionDeclaration') exports.set(statement.declaration.id.name, statement.declaration.id.name);
      if (statement.declaration?.type === 'VariableDeclaration') {
        for (const d of statement.declaration.declarations) if (d.id.type === 'Identifier') exports.set(d.id.name, d.id.name);
      }
      for (const spec of statement.specifiers ?? []) {
        if (!statement.source) exports.set(spec.exported.name ?? spec.exported.value, spec.local.name);
      }
    } else {
      define(statement);
    }
  }
  for (const name of functions.keys()) nested.delete(name);
  return { imports, functions, exports, nested };
}


/**
 * Compare the sites found with the decisions listed.
 *
 * @param {ReturnType<typeof scanLogSources>} sites - what the scan found
 * @param {Array<{ site: string, why: string, times?: number }>} allowed - the list
 * @returns {{ unlisted: string[], stale: string[], misfiled: string[] }}
 */
export function judgeLogSites(sites, allowed) {
  const counts = new Map();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  const listed = new Map(allowed.map((entry) => [entry.site, entry]));
  const stale = [];
  const misfiled = [];
  for (const entry of allowed) {
    const found = counts.get(entry.site) ?? 0;
    if (found === 0) stale.push(entry.site);
    else if (found !== (entry.times ?? 1)) misfiled.push(`${entry.site} — listed ${entry.times ?? 1}, found ${found}`);
    if (!entry.why?.trim()) misfiled.push(`${entry.site} — needs a written reason`);
  }
  const unlisted = sites.filter((s) => !listed.has(s.key)).map((s) => `${s.file}:${s.line} — ${s.key}`);
  return { unlisted, stale, misfiled };
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

/**
 * Local names that alias a logger method: `const warn = context.warn`, `(l) => context.warn(l)`.
 *
 * @param {object} program - the parsed module
 * @returns {Set<string>}
 */
export function aliasesOf(program) {
  const out = new Set();
  /** Record a variable that aliases a logger method. */
  const collect = (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const init = unwrap(node.init);
      if (isLoggerMember(init)) out.add(node.id.name);
      // `const info = (line) => log.log(`[x] ${line}`)`: a one-line function around a log line.
      let body = isFunction(init) ? init.body : null;
      if (body?.type === 'BlockStatement' && body.body.length === 1) {
        body = body.body[0].expression ?? body.body[0].argument ?? null;
      }
      const call = unwrap(body);
      if (call?.type === 'CallExpression' && isLoggerMember(call.callee)) out.add(node.id.name);
    }
    eachChild(node, collect);
  };
  collect(program);
  return out;
}
