/**
 * How the log-line tests (log-scan.test-helper.js, whose header explains
 * them) read a module's syntax tree: parse it with every node linked to its
 * parent, walk its children, and name what a node is: the expression under
 * wrappers, a member's property, the names a pattern declares, the scope and
 * the function a node sits in. This file is test code: nothing the deployed
 * functions run imports it.
 */
import { parseSync } from 'vite';

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

/** Whether a value is a syntax-tree node (it has a `type`). */
const isNode = (value) => Boolean(value) && typeof value.type === 'string';

/**
 * Visit every child node of `node`.
 *
 * @param {object} node - an ESTree node
 * @param {(child: object) => void} fn - called per child node
 */
export function eachChild(node, fn) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'parent' || !value || typeof value !== 'object') continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) if (isNode(item)) fn(item);
  }
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

/** The names one property of an object pattern declares. */
function propertyNames(prop, out) {
  if (prop.type === 'RestElement') {
    patternNames(prop.argument, '...', out);
    return;
  }
  const key = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : (prop.key.value ?? '[]');
  patternNames(prop.value, String(key), out);
}

/** How each kind of binding pattern adds its names to `out`. */
const PATTERN_READERS = new Map([
  ['Identifier', (pattern, from, out) => out.push({ name: pattern.name, from })],
  ['AssignmentPattern', (pattern, from, out) => patternNames(pattern.left, from, out)],
  ['RestElement', (pattern, _from, out) => patternNames(pattern.argument, '...', out)],
  ['ArrayPattern', (pattern, _from, out) => pattern.elements.forEach((el) => patternNames(el, '[]', out))],
  ['ObjectPattern', (pattern, _from, out) => pattern.properties.forEach((prop) => propertyNames(prop, out))],
]);

/** The names a binding pattern declares, each with the property it was read from (or null). */
export function patternNames(pattern, from = null, out = []) {
  if (!pattern) return out;
  PATTERN_READERS.get(pattern.type)?.(pattern, from, out);
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

/** The name a function takes from what holds it: its variable, property, method or assignment; else null. */
function holderName(holder) {
  if (holder?.type === 'VariableDeclarator' && holder.id.type === 'Identifier') return holder.id.name;
  if ((holder?.type === 'Property' || holder?.type === 'MethodDefinition') && holder.key?.name) return holder.key.name;
  if (holder?.type === 'AssignmentExpression') return lastName(holder.left) ?? '(anonymous)';
  return null;
}

/** The name of the function a node sits in, for a site's key. */
export function functionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunction(current)) continue;
    const name = current.id?.name || holderName(current.parent);
    if (name) return name;
  }
  return '(module)';
}
