/** What each declaration in a module adds to the table of names (see syntax.mjs). */
import { DESTRUCTURED } from './values.mjs';
import { FUNCTION_TYPES, bind, patternIdentifiers, scopeOf } from './syntax.mjs';
import { declareParts, declarePatternVariable, propertyDeclaring, staticKey } from './declare-patterns.mjs';

/** The module name in `require('x')` or `await import('x')`, else null. */
export function requiredModule(node) {
  const n = node?.type === 'AwaitExpression' ? node.argument : node;
  if (n?.type === 'ImportExpression' && n.source.type === 'Literal') return String(n.source.value);
  return isPlainRequire(n) ? n.arguments[0].value : null;
}

/** `require('x')`: the require function called with one string written out. */
function isPlainRequire(n) {
  if (n?.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'require') return false;
  return n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string';
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
  const scope = scopeOf(declaration, declaration.kind === 'var');
  const loop = loopOf(declaration);
  const moduleName = requiredModule(node.init);

  if (node.id.type === 'Identifier') declareNamedVariable(scope, node, { moduleName, loop });
  else if (moduleName !== null) declareRequiredParts(scope, node, moduleName);
  else declarePatternVariable(scope, node, loop);
}

/** For `for (const x of list)` and `for (const x in object)`: which kind of loop, and what it goes over; else null. */
function loopOf(declaration) {
  const owner = declaration.parent;
  const isLoop = (owner.type === 'ForOfStatement' || owner.type === 'ForInStatement') && owner.left === declaration;
  return isLoop ? { kind: owner.type === 'ForOfStatement' ? 'of' : 'in', iterable: owner.right } : null;
}

/** `const x = ...`: an import when it is a require, else a name with what it is set to. */
function declareNamedVariable(scope, node, { moduleName, loop }) {
  if (moduleName !== null) {
    bind(scope, node.id.name, { kind: 'import', source: moduleName, imported: '*', file: node.file });
    return;
  }
  const binding = bind(scope, node.id.name, { inits: node.init ? [node.init] : [], loop });
  if (node.init && FUNCTION_TYPES.has(node.init.type)) node.init.$binding = binding;
}

/** const { readFileSync } = require('node:fs') */
function declareRequiredParts(scope, node, moduleName) {
  for (const id of patternIdentifiers(node.id)) {
    const key = staticKey(propertyDeclaring(node.id, id));
    if (key === null) bind(scope, id.name, { kind: 'opaque', why: DESTRUCTURED });
    else bind(scope, id.name, { kind: 'import', source: moduleName, imported: key, file: node.file });
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

/** What each kind of node declares in the table of names. */
export const DECLARERS = new Map([
  ['ImportDeclaration', declareImport],
  ['FunctionDeclaration', declareFunction],
  ['FunctionExpression', declareFunction],
  ['ArrowFunctionExpression', declareFunction],
  ['VariableDeclarator', declareVariable],
  [
    'ClassDeclaration',
    (node) => {
      if (node.id) bind(scopeOf(node, false), node.id.name, { kind: 'opaque', why: 'a class' });
    },
  ],
  [
    'CatchClause',
    (node) => {
      if (node.param) for (const id of patternIdentifiers(node.param)) bind(node, id.name, { kind: 'opaque', why: 'a caught error' });
    },
  ],
]);
