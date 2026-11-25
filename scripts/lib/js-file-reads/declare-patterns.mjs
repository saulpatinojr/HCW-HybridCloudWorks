/** Names declared by destructuring: `const { a } = x`, `({ a }) => ...` and `for (const [k, v] of list)`. */
import { DESTRUCTURED } from './values.mjs';
import { bind, patternIdentifiers } from './syntax.mjs';

/** The name of an object property written out (`{ a }`, `{ 'a': x }`), or null for a computed one or anything else. */
export function staticKey(property) {
  return property?.type === 'Property' && !property.computed ? (property.key.name ?? property.key.value) : null;
}

/** The property of an object pattern that declares `id` (`{ a }` or `{ a = 1 }`), or null. */
export function propertyDeclaring(pattern, id) {
  if (pattern.type !== 'ObjectPattern') return null;
  return pattern.properties.find((p) => p.type === 'Property' && (p.value === id || p.value?.left === id)) ?? null;
}

/** Declares the names taken out of an object by a destructuring pattern. `from` is { owner } or { init }. */
export function declareParts(scopeNode, pattern, from) {
  for (const id of patternIdentifiers(pattern)) {
    const property = propertyDeclaring(pattern, id);
    const key = staticKey(property);
    if (key === null) bind(scopeNode, id.name, { kind: 'opaque', why: DESTRUCTURED });
    else bind(scopeNode, id.name, { kind: 'part', key, defaults: property.value.type === 'AssignmentPattern' ? [property.value.right] : [], ...from });
  }
}

/** for (const { a } of list) and for (const [k, v] of list): the names are taken from each item of the list. */
function declareLoopParts(scope, pattern, iterable) {
  const isArray = pattern.type === 'ArrayPattern';
  (isArray ? pattern.elements : pattern.properties).forEach((element, index) => {
    if (element) declareLoopPart(scope, element, { isArray, index, iterable });
  });
}

/** One name of a loop's pattern: a part of each item, or opaque when the guard cannot say which part. */
function declareLoopPart(scope, element, { isArray, index, iterable }) {
  const target = loopPartTarget(element, isArray);
  const id = target?.type === 'AssignmentPattern' ? target.left : target;
  const key = isArray ? null : staticKey(element);
  if (id?.type !== 'Identifier' || (!isArray && key === null)) {
    for (const ident of patternIdentifiers(element.type === 'RestElement' ? element.argument : (target ?? element))) bind(scope, ident.name, { kind: 'opaque', why: DESTRUCTURED });
    return;
  }
  bind(scope, id.name, { kind: 'part', key, index: isArray ? index : null, loopOver: iterable, defaults: target.type === 'AssignmentPattern' ? [target.right] : [] });
}

/** What a loop pattern's element declares: the element itself in a list, a property's value in an object. */
function loopPartTarget(element, isArray) {
  if (isArray) return element;
  return element.type === 'Property' ? element.value : null;
}

/** A destructured declaration: parts of an object, parts of each item of a loop, or names the guard does not follow. */
export function declarePatternVariable(scope, node, loop) {
  const isPattern = node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern';
  if (node.init && node.id.type === 'ObjectPattern' && !loop) {
    declareParts(scope, node.id, { init: node.init });
  } else if (loop?.kind === 'of' && isPattern) {
    declareLoopParts(scope, node.id, loop.iterable);
  } else {
    for (const id of patternIdentifiers(node.id)) bind(scope, id.name, { kind: 'opaque', why: DESTRUCTURED });
  }
}
