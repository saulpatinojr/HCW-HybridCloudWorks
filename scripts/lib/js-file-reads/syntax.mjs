/**
 * Parsing, walking the syntax tree, and the table of names (which name is
 * declared where) that the rest of the analysis reads.
 */
import * as espree from 'espree';

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
export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

export function parse(text) {
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

export function* childrenOf(node) {
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
export function annotate(root, file) {
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

export function scopeOf(node, hoistToFunction) {
  for (let n = node.parent; n; n = n.parent) {
    if (hoistToFunction ? FUNCTION_TYPES.has(n.type) || n.type === 'Program' : SCOPE_TYPES.has(n.type)) return n;
  }
  return null;
}

/** Declares `name` in a scope node and returns its binding (the record for that name). */
export function bind(scopeNode, name, props) {
  scopeNode.$scope ??= new Map();
  let binding = scopeNode.$scope.get(name);
  if (!binding) {
    binding = { name, kind: 'var', inits: [], assigns: [], calls: [], viaParams: [], callbackUses: [], pushes: [], tainted: false, counted: false, mutated: false, loopAssigned: false, escapes: false, ...props };
    scopeNode.$scope.set(name, binding);
  } else if (props.inits) {
    binding.inits.push(...props.inits);
  }
  return binding;
}

export function lookup(node, name) {
  for (let n = node; n; n = n.parent) {
    const binding = n.$scope?.get(name);
    if (binding) return binding;
  }
  return null;
}

/** The patterns inside each kind of destructuring pattern, in order. */
const PATTERN_PARTS = new Map([
  ['ObjectPattern', (pattern) => pattern.properties.map((p) => (p.type === 'RestElement' ? p.argument : p.value))],
  ['ArrayPattern', (pattern) => pattern.elements.filter(Boolean)],
  ['AssignmentPattern', (pattern) => [pattern.left]],
  ['RestElement', (pattern) => [pattern.argument]],
]);

export function patternIdentifiers(pattern, out = []) {
  if (pattern.type === 'Identifier') {
    out.push(pattern);
    return out;
  }
  const parts = PATTERN_PARTS.get(pattern.type);
  if (parts) for (const part of parts(pattern)) patternIdentifiers(part, out);
  return out;
}

export function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_TYPES.has(n.type)) return n;
  return null;
}

/** The function a binding names: a function declaration, or a name set to an arrow or function expression. */
export function functionOf(binding) {
  if (binding.kind === 'function') return binding.fn;
  return binding.inits?.find((init) => FUNCTION_TYPES.has(init.type)) ?? null;
}

/** A binding that holds a function: declared as one, or set to one. */
export function isFunctionBinding(binding) {
  return binding.kind === 'function' || binding.inits.some((i) => FUNCTION_TYPES.has(i.type));
}
