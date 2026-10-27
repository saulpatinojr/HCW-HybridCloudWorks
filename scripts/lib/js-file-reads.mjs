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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as espree from 'espree';

/** Node file functions whose first argument is a path the code depends on. */
const READ_FUNCTIONS = new Set([
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'existsSync',
  'exists',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'createReadStream',
  'opendirSync',
  'opendir',
  'accessSync',
  'access',
  'openSync',
  'open',
  'readlinkSync',
  'readlink',
  'realpathSync',
  'realpath',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'cp',
]);

/** Names that need no import: what they stand for, as {mod, name}. */
const GLOBAL_REFS = {
  process: { mod: 'process', name: null },
  URL: { mod: 'url', name: 'URL' },
  Object: { mod: 'object', name: null },
  String: { mod: 'global', name: 'String' },
  Set: { mod: 'global', name: 'Set' },
};

/** Array methods whose callback receives the array's items. */
const ITEM_CALLBACK_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'some', 'every', 'find', 'findLast']);

/** String methods that turn a path into another path in the same place. */
const STRING_METHODS = new Set(['replace', 'replaceAll', 'trim', 'trimEnd', 'trimStart', 'toString', 'normalize', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'concat']);

/** Names that, on a call, almost certainly mean a file read even when the guard cannot tell where the function comes from. */
const FILE_LOOKING_NAMES = new Set([
  'readFileSync',
  'readdirSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'opendirSync',
  'accessSync',
  'openSync',
  'readlinkSync',
  'realpathSync',
  'copyFileSync',
  'cpSync',
  'readFile',
  'readdir',
  'createReadStream',
]);

/** A file that mentions none of these cannot read a file, so failing to parse it is harmless. */
const MENTIONS_FILE_ACCESS = /\bfs\b|node:fs|readFile|readdir|existsSync|statSync|createReadStream|new URL\(/;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const MAX_ALTERNATIVES = 200;
const MAX_COMBINATIONS = 2000;
const MAX_STEPS = 50000;
const MAX_CALL_DEPTH = 10;
const MAX_ROUNDS = 6;

const SCOPE_TYPES = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'BlockStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'CatchClause',
  'StaticBlock',
]);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// ---------------------------------------------------------------------------
// Values. An expression is worked out to a list of the values it could have,
// because a variable can be set in more than one place.
//   str   a known string (a path, absolute or relative)
//   pre   a string that starts with `v` and ends in something not known; `why`
//         is set when that end is a value the guard could not work out (not a folder listing)
//   name  a file or folder name from a folder listing (no folder attached)
//   url   a file:// URL (`wild` when its end is not known)
//   tmp   somewhere in the operating system's temporary folder
//   ext   something that is not repository content (a file descriptor, node_modules)
//   arr   an array: items[i] is the list of values position i could hold
//   obj   an object literal;  fn  a function;  req  a require function
//   parts a string cut by split() (only join('/') puts it back)
//   unk   not known; `why` says why
// ---------------------------------------------------------------------------
const str = (v) => ({ k: 'str', v });
const pre = (v, why = null) => ({ k: 'pre', v, why });
const unk = (why) => ({ k: 'unk', why });
const urlv = (href, wild = false, why = null) => ({ k: 'url', href, wild, why });
const arr = (items) => ({ k: 'arr', items });
const NAME = { k: 'name' };
const TMP = { k: 'tmp' };
const EXT = { k: 'ext' };
const TOO_MANY = 'it has too many possible values to follow';
const DESTRUCTURED = 'taken out of an object or list (with { } or [ ] on the left of =), which the guard does not follow';

