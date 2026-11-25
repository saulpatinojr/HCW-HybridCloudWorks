/** How the code uses a name: read as a value, set again, changed in place, or handed to a list method. */
import { FUNCTION_TYPES, lookup, patternIdentifiers } from './syntax.mjs';

/** Array methods whose callback receives the array's items. */
export const ITEM_CALLBACK_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'some', 'every', 'find', 'findLast']);

/** The value, or a computed key, of a property or class field is a use; a plain key is not. */
const valueOrComputedKey = (parent, node) => parent.value === node || (parent.key === node && parent.computed);
const neverAReference = () => false;

/** For an Identifier under each kind of parent: whether it is a use of a name. A parent not here makes it one. */
const REFERENCE_RULES = new Map([
  ['MemberExpression', (parent, node) => parent.object === node || (parent.property === node && parent.computed)],
  ['Property', (parent, node) => parent.parent.type !== 'ObjectPattern' && valueOrComputedKey(parent, node)],
  ['VariableDeclarator', (parent, node) => parent.init === node],
  // function load(p, read = readFileSync): the default is a use, the name on the left is a declaration
  ['AssignmentPattern', (parent, node) => parent.right === node],
  // class R { read = readFileSync }
  ['PropertyDefinition', valueOrComputedKey],
  ...['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].map((type) => [type, (parent, node) => parent.body === node]),
  ...[
    'ImportSpecifier',
    'ImportDefaultSpecifier',
    'ImportNamespaceSpecifier',
    'ExportSpecifier',
    'LabeledStatement',
    'BreakStatement',
    'ContinueStatement',
    'MethodDefinition',
    'CatchClause',
    'RestElement',
    'ArrayPattern',
    'ObjectPattern',
    'ClassDeclaration',
  ].map((type) => [type, neverAReference]),
]);

/** Whether an Identifier is a use of a name (not a property key, label or declaration). */
export function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  const rule = REFERENCE_RULES.get(parent.type);
  return rule ? rule(parent, node) : true;
}

const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

/** Whether code runs more than once because of a loop around it (or a list method's callback), within its own function. */
function insideLoop(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (LOOP_TYPES.has(n.type)) return true;
    if (FUNCTION_TYPES.has(n.type)) return isListCallback(n);
  }
  return false;
}

/** Whether a function is passed to a list method that calls it once per item (`map`, `forEach`, `reduce` ...). */
function isListCallback(fn) {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return false;
  return call.callee.type === 'MemberExpression' && !call.callee.computed && [...ITEM_CALLBACK_METHODS, 'reduce', 'reduceRight'].includes(call.callee.property.name);
}

/** Notes what an assignment does to each name it sets: a new value, a count, or a change the guard does not follow. */
export function recordAssignment(node) {
  const targets = node.left.type === 'Identifier' ? [node.left] : patternIdentifiers(node.left);
  for (const id of targets) {
    const binding = lookup(id, id.name);
    if (binding) recordAssignmentTo(binding, node);
  }
}

function recordAssignmentTo(binding, node) {
  if (insideLoop(node)) binding.loopAssigned = true;
  const plainName = node.left.type === 'Identifier';
  const addsNumber = node.right.type === 'Literal' && typeof node.right.value === 'number';
  if (node.operator === '=' && plainName) binding.assigns.push(node.right);
  else if (node.operator === '+=' && plainName && addsNumber) binding.counted = true;
  // p += '/docs' is p = p + '/docs'
  else if (node.operator === '+=' && plainName) binding.assigns.push({ type: 'BinaryExpression', operator: '+', left: node.left, right: node.right });
  else binding.tainted = true;
}

/** `name.method(...)`, with the method written with a dot. */
export function isMethodCallOnName(node) {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && !node.callee.computed;
}

/** `list.map(fn)` and the other ITEM_CALLBACK_METHODS, with `node` as the callback. */
export function isItemCallbackArgument(call, node) {
  if (call.type !== 'CallExpression' || call.arguments[0] !== node) return false;
  return call.callee.type === 'MemberExpression' && !call.callee.computed && ITEM_CALLBACK_METHODS.has(call.callee.property.name);
}

/** The name at the start of `a.b[c].d`, or null. */
function rootIdentifier(member) {
  let n = member;
  while (n.type === 'MemberExpression') n = n.object;
  return n.type === 'Identifier' ? n : null;
}

/** Notes a name whose object or list is changed after it is made: x.k = v, x[i] = v, x.splice(...), Object.assign(x, ...). */
export function markMutations(node) {
  const target = mutationTarget(node);
  const binding = target && lookup(target, target.name);
  if (binding) binding.mutated = true;
}

/** The name whose object or list `node` changes, or null. */
function mutationTarget(node) {
  if (isMemberWrite(node)) return rootIdentifier(node.type === 'UpdateExpression' ? node.argument : node.left);
  if (node.type === 'UnaryExpression' && node.operator === 'delete' && node.argument.type === 'MemberExpression') return rootIdentifier(node.argument);
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') return mutatingCallTarget(node);
  return null;
}

/** x.k = v, x[i] = v, x.k++ and the like. */
function isMemberWrite(node) {
  if (node.type === 'AssignmentExpression') return node.left.type === 'MemberExpression';
  return node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression';
}

/** The methods that change the list they are called on, in place; push and unshift are followed for a plain name. */
const IN_PLACE_METHODS = ['splice', 'fill', 'copyWithin'];
/** The methods of Object that change their first argument. */
const OBJECT_CHANGERS = ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'];

/** The name a method call changes: list.splice(...), a.b.push(...), Object.assign(x, ...); else null. */
function mutatingCallTarget(node) {
  const { object, property } = node.callee;
  const method = node.callee.computed ? null : property.name;
  if (IN_PLACE_METHODS.includes(method) || (['push', 'unshift'].includes(method) && object.type !== 'Identifier')) return rootIdentifier(object);
  const isObjectMethod = object.type === 'Identifier' && object.name === 'Object' && OBJECT_CHANGERS.includes(method);
  return isObjectMethod && node.arguments[0]?.type === 'Identifier' ? node.arguments[0] : null;
}