/** What to call a kind of code in a message, for a reader who has not met the parser's names. */
const CODE_WORDS = {
  UpdateExpression: '++ or --',
  ThisExpression: '`this`',
  TaggedTemplateExpression: 'a tagged template string',
  UnaryExpression: 'an operator such as ! or typeof',
  ClassExpression: 'a class',
  SpreadElement: 'a spread (...)',
  YieldExpression: 'yield',
  ImportExpression: 'a dynamic import()',
  MetaProperty: 'import.meta',
  TemplateElement: 'a template string',
};
const plainCode = (type) => CODE_WORDS[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function keyOf(v) {
  switch (v.k) {
    case 'str':
      return `str:${v.v}`;
    case 'pre':
      return `pre:${v.v}:${v.why ?? ''}`;
    case 'url':
      return `url:${v.href}:${v.wild}:${v.why ?? ''}`;
    case 'unk':
      return `unk:${v.why}`;
    case 'arr':
      return `arr[${v.items.map((alts) => alts.map(keyOf).join('|')).join(',')}]`;
    case 'obj':
    case 'fn':
      return `${v.k}:${v.node.file}:${v.node.range[0]}`;
    case 'parts':
      return `parts:${keyOf(v.of)}`;
    default:
      return v.k;
  }
}

function uniq(values) {
  const seen = new Map();
  for (const v of values) seen.set(keyOf(v), v);
  const out = [...seen.values()];
  return out.length > MAX_ALTERNATIVES ? [unk(TOO_MANY)] : out;
}

/** Every way of picking one value from each list, or null if there are too many. */
function product(lists) {
  let combos = [[]];
  for (const list of lists) {
    const next = [];
    for (const combo of combos) for (const v of list) next.push([...combo, v]);
    if (next.length > MAX_COMBINATIONS) return null;
    combos = next;
  }
  return combos;
}

/** All the values an array's items could hold, as one list. */
const itemsOf = (array) => uniq(array.items.flat());

const VALUE_WORDS = {
  str: 'a piece of text',
  pre: 'a path that is only partly known',
  name: 'a file name from a folder listing',
  url: 'a URL',
  tmp: 'a temporary folder',
  ext: 'something outside the repository',
  arr: 'a list',
  obj: 'an object',
  fn: 'a function',
  req: 'the require function',
  parts: 'a path cut into pieces',
  unk: 'a value the guard could not work out',
};
const inWords = (v) => VALUE_WORDS[v.k] ?? v.k;

/** A value that stands for "not a path I can use", carried through unchanged. */
const passesThrough = (v) => v.k === 'unk' || v.k === 'tmp' || v.k === 'ext';

function normalizeModule(spec) {
  const name = spec.replace(/^node:/, '');
  if (name === 'fs/promises') return 'fs';
  if (name === 'path/posix' || name === 'path/win32') return 'path';
  return name;
}

const isRelative = (spec) => spec.startsWith('.');
const endsWithSeparator = (text) => text.endsWith('/') || text.endsWith(sep);

function fileUrlToPathSafe(href) {
  try {
    return fileURLToPath(href);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing, and the table of names (which name is declared where)
// ---------------------------------------------------------------------------
function parse(text) {
  let firstError;
  for (const sourceType of ['module', 'commonjs']) {
    try {
      return espree.parse(text, {
        ecmaVersion: 'latest',
        sourceType,
        ecmaFeatures: { jsx: true },
        range: true,
        loc: true,
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

function* childrenOf(node) {
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') yield item;
    } else if (value && typeof value.type === 'string') {
      yield value;
    }
  }
}

/** Sets `parent` and `file` on every node and returns them all. */
function annotate(root, file) {
  const nodes = [];
  const stack = [root];
  root.parent = null;
  while (stack.length > 0) {
    const node = stack.pop();
    node.file = file;
    nodes.push(node);
    for (const child of childrenOf(node)) {
      child.parent = node;
      stack.push(child);
    }
  }
  return nodes;
}

function scopeOf(node, hoistToFunction) {
  for (let n = node.parent; n; n = n.parent) {
    if (hoistToFunction ? FUNCTION_TYPES.has(n.type) || n.type === 'Program' : SCOPE_TYPES.has(n.type)) return n;
  }
  return null;
}

/** Declares `name` in a scope node and returns its binding (the record for that name). */
function bind(scopeNode, name, props) {
  scopeNode.$scope ??= new Map();
  let binding = scopeNode.$scope.get(name);
  if (!binding) {
    binding = { name, kind: 'var', inits: [], assigns: [], calls: [], viaParams: [], callbackUses: [], pushes: [], tainted: false, counted: false, mutated: false, escapes: false, ...props };
    scopeNode.$scope.set(name, binding);
  } else if (props.inits) {
    binding.inits.push(...props.inits);
  }
  return binding;
}

function lookup(node, name) {
  for (let n = node; n; n = n.parent) {
    const binding = n.$scope?.get(name);
    if (binding) return binding;
  }
  return null;
}

function patternIdentifiers(pattern, out = []) {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern);
      break;
    case 'ObjectPattern':
      for (const p of pattern.properties) patternIdentifiers(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of pattern.elements) if (e) patternIdentifiers(e, out);
      break;
    case 'AssignmentPattern':
      patternIdentifiers(pattern.left, out);
      break;
    case 'RestElement':
      patternIdentifiers(pattern.argument, out);
      break;
    default:
  }
  return out;
}

/** The module name in `require('x')` or `await import('x')`, else null. */
function requiredModule(node) {
  let n = node;
  if (n?.type === 'AwaitExpression') n = n.argument;
  if (n?.type === 'ImportExpression' && n.source.type === 'Literal') return String(n.source.value);
  if (
    n?.type === 'CallExpression' &&
    n.callee.type === 'Identifier' &&
    n.callee.name === 'require' &&
    n.arguments.length === 1 &&
    n.arguments[0].type === 'Literal' &&
    typeof n.arguments[0].value === 'string'
  ) {
    return n.arguments[0].value;
  }
  return null;
}

/** Declares the names taken out of an object by a destructuring pattern. `from` is { owner } or { init }. */
function declareParts(scopeNode, pattern, from) {
  for (const id of patternIdentifiers(pattern)) {
    const property = pattern.type === 'ObjectPattern' ? pattern.properties.find((p) => p.type === 'Property' && (p.value === id || p.value?.left === id)) : null;
    const key = property && !property.computed ? (property.key.name ?? property.key.value) : null;
    if (key === null) bind(scopeNode, id.name, { kind: 'opaque', why: DESTRUCTURED });
    else bind(scopeNode, id.name, { kind: 'part', key, defaults: property.value.type === 'AssignmentPattern' ? [property.value.right] : [], ...from });
  }
}

/** for (const { a } of list) and for (const [k, v] of list): the names are taken from each item of the list. */
function declareLoopParts(scope, pattern, iterable) {
  const isArray = pattern.type === 'ArrayPattern';
  (isArray ? pattern.elements : pattern.properties).forEach((element, index) => {
    if (!element) return;
    const target = isArray ? element : element.type === 'Property' ? element.value : null;
    const id = target?.type === 'AssignmentPattern' ? target.left : target;
    const key = !isArray && element.type === 'Property' && !element.computed ? (element.key.name ?? element.key.value) : null;
    if (id?.type !== 'Identifier' || (!isArray && key === null)) {
      for (const ident of patternIdentifiers(element.type === 'RestElement' ? element.argument : (target ?? element))) bind(scope, ident.name, { kind: 'opaque', why: DESTRUCTURED });
      return;
    }
    bind(scope, id.name, { kind: 'part', key, index: isArray ? index : null, loopOver: iterable, defaults: target.type === 'AssignmentPattern' ? [target.right] : [] });
  });
}

function declareParams(fn) {
  fn.$params = fn.params.map((param, index) => {
    let target = param;
    let rest = false;
    let defaults = [];
    if (param.type === 'AssignmentPattern') {
      defaults = [param.right];
      target = param.left;
    } else if (param.type === 'RestElement') {
      rest = true;
      target = param.argument;
    }
    if (target.type === 'Identifier') return bind(fn, target.name, { kind: 'param', fn, index, rest, defaults });
    // ({ a, b = 1 }) => ...: the whole argument is a hidden parameter, and a and b are taken from it
    const whole = bind(fn, `$argument${index}`, { kind: 'param', fn, index, rest: false, defaults });
    declareParts(fn, target, { owner: whole });
    return whole;
  });
}

function declareVariable(node) {
  const declaration = node.parent;
  const owner = declaration.parent;
  const scope = scopeOf(declaration, declaration.kind === 'var');
  const isLoop = (owner.type === 'ForOfStatement' || owner.type === 'ForInStatement') && owner.left === declaration;
  const loop = isLoop ? { kind: owner.type === 'ForOfStatement' ? 'of' : 'in', iterable: owner.right } : null;
  const moduleName = requiredModule(node.init);

  if (node.id.type === 'Identifier') {
    if (moduleName !== null) {
      bind(scope, node.id.name, { kind: 'import', source: moduleName, imported: '*', file: node.file });
      return;
    }
    const binding = bind(scope, node.id.name, { inits: node.init ? [node.init] : [], loop });
    if (node.init && FUNCTION_TYPES.has(node.init.type)) node.init.$binding = binding;
    return;
  }
  if (moduleName !== null) {
    // const { readFileSync } = require('node:fs')
    for (const id of patternIdentifiers(node.id)) {
      const property = node.id.type === 'ObjectPattern' ? node.id.properties.find((p) => p.type === 'Property' && (p.value === id || p.value?.left === id)) : null;
      const key = property && !property.computed ? (property.key.name ?? property.key.value) : null;
      if (key === null) bind(scope, id.name, { kind: 'opaque', why: DESTRUCTURED });
      else bind(scope, id.name, { kind: 'import', source: moduleName, imported: key, file: node.file });
    }
  } else if (node.init && node.id.type === 'ObjectPattern' && !loop) {
    declareParts(scope, node.id, { init: node.init });
  } else if (loop?.kind === 'of' && (node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern')) {
    declareLoopParts(scope, node.id, loop.iterable);
  } else {
    for (const id of patternIdentifiers(node.id)) bind(scope, id.name, { kind: 'opaque', why: DESTRUCTURED });
  }
}

function declareImport(node) {
  const scope = scopeOf(node, false);
  for (const s of node.specifiers) {
    let imported = 'default';
    if (s.type === 'ImportNamespaceSpecifier') imported = '*';
    else if (s.type === 'ImportSpecifier') imported = s.imported.name ?? s.imported.value;
    bind(scope, s.local.name, { kind: 'import', source: node.source.value, imported, file: node.file });
  }
}

function declareFunction(node) {
  if (node.type === 'FunctionDeclaration' && node.id) {
    node.$binding = bind(scopeOf(node, false), node.id.name, { kind: 'function', fn: node });
  }
  declareParams(node);
}

/**
 * What a module exports: name -> its binding, or { from, name } for a
 * re-export (`export { f } from './x'`). `.all` lists the modules named by
 * `export * from`.
 */
function collectExports(program) {
  const exports = new Map();
  exports.all = [];
  const programBinding = (name) => program.$scope?.get(name);
  for (const node of program.body) {
    if (node.type === 'ExportAllDeclaration') {
      exports.all.push(node.source.value);
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      for (const s of node.specifiers) exports.set(s.exported.name ?? s.exported.value, { from: node.source.value, name: s.local.name ?? s.local.value });
    } else if (node.type === 'ExportNamedDeclaration') {
      const d = node.declaration;
      if (d?.type === 'FunctionDeclaration' || d?.type === 'ClassDeclaration') {
        exports.set(d.id.name, programBinding(d.id.name));
      } else if (d?.type === 'VariableDeclaration') {
        for (const decl of d.declarations) {
          for (const id of patternIdentifiers(decl.id)) exports.set(id.name, programBinding(id.name));
        }
      } else {
        for (const s of node.specifiers) exports.set(s.exported.name ?? s.exported.value, programBinding(s.local.name));
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      if (d.type === 'FunctionDeclaration' && d.id) exports.set('default', programBinding(d.id.name));
      else if (d.type === 'Identifier') exports.set('default', programBinding(d.name));
    }
  }
  return exports;
}

/** Parses one module and records its names. Throws if the text cannot be parsed. */
function loadModule(file, text) {
  const ast = parse(text);
  const nodes = annotate(ast, file);
  for (const node of nodes) {
    switch (node.type) {
      case 'ImportDeclaration':
        declareImport(node);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        declareFunction(node);
        break;
      case 'VariableDeclarator':
        declareVariable(node);
        break;
      case 'ClassDeclaration':
        if (node.id) bind(scopeOf(node, false), node.id.name, { kind: 'opaque', why: 'a class' });
        break;
      case 'CatchClause':
        if (node.param) for (const id of patternIdentifiers(node.param)) bind(node, id.name, { kind: 'opaque', why: 'a caught error' });
        break;
      default:
    }
  }
  return { file, text, ast, nodes, exports: collectExports(ast) };
}

/** Whether an Identifier is a use of a name (not a property key, label or declaration). */
function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case 'MemberExpression':
      return parent.object === node || (parent.property === node && parent.computed);
    case 'Property':
      if (parent.parent.type === 'ObjectPattern') return false;
      return parent.value === node || (parent.key === node && parent.computed);
    case 'VariableDeclarator':
      return parent.init === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return parent.body === node;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'CatchClause':
    case 'RestElement':
    case 'AssignmentPattern':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'ClassDeclaration':
      return false;
    default:
      return true;
  }
}

/** The function a binding names: a function declaration, or a name set to an arrow or function expression. */
function functionOf(binding) {
  if (binding.kind === 'function') return binding.fn;
  return binding.inits?.find((init) => FUNCTION_TYPES.has(init.type)) ?? null;
}

function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_TYPES.has(n.type)) return n;
  return null;
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {Map<string, string>} options.modules  absolute file path -> source text
 * @param {(file: string) => boolean} [options.reportIn]  which of the modules to report reads from
 *        (default all). The others are parsed only so the values they export can be followed.
 * @param {string} options.cwd  the folder the tests run in (a package folder)
 * @param {(spec: string, fromFile: string) => (string|null)} options.resolveImport
 *        maps an import to the absolute path of a module in `modules` (or null)
 * @returns {{references: Array<{file: string, line: number, expression: string,
 *   primitive: string, results: Array<{kind: 'file'|'dir', path: string}>,
 *   unresolved: string[]}>}}
 *   one entry per place that reads a file: the files and directories it can
 *   touch, and the reasons (if any) the guard could not tell what it touches
 */
export function findFileReads({ modules, reportIn = () => true, cwd, resolveImport }) {
  const loaded = new Map();
  const references = [];

  for (const [file, text] of modules) {
    try {
      loaded.set(file, loadModule(file, text));
    } catch (error) {
      if (reportIn(file) && MENTIONS_FILE_ACCESS.test(text)) {
        references.push({
          file,
          line: error.lineNumber ?? 1,
          expression: '(whole file)',
          primitive: 'parse',
          results: [],
          unresolved: [`the file could not be parsed (${error.message}), so the files it reads are unknown`],
        });
      }
    }
  }

  /** The declaration that module `file` exports under `name`, following re-exports. */
  const exportedBinding = (file, name, seen = new Set()) => {
    const module = loaded.get(file);
    if (!module || seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const entry = module.exports.get(name);
    if (entry && !entry.from) return entry;
    const sources = entry ? [[entry.from, entry.name]] : name === 'default' ? [] : module.exports.all.map((spec) => [spec, name]);
    for (const [spec, exportedName] of sources) {
      const target = resolveImport(spec, file);
      const found = target && exportedBinding(target, exportedName, seen);
      if (found) return found;
    }
    return null;
  };

  /** Follows an import to the declaration in the module it comes from, when that module was scanned. */
  const linkImport = (binding) => {
    if (binding.kind !== 'import') return binding;
    const target = resolveImport(binding.source, binding.file);
    return (target && exportedBinding(target, binding.imported)) || binding;
  };

  /** The name at the start of `a.b[c].d`, or null. */
  const rootIdentifier = (member) => {
    let n = member;
    while (n.type === 'MemberExpression') n = n.object;
    return n.type === 'Identifier' ? n : null;
  };

  /** Notes a name whose object or list is changed after it is made: x.k = v, x[i] = v, x.splice(...), Object.assign(x, ...). */
  const markMutations = (node) => {
    let target = null;
    if ((node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') || (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression')) {
      target = rootIdentifier(node.type === 'UpdateExpression' ? node.argument : node.left);
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete' && node.argument.type === 'MemberExpression') {
      target = rootIdentifier(node.argument);
    } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const { object, property } = node.callee;
      const method = node.callee.computed ? null : property.name;
      if (['splice', 'fill', 'copyWithin'].includes(method) || (['push', 'unshift'].includes(method) && object.type !== 'Identifier')) target = rootIdentifier(object);
      else if (object.type === 'Identifier' && object.name === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(method) && node.arguments[0]?.type === 'Identifier') target = node.arguments[0];
    }
    const binding = target && lookup(target, target.name);
    if (binding) binding.mutated = true;
  };

  /** A namespace import (import * as m) used as anything but m.name(...) hides which of its functions run. */
  const markNamespaceUse = (id) => {
    const holder = lookup(id, id.name);
    if (holder?.kind !== 'import' || holder.imported !== '*') return;
    const file = resolveImport(holder.source, holder.file);
    if (!file || !loaded.has(file)) return;
    const parent = id.parent;
    const isNamedMember = parent.type === 'MemberExpression' && parent.object === id && !parent.computed;
    if (isNamedMember && parent.parent.type === 'CallExpression' && parent.parent.callee === parent) return;
    const names = isNamedMember ? [parent.property.name] : [...loaded.get(file).exports.keys()];
    for (const name of names) {
      const exported = exportedBinding(file, name);
      if (exported) exported.escapes = true;
    }
  };

  // Who assigns to a name, who calls a function, and which functions are passed around.
  const allFunctions = [];
  for (const module of loaded.values()) {
    for (const node of module.nodes) {
      if (FUNCTION_TYPES.has(node.type)) allFunctions.push(node);
      markMutations(node);
      if (node.type === 'AssignmentExpression') {
        const targets = node.left.type === 'Identifier' ? [node.left] : patternIdentifiers(node.left);
        for (const id of targets) {
          const binding = lookup(id, id.name);
          if (!binding) continue;
          if (node.operator === '=' && node.left.type === 'Identifier') binding.assigns.push(node.right);
          else if (node.operator === '+=' && node.left.type === 'Identifier' && node.right.type === 'Literal' && typeof node.right.value === 'number') binding.counted = true;
          else binding.tainted = true;
        }
      } else if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
        const binding = lookup(node.argument, node.argument.name);
        if (binding) binding.counted = true;
      } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const binding = lookup(node.callee, node.callee.name);
        if (binding) linkImport(binding).calls.push(node);
      } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && !node.callee.computed) {
        const holder = lookup(node.callee.object, node.callee.object.name);
        const method = node.callee.property.name;
        if (['push', 'unshift'].includes(method)) holder?.pushes.push(node);
        // lib.f(x) where lib is `import * as lib from './x.mjs'`
        if (holder?.kind === 'import' && holder.imported === '*') {
          const target = resolveImport(holder.source, holder.file);
          const called = target && exportedBinding(target, method);
          if (called) called.calls.push(node);
        }
      } else if (node.type === 'Identifier' && isValueReference(node)) {
        markNamespaceUse(node);
        const isCallee = node.parent.type === 'CallExpression' && node.parent.callee === node;
        const binding = isCallee ? null : lookup(node, node.name);
        const target = binding && linkImport(binding);
        if (target && (target.kind === 'function' || target.inits.some((i) => FUNCTION_TYPES.has(i.type)))) {
          const call = node.parent;
          const isItemCallback = call.type === 'CallExpression' && call.arguments[0] === node && call.callee.type === 'MemberExpression' && !call.callee.computed && ITEM_CALLBACK_METHODS.has(call.callee.property.name);
          const receiver = call.type === 'CallExpression' && call.callee.type === 'Identifier' ? lookup(call.callee, call.callee.name) : null;
          const receiverFn = receiver && linkImport(receiver);
          const receiverParam = receiverFn && functionOf(receiverFn)?.$params?.[call.arguments.indexOf(node)];
          if (isItemCallback) target.callbackUses.push({ call });
          // helper(read): the helper's own calls of its parameter are calls of `read`
          else if (receiverParam) target.viaParams.push(receiverParam);
          else target.escapes = true;
        }
      }
    }
  }

  // ---- what runs when a test runs ---------------------------------------------
  const mentionsArgv = (root, depth = 0) => {
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && ((n.object.name === 'process' && n.property.name === 'argv') || (n.object.name === 'require' && n.property.name === 'main'))) return true;
      if (n.type === 'MemberExpression' && n.object.type === 'MetaProperty' && n.property.name === 'main') return true;
      if (n.type === 'Identifier' && depth < 3) {
        const b = lookup(n, n.name);
        if (b?.kind === 'var' && b.inits.some((init) => mentionsArgv(init, depth + 1))) return true;
      }
      for (const child of childrenOf(n)) stack.push(child);
    }
    return false;
  };

  /**
   * Whether a test about "was this script started from the command line" is
   * true when it is: 'positive' (=== ...), 'negative' (!== ..., !...), 'unclear'
   * (|| and the like), or null when it does not look at the command line.
   */
  const mentionsEnv = (root) => {
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'process' && n.property.name === 'env') return true;
      for (const child of childrenOf(n)) stack.push(child);
    }
    return false;
  };

  const computePolarity = (test, depth = 0) => {
    // a test on the environment alone ('env') says nothing about how the script was started
    if (!mentionsArgv(test)) return mentionsEnv(test) ? 'env' : null;
    if (test.type === 'UnaryExpression' && test.operator === '!') {
      const inner = startedFromCommandLine(test.argument, depth);
      return inner === 'positive' ? 'negative' : inner === 'negative' ? 'positive' : 'unclear';
    }
    if (test.type === 'BinaryExpression') return ['===', '=='].includes(test.operator) ? 'positive' : ['!==', '!='].includes(test.operator) ? 'negative' : 'unclear';
    if (test.type === 'LogicalExpression' && test.operator === '&&') {
      const sides = [startedFromCommandLine(test.left, depth), startedFromCommandLine(test.right, depth)].filter((side) => side && side !== 'env');
      return sides.length > 0 && sides.every((side) => side === sides[0]) ? sides[0] : 'unclear';
    }
    if (test.type === 'LogicalExpression' && test.operator === '||') {
      // started from the command line OR forced by an environment variable: the script still has to be the one started
      const sides = [startedFromCommandLine(test.left, depth), startedFromCommandLine(test.right, depth)];
      return sides.every((side) => side === 'positive' || side === 'env') && sides.includes('positive') ? 'positive' : 'unclear';
    }
    if (test.type === 'Identifier' && depth < 3) {
      const binding = lookup(test, test.name);
      if (binding?.kind === 'var' && binding.inits.length === 1 && binding.assigns.length === 0) return startedFromCommandLine(binding.inits[0], depth + 1);
    }
    // || and ?: can run either way; anything else that looks at the command line (process.argv[1], x.endsWith(...)) means "started from it"
    if (test.type === 'LogicalExpression' || test.type === 'ConditionalExpression') return 'unclear';
    return 'positive';
  };

  const polarityCache = new Map();
  const startedFromCommandLine = (test, depth = 0) => {
    if (!polarityCache.has(test)) polarityCache.set(test, computePolarity(test, depth));
    return polarityCache.get(test);
  };

  /** True inside the branch of `if (<this script was started>)` that a test never enters. */
  const commandLineOnlyCache = new Map();
  const commandLineOnly = (node) => {
    if (!commandLineOnlyCache.has(node)) commandLineOnlyCache.set(node, computeCommandLineOnly(node));
    return commandLineOnlyCache.get(node);
  };
  const computeCommandLineOnly = (node) => {
    for (let n = node; n.parent; n = n.parent) {
      const p = n.parent;
      if (p.type === 'IfStatement' || p.type === 'ConditionalExpression') {
        const sense = startedFromCommandLine(p.test);
        if ((sense === 'positive' && p.consequent === n) || (sense === 'negative' && p.alternate === n)) return true;
      }
      if (p.type === 'LogicalExpression' && p.operator === '&&' && p.right === n && startedFromCommandLine(p.left) === 'positive') return true;
    }
    return false;
  };

  /** Every call that runs `binding`'s function: by name, and through a parameter that was handed the function. */
  const callsOf = (binding) => [...binding.calls, ...binding.viaParams.flatMap((param) => param.calls)];
  const isUsedAsValue = (binding) => binding.escapes || binding.callbackUses.length > 0;

  const runningFunctions = new Set(allFunctions.filter((fn) => TEST_FILE.test(fn.file)));
  const runsInTests = (node) => {
    if (commandLineOnly(node)) return false;
    const fn = enclosingFunction(node);
    return !fn || runningFunctions.has(fn);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of allFunctions) {
      if (runningFunctions.has(fn)) continue;
      const b = fn.$binding;
      // a named function runs when something that runs calls it; a callback or method runs with the code around it
      const runs = b ? b.escapes || callsOf(b).some(runsInTests) || b.callbackUses.some((use) => runsInTests(use.call)) : runsInTests(fn);
      if (runs) {
        runningFunctions.add(fn);
        changed = true;
      }
    }
  }

  // ---- evaluation ----------------------------------------------------------
  let steps = 0;
  const freshContext = () => {
    steps = 0;
    return { frame: null, active: new Set(), approx: new Map(), reentered: new Set(), depth: 0 };
  };

  /**
   * Where an imported name really comes from. A name imported from one of our own files may have been
   * re-exported from a Node module there (export { readFileSync } from 'node:fs'), and the file functions
   * must still be seen. Returns { source, imported } or null.
   */
  const originOf = (binding, seen = new Set()) => {
    if (binding.kind !== 'import') return null;
    if (!isRelative(binding.source)) return { source: binding.source, imported: binding.imported };
    const file = resolveImport(binding.source, binding.file);
    const key = `${file}#${binding.imported}`;
    if (!file || seen.has(key)) return null;
    seen.add(key);
    const exports = loaded.get(file)?.exports;
    const entry = exports?.get(binding.imported);
    if (entry?.from) return originOf({ kind: 'import', source: entry.from, imported: entry.name, file }, seen);
    if (entry) return originOf(entry, seen);
    for (const spec of exports?.all ?? []) {
      const found = originOf({ kind: 'import', source: spec, imported: binding.imported, file }, seen);
      if (found) return found;
    }
    return null;
  };

  /** The module in process.getBuiltinModule('fs'), else null. */
  const builtinModuleOf = (node) => {
    const callee = node.type === 'CallExpression' ? node.callee : null;
    if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'getBuiltinModule') return null;
    const [arg] = node.arguments;
    return callee.object.type === 'Identifier' && callee.object.name === 'process' && arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
  };

  /** What a name stands for when it is a Node module or a global: {mod, name} or null. */
  const moduleRef = (node) => {
    if (node.type === 'CallExpression' || node.type === 'AwaitExpression') {
      // require('node:fs'), await import('node:fs'), process.getBuiltinModule('fs')
      const lit = requiredModule(node) ?? builtinModuleOf(node);
      return lit === null || isRelative(lit) ? null : { mod: normalizeModule(lit), name: null };
    }
    if (node.type === 'Identifier') {
      const binding = lookup(node, node.name);
      if (!binding) return GLOBAL_REFS[node.name] ?? null;
      const origin = originOf(binding);
      if (!origin || isRelative(origin.source)) return null;
      const mod = normalizeModule(origin.source);
      if (['default', '*', 'promises'].includes(origin.imported) || (mod === 'path' && ['posix', 'win32'].includes(origin.imported))) return { mod, name: null };
      return { mod, name: origin.imported };
    }
    if (node.type === 'MemberExpression') {
      const base = moduleRef(node.object);
      if (!base || base.name !== null) return null;
      let name = null;
      if (!node.computed && node.property.type === 'Identifier') name = node.property.name;
      else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') name = node.property.value;
      if (name === null) return null;
      if ((base.mod === 'fs' && name === 'promises') || (base.mod === 'path' && (name === 'posix' || name === 'win32'))) {
        return { mod: base.mod, name: null };
      }
      return { mod: base.mod, name };
    }
    return null;
  };

  const evalNode = (node, ctx) => {
    if (++steps > MAX_STEPS) return [unk('it takes too many steps to follow')];
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string') return [str(node.value)];
        if (typeof node.value === 'number' || typeof node.value === 'boolean') return [str(String(node.value))];
        return node.value === null ? [] : [unk('it is not a string')];
      case 'TemplateLiteral':
        return evalTemplate(node, ctx);
      case 'Identifier':
        return evalIdentifier(node, ctx);
      case 'MemberExpression':
        return evalMember(node, ctx);
      case 'CallExpression':
        return evalCall(node, ctx);
      case 'NewExpression':
        return evalNew(node, ctx);
      case 'AwaitExpression':
        return evalNode(node.argument, ctx);
      case 'ChainExpression':
        return evalNode(node.expression, ctx);
      case 'SequenceExpression':
        return evalNode(node.expressions.at(-1), ctx);
      case 'ConditionalExpression':
        return uniq([...evalNode(node.consequent, ctx), ...evalNode(node.alternate, ctx)]);
      case 'LogicalExpression':
        return uniq(node.operator === '&&' ? evalNode(node.right, ctx) : [...evalNode(node.left, ctx), ...evalNode(node.right, ctx)]);
      case 'BinaryExpression':
        return node.operator === '+' ? evalConcat(node, ctx) : [unk(`it uses the operator ${node.operator}`)];
      case 'AssignmentExpression':
        return evalNode(node.right, ctx);
      case 'ArrayExpression':
        return [evalArray(node, ctx)];
      case 'ObjectExpression':
        return [{ k: 'obj', node }];
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return [{ k: 'fn', node }];
      default:
        return [unk(`it uses ${plainCode(node.type)}, which the guard does not follow`)];
    }
  };

  const evalTemplate = (node, ctx) => {
    const combos = product(node.expressions.map((expr) => evalNode(expr, ctx)));
    if (combos === null) return [unk(TOO_MANY)];
    return uniq(
      combos.map((combo) => {
        let text = '';
        for (let i = 0; i < node.quasis.length; i++) {
          text += node.quasis[i].value.cooked ?? '';
          const v = combo[i];
          if (!v) continue;
          if (v.k === 'str') text += v.v;
          else if (v.k === 'pre') return pre(text + v.v, v.why);
          else if (text === '' && (v.k === 'name' || v.k === 'tmp' || v.k === 'ext')) return v.k === 'name' ? NAME : v;
          else if (text === '') return v.k === 'unk' ? v : unk('a template string starts with a value that is not known');
          else return pre(text, v.k === 'name' ? null : v.k === 'unk' ? v.why : `a template string uses ${inWords(v)}`);
        }
        return str(text);
      })
    );
  };

  const evalConcat = (node, ctx) => {
    const out = [];
    for (const l of evalNode(node.left, ctx)) {
      for (const r of evalNode(node.right, ctx)) {
        if (l.k === 'str' && r.k === 'str') out.push(str(l.v + r.v));
        else if (l.k === 'str' && r.k === 'pre') out.push(pre(l.v + r.v, r.why));
        else if (l.k === 'pre' || l.k === 'name' || passesThrough(l)) out.push(l);
        else if (l.k === 'str' && l.v !== '') out.push(pre(l.v, r.k === 'name' ? null : r.k === 'unk' ? r.why : `a string is joined to ${inWords(r)}`));
        else out.push(unk('it is built from a value that is not known'));
      }
    }
    return uniq(out);
  };

  const evalArray = (node, ctx) => {
    const items = [];
    for (const element of node.elements) {
      if (!element) continue;
      if (element.type === 'SpreadElement') {
        for (const spread of evalNode(element.argument, ctx)) {
          if (spread.k === 'arr') items.push(...spread.items);
          else items.push([spread.k === 'unk' ? spread : unk('it spreads a value that is not a list (array)')]);
        }
      } else {
        items.push(evalNode(element, ctx));
      }
    }
    return arr(items);
  };

  const evalIdentifier = (node, ctx) => {
    const { name } = node;
    const binding = lookup(node, name);
    if (binding) return evalBinding(binding, ctx);
    if (name === '__dirname') return [str(dirname(node.file))];
    if (name === '__filename') return [str(node.file)];
    if (name === 'undefined') return [];
    if (name === 'process') return [unk('it comes from `process`: the command line or the environment, which are chosen when the program starts')];
    return [unk(`\`${name}\` is a global the guard does not follow`)];
  };

  /** The items added to an array by name.push(...) and name.unshift(...). */
  const pushedItems = (binding, ctx) =>
    binding.pushes.flatMap((call) =>
      call.arguments.flatMap((a) => {
        if (a.type !== 'SpreadElement') return [evalNode(a, ctx)];
        return evalNode(a.argument, ctx).flatMap((v) => (v.k === 'arr' ? v.items : [[v.k === 'unk' ? v : unk('items added with a spread of something that is not a list (array)')]]));
      })
    );

  const withPushes = (binding, values, ctx) => {
    if (binding.pushes.length === 0) return values;
    const added = pushedItems(binding, ctx);
    const positionKey = (alternatives) => alternatives.map(keyOf).sort().join('|');
    return uniq(
      values.map((v) => {
        if (v.k !== 'arr') return v;
        const have = new Set(v.items.map(positionKey));
        const fresh = [];
        for (const position of added) {
          const key = positionKey(position);
          if (!have.has(key)) fresh.push(position);
          have.add(key);
        }
        return arr([...v.items, ...fresh]);
      })
    );
  };

  /** What a name holds: where it starts, plus everything later code sets it to. */
  const bindingValues = (binding, ctx) => {
    let out;
    switch (binding.kind) {
      case 'var':
        out = binding.loop ? loopValues(binding.loop, ctx) : binding.inits.flatMap((init) => evalNode(init, ctx));
        if (!binding.loop && binding.inits.length === 0 && binding.assigns.length === 0) out.push(unk(`\`${binding.name}\` is declared but never given a value`));
        break;
      case 'function':
        return [{ k: 'fn', node: binding.fn }];
      case 'param':
        out = evalParam(binding, ctx);
        break;
      case 'part': {
        const sources = binding.owner ? evalBinding(binding.owner, ctx) : binding.loopOver ? loopValues({ kind: 'of', iterable: binding.loopOver }, ctx) : evalNode(binding.init, ctx);
        if (binding.index !== null && binding.index !== undefined) {
          out = sources.flatMap((s) => (s.k === 'arr' ? (s.items[binding.index] ?? []) : [s.k === 'unk' ? s : unk(`item ${binding.index + 1} is taken out of ${inWords(s)}`)]));
          if (out.length === 0) out.push(...binding.defaults.flatMap((d) => evalNode(d, ctx)));
          break;
        }
        out = sources.flatMap((s) => pickProperty(s, binding.key, ctx));
        if (out.length === 0) out.push(...binding.defaults.flatMap((d) => evalNode(d, ctx)));
        break;
      }
      case 'import': {
        const target = linkImport(binding);
        if (target !== binding) return evalBinding(target, { ...ctx, frame: null });
        if (normalizeModule(binding.source) === 'path' && binding.imported === 'sep') return [str(sep)];
        return [unk(`\`${binding.name}\` is imported from ${binding.source}, which is not scanned`)];
      }
      default:
        return [unk(`\`${binding.name}\` is ${binding.why ?? 'not something the guard follows'}`)];
    }
    for (const rhs of binding.assigns) out.push(...evalNode(rhs, ctx));
    if (binding.counted) out.push(NAME);
    if (binding.tainted) out.push(unk(`\`${binding.name}\` is changed in a way the guard does not follow (+=, ++ and the like)`));
    if (binding.mutated) out.push(unk(`\`${binding.name}\` has an item or property set after it is made`));
    return withPushes(binding, uniq(out), ctx);
  };

  const sameOrFewer = (values, known) => {
    const keys = new Set(known.map(keyOf));
    return values.every((v) => keys.has(keyOf(v)));
  };

  /**
   * A name that is worked out from its own earlier value (p = join(p, 'x'), or a
   * walk that passes a folder to itself) is worked out in rounds: each round
   * starts from the best answer so far, until nothing new appears.
   */
  const evalBinding = (binding, ctx) => {
    if (ctx.frame?.has(binding)) return withPushes(binding, ctx.frame.get(binding), ctx);
    if (ctx.approx.has(binding)) {
      ctx.reentered.add(binding);
      return ctx.approx.get(binding);
    }
    let guess = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      ctx.approx.set(binding, guess);
      ctx.reentered.delete(binding);
      let out;
      try {
        out = bindingValues(binding, ctx);
      } finally {
        ctx.approx.delete(binding);
      }
      if (!ctx.reentered.has(binding) || sameOrFewer(out, guess)) {
        ctx.reentered.delete(binding);
        return uniq([...guess, ...out]);
      }
      guess = uniq([...guess, ...out]);
    }
    ctx.reentered.delete(binding);
    return uniq([...guess, unk(`\`${binding.name}\` keeps changing as it is rebuilt, so the guard stops following it`)]);
  };

  /** The values of property `key` of an object literal value. */
  const pickProperty = (source, key, ctx) => {
    if (source.k === 'unk') return [source];
    if (source.k === 'name') return [NAME];
    if (source.k !== 'obj') return [unk(`\`${key}\` is taken out of ${inWords(source)}`)];
    const out = [];
    for (const p of source.node.properties) {
      if (p.type === 'SpreadElement') out.push(unk('it is taken from an object that spreads another object'));
      else if (p.computed) out.push(unk('it is taken from an object that has a key written in [ ]'));
      else if (String(p.key.name ?? p.key.value) === key) out.push(...evalNode(p.value, ctx));
    }
    return out;
  };

  const loopValues = (loop, ctx) => {
    const sources = evalNode(loop.iterable, ctx);
    if (loop.kind === 'in') {
      return uniq(
        sources.flatMap((s) =>
          s.k === 'obj' && s.node.properties.every((p) => p.type === 'Property' && !p.computed)
            ? s.node.properties.map((p) => str(String(p.key.name ?? p.key.value)))
            : [unk('a for...in loop over something that is not a plain object')]
        )
      );
    }
    return uniq(sources.flatMap((s) => (s.k === 'arr' ? itemsOf(s) : [s.k === 'unk' ? s : unk('a loop over a value that is not a list (array)')])));
  };

  const fnLabel = (fn) => {
    const name = fn.$binding?.name ?? fn.id?.name;
    return name ? `\`${name}\`` : 'a function written in place';
  };

  /** What one call passes for a parameter. */
  const argumentValues = (call, param, ctx) => {
    const args = call.arguments;
    if (args.slice(0, param.index + 1).some((a) => a.type === 'SpreadElement')) return [unk('a call passes its arguments with ... (spread)')];
    if (param.rest) return [arr(args.slice(param.index).map((a) => evalNode(a, ctx)))];
    return args[param.index] ? evalNode(args[param.index], ctx) : [];
  };

  /** The items a callback receives from `list.map(callback)` and the like. */
  const itemValues = (call, ctx) =>
    uniq(evalNode(call.callee.object, ctx).flatMap((v) => (v.k === 'arr' ? itemsOf(v) : [v.k === 'unk' ? v : unk('a function run over the items of a value that is not a list (array)')])));

  /** The value of a parameter of an unnamed callback handed straight to a known method. */
  const callbackValues = (param, ctx) => {
    const fn = param.fn;
    const call = fn.parent;
    if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return null;
    const callee = call.callee;
    if (callee.type === 'MemberExpression' && !callee.computed && ITEM_CALLBACK_METHODS.has(callee.property.name)) {
      return param.index === 0 ? itemValues(call, ctx) : [unk(`argument ${param.index + 1} of the function given to .${callee.property.name}()`)];
    }
    // describe.each(table)('name', (a, b) => ...) and the same for it and test
    if (callee.type === 'CallExpression' && callee.callee.type === 'MemberExpression' && callee.callee.property.name === 'each') {
      const rows = evalNode(callee.arguments[0], ctx).flatMap((v) => (v.k === 'arr' ? itemsOf(v) : [v.k === 'unk' ? v : unk('a table that is not a list (array)')]));
      return uniq(rows.flatMap((row) => (row.k === 'arr' ? (row.items[param.index] ?? []) : row.k === 'unk' || param.index === 0 ? [row] : [])));
    }
    return null;
  };

  const evalParam = (param, ctx) => {
    const staticCtx = { ...ctx, frame: null };
    const out = [];
    for (const d of param.defaults) out.push(...evalNode(d, staticCtx));
    const owner = param.fn.$binding;
    if (owner && (callsOf(owner).length > 0 || isUsedAsValue(owner))) {
      for (const call of callsOf(owner)) if (runsInTests(call)) out.push(...argumentValues(call, param, staticCtx));
      for (const use of owner.callbackUses) {
        if (!runsInTests(use.call)) continue;
        out.push(...(param.index === 0 ? itemValues(use.call, staticCtx) : [unk(`argument ${param.index + 1} of the function given to .${use.call.callee.property.name}()`)]));
      }
      if (owner.escapes) out.push(unk(`${fnLabel(param.fn)} is also handed to other code instead of being called directly, so some of its calls are not seen`));
    } else {
      const fromCallback = callbackValues(param, staticCtx);
      if (fromCallback) out.push(...fromCallback);
      else if (out.length === 0) out.push(unk(`\`${param.name}\` is a parameter of ${fnLabel(param.fn)}, which nothing in the scanned files calls`));
    }
    if (out.length === 0) out.push(unk(`no call from a test gives \`${param.name}\` of ${fnLabel(param.fn)} a value`));
    return uniq(out);
  };

  const returnValues = (fn, ctx) => {
    if (fn.body.type !== 'BlockStatement') return evalNode(fn.body, ctx);
    const returned = [];
    const yielded = [];
    const stack = [fn.body];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.type === 'ReturnStatement') {
        if (node.argument) returned.push(...evalNode(node.argument, ctx));
        continue;
      }
      if (node.type === 'YieldExpression' && node.argument) {
        // yield x adds one item; yield* list adds the items of list
        const values = evalNode(node.argument, ctx);
        if (node.delegate) yielded.push(...values.flatMap((v) => (v.k === 'arr' ? v.items : [[v.k === 'unk' ? v : unk('yield* of something that is not a list (array)')]])));
        else yielded.push(values);
      }
      for (const child of childrenOf(node)) if (!FUNCTION_TYPES.has(child.type)) stack.push(child);
    }
    return fn.generator ? [arr(yielded)] : uniq(returned);
  };

  /** Works out what calling `fn` with the arguments of `call` returns. */
  const inlineCall = (fn, call, ctx) => {
    if (ctx.depth >= MAX_CALL_DEPTH) return [unk('functions call each other too deeply to follow')];
    const frame = new Map(ctx.frame ?? []);
    const spreadAt = call.arguments.findIndex((a) => a.type === 'SpreadElement');
    for (const [i, param] of (fn.$params ?? []).entries()) {
      if (!param) continue;
      if (spreadAt !== -1 && i >= spreadAt) {
        frame.set(param, [unk('a call passes its arguments with ... (spread)')]);
      } else if (param.rest) {
        frame.set(param, [arr(call.arguments.slice(i).map((a) => evalNode(a, ctx)))]);
      } else {
        const supplied = call.arguments[i] ? evalNode(call.arguments[i], ctx) : [];
        const defaults = supplied.length === 0 ? param.defaults.flatMap((d) => evalNode(d, { ...ctx, frame: null })) : [];
        frame.set(param, [...supplied, ...defaults]);
      }
    }
    // the same function with the same arguments, already being worked out, adds nothing new
    const key = `${fn.file}:${fn.range[0]}|${(fn.$params ?? []).map((param) => (param ? (frame.get(param) ?? []).map(keyOf).join('+') : '')).join(',')}`;
    if (ctx.active.has(key)) return [];
    ctx.active.add(key);
    try {
      return returnValues(fn, { ...ctx, frame, depth: ctx.depth + 1 });
    } finally {
      ctx.active.delete(key);
    }
  };

  const evalMember = (node, ctx) => {
    if (node.object.type === 'MetaProperty') {
      const prop = node.property.name;
      if (prop === 'url') return [urlv(pathToFileURL(node.file).href)];
      if (prop === 'dirname') return [str(dirname(node.file))];
      if (prop === 'filename') return [str(node.file)];
      return [unk(`import.meta.${prop} is not a file location`)];
    }
    const ref = moduleRef(node);
    if (ref?.mod === 'path' && ref.name === 'sep') return [str(sep)];
    let keys = null;
    if (!node.computed) keys = [node.property.name];
    else {
      const evaluated = evalNode(node.property, ctx);
      if (evaluated.length > 0 && evaluated.every((v) => v.k === 'str')) keys = evaluated.map((v) => v.v);
    }
    const out = [];
    for (const object of evalNode(node.object, ctx)) {
      if (object.k === 'obj') {
        for (const p of object.node.properties) {
          if (p.type === 'SpreadElement') out.push(unk('it is taken from an object that spreads another object'));
          else if (p.computed) out.push(unk('it is taken from an object that has a key written in [ ]'));
          else if (keys === null || keys.includes(String(p.key.name ?? p.key.value))) out.push(...evalNode(p.value, ctx));
        }
      } else if (object.k === 'arr') {
        const indexes = keys?.every((k) => /^\d+$/.test(k)) ? keys.map(Number) : null;
        out.push(...(indexes ? indexes.flatMap((i) => object.items[i] ?? []) : itemsOf(object)));
      } else if (object.k === 'unk' || object.k === 'name') {
        out.push(object);
      } else if ((object.k === 'url' || passesThrough(object)) && keys?.length === 1 && keys[0] === 'href') {
        out.push(object);
      } else {
        out.push(unk(`it reads a property of ${inWords(object)}`));
      }
    }
    return uniq(out);
  };

  const evalNew = (node, ctx) => {
    const ref = moduleRef(node.callee);
    if (ref?.mod === 'global' && ref.name === 'Set') {
      // new Set(list) holds the same items
      return node.arguments[0] ? uniq(evalNode(node.arguments[0], ctx).map((v) => (v.k === 'arr' || v.k === 'unk' ? v : unk('new Set of something that is not a list')))) : [arr([])];
    }
    if (!ref || ref.mod !== 'url' || ref.name !== 'URL') return [unk(`it makes a new ${node.callee.name ?? 'object'}`)];
    const [target, base] = node.arguments;
    if (!target) return [unk('new URL has no argument')];
    if (!base) {
      return uniq(
        evalNode(target, ctx).map((v) => {
          if (v.k !== 'str') return unk('new URL of a value that is not known');
          try {
            return v.v.startsWith('file:') ? urlv(new URL(v.v).href) : EXT;
          } catch {
            return unk('new URL could not make a URL from it');
          }
        })
      );
    }
    const out = [];
    for (const b of evalNode(base, ctx)) {
      if (b.k !== 'url') {
        out.push(b.k === 'unk' ? b : EXT);
        continue;
      }
      for (const t of evalNode(target, ctx)) {
        if (t.k === 'str' || t.k === 'pre') {
          try {
            out.push(urlv(new URL(t.v, b.href).href, b.wild || t.k === 'pre', b.why ?? t.why ?? null));
          } catch {
            out.push(unk('new URL could not make a URL from it'));
          }
        } else if (t.k === 'name') {
          // a name from a listing is one path segment: somewhere in the folder of the base
          out.push(urlv(new URL('./', b.href).href, true, b.why));
        } else {
          out.push(t.k === 'unk' ? t : unk('new URL of a value that is not known'));
        }
      }
    }
    return uniq(out);
  };

  /** The argument lists a call may have: one list of values per position, one variant per way a spread can go. */
  const argumentVariants = (call, ctx) => {
    let variants = [[]];
    for (const a of call.arguments) {
      const next = [];
      if (a.type === 'SpreadElement') {
        for (const v of evalNode(a.argument, ctx)) {
          const positions = v.k === 'arr' ? v.items : [[v.k === 'unk' ? v : unk('it spreads a value that is not a list (array)')]];
          for (const variant of variants) next.push([...variant, ...positions]);
        }
      } else {
        const alternatives = evalNode(a, ctx);
        for (const variant of variants) next.push([...variant, alternatives]);
      }
      variants = next.length > MAX_ALTERNATIVES ? [[...variants[0], [unk(TOO_MANY)]]] : next;
    }
    return variants;
  };

  /** path.join / path.resolve over fully worked-out arguments. */
  const joinValues = (values, isResolve) => {
    let acc = values[0];
    for (const next of values.slice(1)) {
      if (isResolve && next.k === 'str' && isAbsolute(next.v)) {
        acc = next;
        continue;
      }
      if (acc.k === 'pre' || acc.k === 'name') {
        // what follows a part that is not known is added after it, but going up with .. would leave the folder we know
        if (next.k === 'str' && next.v.split(/[\\/]/).includes('..')) return unk('a path goes up (..) after a part the guard does not know');
        continue;
      }
      if (passesThrough(acc)) return acc;
      if (acc.k !== 'str') return unk(`a path is built from ${inWords(acc)}`);
      const folder = endsWithSeparator(acc.v) ? acc.v : acc.v + sep;
      if (next.k === 'str') acc = str(join(acc.v, next.v));
      else if (next.k === 'pre') acc = pre(join(acc.v, next.v) + (endsWithSeparator(next.v) ? sep : ''), next.why);
      else if (next.k === 'tmp' || next.k === 'ext') acc = next;
      else if (next.k === 'name') acc = pre(folder);
      else acc = pre(folder, next.k === 'unk' ? next.why : `a path is built from ${inWords(next)}`);
    }
    if (isResolve && acc.k === 'str') return str(resolve(cwd, acc.v));
    if (isResolve && acc.k === 'pre' && !isAbsolute(acc.v)) return pre(resolve(cwd, acc.v) + (endsWithSeparator(acc.v) ? sep : ''));
    return acc;
  };

  const evalBuiltin = (ref, call, ctx) => {
    const key = `${ref.mod}.${ref.name}`;
    const firstArgument = () => (call.arguments[0] && call.arguments[0].type !== 'SpreadElement' ? evalNode(call.arguments[0], ctx) : [unk('there is no path argument')]);
    switch (key) {
      case 'path.join':
      case 'path.resolve': {
        const out = [];
        for (const variant of argumentVariants(call, ctx)) {
          if (variant.length === 0 || variant.some((alternatives) => alternatives.length === 0)) continue;
          const combos = product(variant);
          if (combos === null) return [unk(TOO_MANY)];
          out.push(...combos.map((combo) => joinValues(combo, key === 'path.resolve')));
        }
        return uniq(out);
      }
      case 'path.dirname':
      case 'path.normalize':
        return uniq(
          firstArgument().map((v) => {
            if (v.k === 'str') return str(key === 'path.dirname' ? dirname(v.v) : join(v.v));
            return passesThrough(v) ? v : unk('dirname of a path that is not fully known');
          })
        );
      case 'url.fileURLToPath':
        return uniq(
          firstArgument().map((v) => {
            const href = v.k === 'url' ? v.href : v.k === 'str' && v.v.startsWith('file:') ? v.v : null;
            if (href === null) return passesThrough(v) ? v : unk('fileURLToPath of a value that is not a file URL');
            const p = fileUrlToPathSafe(href);
            if (p === null) return unk('fileURLToPath could not convert it');
            return v.k === 'url' && v.wild ? pre(p, v.why) : str(p);
          })
        );
      case 'url.pathToFileURL':
        return uniq(
          firstArgument().map((v) => {
            if (v.k === 'str') return urlv(pathToFileURL(v.v).href);
            if (v.k === 'pre') return urlv(pathToFileURL(endsWithSeparator(v.v) ? v.v : dirname(v.v)).href.replace(/\/?$/, '/'), true, v.why);
            return passesThrough(v) ? v : unk('pathToFileURL of a path that is not known');
          })
        );
      case 'path.relative': {
        // relative(base, target): the part of target below base, which join(base, ...) puts back
        const [from, to] = [0, 1].map((i) => (call.arguments[i] && call.arguments[i].type !== 'SpreadElement' ? evalNode(call.arguments[i], ctx) : [unk('there is no path argument')]));
        return uniq(
          from.flatMap((f) =>
            to.map((t) => {
              if (f.k !== 'str') return passesThrough(f) ? f : unk('relative from a path that is not known');
              if (t.k === 'str') return str(relative(f.v, t.v));
              if (t.k === 'pre') return pre(relative(f.v, t.v) + (endsWithSeparator(t.v) ? sep : ''));
              return passesThrough(t) ? t : unk('relative to a path that is not known');
            })
          )
        );
      }
      case 'process.cwd':
        return [str(cwd)];
      case 'os.tmpdir':
      case 'fs.mkdtempSync':
      case 'fs.mkdtemp':
        return [TMP];
      case 'os.homedir':
      case 'fs.openSync':
      case 'fs.open':
        return [EXT];
      case 'fs.readdirSync':
      case 'fs.readdir':
        // the names in a folder: joined to the folder's path they name something inside it
        return [arr([[NAME]])];
      case 'module.createRequire':
        return [{ k: 'req' }];
      case 'global.String':
        return firstArgument();
      case 'object.freeze':
        return firstArgument();
      case 'object.keys':
      case 'object.values':
      case 'object.entries':
        return uniq(
          firstArgument().map((v) => {
            if (v.k !== 'obj') return v.k === 'unk' ? v : unk(`Object.${ref.name} of a value that is not an object literal`);
            const items = [];
            for (const p of v.node.properties) {
              if (p.type === 'SpreadElement' || p.computed) return unk('an object that spreads another object or has a key written in [ ]');
              const name = str(String(p.key.name ?? p.key.value));
              if (ref.name === 'keys') items.push([name]);
              else if (ref.name === 'values') items.push(evalNode(p.value, ctx));
              else items.push([arr([[name], evalNode(p.value, ctx)])]);
            }
            return arr(items);
          })
        );
      default:
        return [unk(`it is the result of ${ref.mod}${ref.name ? `.${ref.name}` : ''}, which the guard does not follow`)];
    }
  };

  /** Methods on a value that is not a function: strings, arrays and the require function. */
  const callMethod = (object, name, call, ctx) => {
    if (object.k === 'unk') return [object];
    if (object.k === 'name' && STRING_METHODS.has(name)) return [object];
    if (object.k === 'parts' && ['at', 'pop'].includes(name)) return [NAME];
    if (object.k === 'str' && (name === 'replaceAll' || name === 'replace') && call.arguments.length === 2) {
      const from = evalNode(call.arguments[0], ctx);
      const to = evalNode(call.arguments[1], ctx);
      if (from.length === 1 && to.length === 1 && from[0].k === 'str' && to[0].k === 'str') {
        return [str(name === 'replaceAll' ? object.v.replaceAll(from[0].v, to[0].v) : object.v.replace(from[0].v, to[0].v))];
      }
    }
    if (object.k === 'str' && (name === 'toString' || name === 'trim')) return [object];
    if ((name === 'replace' || name === 'replaceAll') && call.arguments.length === 2 && call.arguments[0].type === 'Literal' && call.arguments[0].regex) {
      // replace(/\\/g, '/') swaps path separators and leaves the place the path points to alone
      const { pattern, flags } = call.arguments[0].regex;
      const [replacement] = evalNode(call.arguments[1], ctx);
      if (/^[\\/[\]+]+$/.test(pattern) && replacement?.k === 'str' && (replacement.v === '/' || replacement.v === '\\')) {
        if (object.k === 'str' || object.k === 'pre') return [{ ...object, v: object.v.replace(new RegExp(pattern, flags), replacement.v) }];
        if (passesThrough(object) || object.k === 'name') return [object];
      }
    }
    const isSeparator = (v) => v?.k === 'str' && (v.v === '/' || v.v === '\\' || v.v === sep);
    if (name === 'split' && call.arguments.length === 1 && evalNode(call.arguments[0], ctx).every(isSeparator) && (object.k === 'str' || object.k === 'pre' || object.k === 'name' || passesThrough(object))) {
      return [{ k: 'parts', of: object }];
    }
    if (object.k === 'parts' && name === 'join') {
      // path.split(sep).join('/') and back: the same place with the separators swapped
      const joiners = call.arguments.length === 1 ? evalNode(call.arguments[0], ctx) : [];
      if (joiners.length > 0 && joiners.every(isSeparator)) return [object.of];
    }
    if ((object.k === 'tmp' || object.k === 'ext' || object.k === 'name') && STRING_METHODS.has(name)) return [object];
    if (object.k === 'req' && name === 'resolve') return [EXT];
    if (object.k === 'arr') {
      if (['filter', 'slice', 'sort', 'toSorted', 'reverse', 'toReversed'].includes(name)) return [object];
      if (['shift', 'pop', 'at', 'find', 'findLast'].includes(name)) return itemsOf(object);
      if (name === 'entries') return [arr([[arr([[NAME], itemsOf(object)])]])];
      if (name === 'flat') return [arr(object.items.flatMap((alternatives) => alternatives.flatMap((a) => (a.k === 'arr' ? a.items : [[a]]))))];
      if (name === 'concat') {
        const more = call.arguments.flatMap((a) => evalNode(a, ctx)).flatMap((v) => (v.k === 'arr' ? v.items : [[v]]));
        return [arr([...object.items, ...more])];
      }
      if (name === 'map' || name === 'flatMap') {
        if (ctx.depth >= MAX_CALL_DEPTH) return [unk('functions call each other too deeply to follow')];
        const callbacks = evalNode(call.arguments[0], ctx).filter((c) => c.k === 'fn');
        if (callbacks.length === 0) return [unk(`${name} with a function the guard cannot follow`)];
        const items = object.items.map((alternatives) => {
          const results = [];
          for (const { node: cb } of callbacks) {
            const [first, second] = cb.$params ?? [];
            for (const item of alternatives) {
              const frame = new Map(ctx.frame ?? []);
              if (first) frame.set(first, [item]);
              if (second) frame.set(second, [unk('an array index')]);
              results.push(...returnValues(cb, { ...ctx, frame, depth: ctx.depth + 1 }));
            }
          }
          return uniq(name === 'flatMap' ? results.flatMap((r) => (r.k === 'arr' ? itemsOf(r) : [r])) : results);
        });
        return [arr(items)];
      }
    }
    return [unk(`it calls .${name}() on ${inWords(object)}`)];
  };

  const evalCall = (node, ctx) => {
    const callee = node.callee;
    const ref = moduleRef(callee);
    if (ref) return evalBuiltin(ref, node, ctx);

    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
      const out = [];
      for (const object of evalNode(callee.object, ctx)) {
        const method = object.k === 'obj' ? object.node.properties.find((p) => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === callee.property.name) : null;
        if (method && FUNCTION_TYPES.has(method.value.type)) out.push(...inlineCall(method.value, node, ctx));
        else out.push(...callMethod(object, callee.property.name, node, ctx));
      }
      return uniq(out);
    }

    if (callee.type === 'Identifier') {
      const out = [];
      for (const target of evalNode(callee, ctx)) {
        if (target.k === 'fn') out.push(...inlineCall(target.node, node, ctx));
        else out.push(target.k === 'unk' ? target : unk(`it calls \`${callee.name}\`, which is not a function the guard can follow`));
      }
      return uniq(out);
    }
    return [unk('it calls something the guard cannot follow')];
  };

  // ---- the places that read files --------------------------------------------
  const sourceOf = (module, node) => module.text.slice(node.range[0], node.range[1]).replace(/\s+/g, ' ');

  const classify = (value) => {
    switch (value.k) {
      case 'str':
        return { file: isAbsolute(value.v) ? value.v : resolve(cwd, value.v) };
      case 'url': {
        const p = fileUrlToPathSafe(value.href);
        if (p === null) return { unresolved: 'it is a URL that is not a file path' };
        return value.wild ? { dir: endsWithSeparator(p) ? p : dirname(p), unresolved: value.why ?? undefined } : { file: p };
      }
      case 'pre': {
        const p = isAbsolute(value.v) ? value.v : resolve(cwd, value.v);
        return { dir: endsWithSeparator(value.v) ? p : dirname(p), unresolved: value.why ?? undefined };
      }
      case 'tmp':
      case 'ext':
        return {};
      case 'name':
        return { unresolved: 'it is a file name from a folder listing, used without its folder' };
      case 'unk':
        return { unresolved: value.why };
      default:
        return { unresolved: `it is ${inWords(value)}, not a path` };
    }
  };

  /** A module path (import(...), require(...)) is relative to the file it is written in; a bare name is a package. */
  const classifyImport = (file) => (value) => {
    const here = dirname(file);
    switch (value.k) {
      case 'str': {
        const spec = value.v.replace(/[?#].*$/, '');
        if (/^(?:data|https?|node):/.test(spec)) return {};
        if (spec.startsWith('file:')) {
          const p = fileUrlToPathSafe(spec);
          return p === null ? { unresolved: 'it is a URL that is not a file path' } : { file: p };
        }
        if (spec.startsWith('.')) return { file: resolve(here, spec) };
        return isAbsolute(spec) ? { file: spec } : {};
      }
      case 'pre': {
        if (/^(?:data|https?|node):/.test(value.v)) return {};
        const startsLikeAPath = value.v.startsWith('.') || isAbsolute(value.v);
        if (!startsLikeAPath) return value.why ? { unresolved: value.why } : {};
        const p = resolve(here, value.v);
        return { dir: endsWithSeparator(value.v) ? p : dirname(p), unresolved: value.why ?? undefined };
      }
      default:
        return classify(value);
    }
  };

  /** Records a place that reads the path `valueNode`. `where` is the node to quote. */
  const addReference = (module, where, valueNode, primitive, { standalone = false, classifier = classify } = {}) => {
    const results = [];
    const unresolved = [];
    let values;
    try {
      values = evalNode(valueNode, freshContext());
    } catch (error) {
      values = [unk(`it is too complicated for the guard to follow (${error.name})`)];
    }
    if (values.length === 0) unresolved.push('the guard cannot find any value for the path');
    for (const value of values) {
      const c = classifier(value);
      if (c.file) results.push({ kind: 'file', path: c.file });
      if (c.dir) results.push({ kind: 'dir', path: c.dir });
      if (c.unresolved && !standalone) unresolved.push(c.unresolved);
    }
    if (standalone && results.length === 0) return;
    references.push({ file: module.file, line: where.loc.start.line, expression: sourceOf(module, where), primitive, results, unresolved: [...new Set(unresolved)] });
  };

  const addProblem = (module, where, primitive, reason) => {
    references.push({ file: module.file, line: where.loc.start.line, expression: sourceOf(module, where), primitive, results: [], unresolved: [reason] });
  };

  /** import.meta.glob('../x/*.md'): every file in the folder before the first * or ?. */
  const addGlobReference = (module, node) => {
    const [patternNode] = node.arguments;
    const patterns = patternNode?.type === 'ArrayExpression' ? patternNode.elements : [patternNode];
    if (!patterns.every((p) => p?.type === 'Literal' && typeof p.value === 'string')) {
      addProblem(module, node, 'import.meta.glob', 'import.meta.glob is given a pattern that is not plain text');
      return;
    }
    const results = [];
    for (const { value } of patterns) {
      if (value.startsWith('!')) continue;
      const prefix = value.split(/[*?[{(]/)[0];
      const base = value.startsWith('/') ? join(cwd, prefix) : resolve(dirname(module.file), prefix);
      results.push({ kind: 'dir', path: endsWithSeparator(prefix) ? base : dirname(base) });
    }
    references.push({ file: module.file, line: node.loc.start.line, expression: sourceOf(module, node), primitive: 'import.meta.glob', results, unresolved: [] });
  };

  /** require(...) in any spelling: the plain name, or a function made by createRequire. */
  const isRequireLike = (callee) => {
    if (callee.type !== 'Identifier') return false;
    if (callee.name === 'require') return true;
    const binding = lookup(callee, callee.name);
    return binding?.kind === 'var' && binding.inits.some((init) => init.type === 'CallExpression' && moduleRef(init.callee)?.name === 'createRequire');
  };

  /** The name a call is made under: readFileSync in readFileSync(x) and in fs.readFileSync(x). */
  const calledName = (callee) => (callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : '');

  /** Whether a called name is a function written in the files being scanned (not something that reads files for us). */
  const isDefinedHere = (callee) => {
    if (callee.type !== 'Identifier') return false;
    const binding = lookup(callee, callee.name);
    return Boolean(binding && (binding.kind === 'function' || binding.inits?.some((init) => FUNCTION_TYPES.has(init.type))));
  };

  const isMemberOf = (parent, node) => parent.type === 'MemberExpression' && parent.object === node && (!parent.computed || (parent.property.type === 'Literal' && typeof parent.property.value === 'string'));

  for (const module of loaded.values()) {
    if (!reportIn(module.file)) continue;
    for (const node of module.nodes) {
      const parent = node.parent;
      if (node.type === 'CallExpression') {
        const ref = moduleRef(node.callee);
        const [first] = node.arguments;
        if (ref?.mod === 'fs' && READ_FUNCTIONS.has(ref.name)) {
          if (!runsInTests(node)) continue;
          if (first && first.type !== 'SpreadElement') addReference(module, node, first, ref.name);
          else addProblem(module, node, ref.name, `${ref.name} is called without a path argument the guard can read`);
        } else if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'MetaProperty' && !node.callee.computed && node.callee.property.name === 'glob') {
          if (runsInTests(node)) addGlobReference(module, node);
        } else if (FILE_LOOKING_NAMES.has(calledName(node.callee)) && ref?.mod !== 'fs' && !isDefinedHere(node.callee) && runsInTests(node)) {
          // readFileSync(...) from something the guard cannot trace to Node's fs: say so rather than ignore it
          addProblem(module, node, calledName(node.callee), `${calledName(node.callee)}(...) looks like a file read, but the guard cannot tell it comes from Node's fs module, so the path it reads is unknown`);
        } else if (isRequireLike(node.callee) && first && first.type !== 'SpreadElement') {
          // a plain package name is not a file in the repository
          const isPackageName = first.type === 'Literal' && !String(first.value).startsWith('.');
          if (!isPackageName && runsInTests(node)) addReference(module, node, first, 'require', { classifier: classifyImport(module.file) });
        }
      } else if (node.type === 'ImportExpression') {
        if (node.source.type !== 'Literal' && runsInTests(node)) {
          addReference(module, node, node.source, 'import()', { classifier: classifyImport(module.file) });
        } else if (node.source.type === 'Literal' && normalizeModule(String(node.source.value)) === 'fs' && parent.type !== 'AwaitExpression' && runsInTests(node)) {
          addProblem(module, node, 'import()', 'the fs module is imported without await, so what is done with it cannot be followed');
        }
      } else if (node.type === 'NewExpression' && node.arguments.length >= 2) {
        // new URL(path, <a file URL>) names a file next to the module (or in a folder). It may only be
        // an import, so an unknown path here is not a problem unless an fs call receives it.
        const ref = moduleRef(node.callee);
        if (ref?.mod === 'url' && ref.name === 'URL' && runsInTests(node) && evalNode(node.arguments[1], freshContext()).some((b) => b.k === 'url')) {
          addReference(module, node, node, 'new URL', { standalone: true });
        }
      }

      // A file function handed around, or the fs module stored or looked up by name, hides the paths read through it.
      const mayNameFs = node.type === 'Identifier' ? isValueReference(node) : ['MemberExpression', 'CallExpression', 'AwaitExpression'].includes(node.type);
      if (!mayNameFs) continue;
      const ref = moduleRef(node);
      if (ref?.mod !== 'fs') continue;
      if (ref.name !== null && READ_FUNCTIONS.has(ref.name)) {
        const isCallee = parent.type === 'CallExpression' && parent.callee === node;
        if (!isCallee && runsInTests(node)) {
          addProblem(module, node, ref.name, `${ref.name} is handed to other code instead of being called directly, so the paths it reads cannot be followed`);
        }
      } else if (ref.name === null) {
        // export default fs is followed where the default export is imported (originOf), so it is not a problem here
        const declared = (parent.type === 'VariableDeclarator' && parent.init === node && requiredModule(node) !== null) || parent.type === 'ExportDefaultDeclaration';
        if (!isMemberOf(parent, node) && !declared && runsInTests(node)) {
          addProblem(module, node, 'fs', 'the fs module is stored, passed on or looked up by a name worked out at run time, so the files read through it are unknown');
        }
      }
    }
  }

  return { references };
}
