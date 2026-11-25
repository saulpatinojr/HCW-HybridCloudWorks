/** Methods on a value that is not a function: strings, arrays and the require function. */
import { sep } from 'node:path';
import { EXT, MAX_CALL_DEPTH, NAME, arr, inWords, itemsOf, passesThrough, str, uniq, unk } from './values.mjs';
import { evalNode } from './evaluate.mjs';
import { returnValues } from './evaluate-calls.mjs';

/** String methods that turn a path into another path in the same place. */
const STRING_METHODS = new Set(['replace', 'replaceAll', 'trim', 'trimEnd', 'trimStart', 'toString', 'normalize', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'concat']);

const SEPARATORS = new Set(['/', '\\', sep]);
const isSeparator = (v) => v?.k === 'str' && SEPARATORS.has(v.v);
const isReplace = (name) => name === 'replace' || name === 'replaceAll';
const isOneText = (values) => values.length === 1 && values[0].k === 'str';

/** 'a-b'.replace('-', '/') with both texts known. */
function replaceText(object, name, call, ctx) {
  if (object.k !== 'str' || !isReplace(name) || call.arguments.length !== 2) return null;
  const from = evalNode(call.arguments[0], ctx);
  const to = evalNode(call.arguments[1], ctx);
  if (!isOneText(from) || !isOneText(to)) return null;
  return [str(name === 'replaceAll' ? object.v.replaceAll(from[0].v, to[0].v) : object.v.replace(from[0].v, to[0].v))];
}

/** replace(/\\/g, '/') swaps path separators and leaves the place the path points to alone. */
function swapSeparators(object, name, call, ctx) {
  const [patternNode, replacementNode] = call.arguments;
  if (!isReplace(name) || call.arguments.length !== 2 || patternNode.type !== 'Literal' || !patternNode.regex) return null;
  const { pattern, flags } = patternNode.regex;
  const [replacement] = evalNode(replacementNode, ctx);
  if (!/^[\\/[\]+]+$/.test(pattern) || replacement?.k !== 'str' || (replacement.v !== '/' && replacement.v !== '\\')) return null;
  if (object.k === 'str' || object.k === 'pre') return [{ ...object, v: object.v.replace(new RegExp(pattern, flags), replacement.v) }];
  return passesThrough(object) || object.k === 'name' ? [object] : null;
}

/** path.split(sep): a path cut into pieces, which only join(sep) puts back. */
function splitPath(object, name, call, ctx) {
  if (name !== 'split' || call.arguments.length !== 1 || !evalNode(call.arguments[0], ctx).every(isSeparator)) return null;
  const canSplit = object.k === 'str' || object.k === 'pre' || object.k === 'name' || passesThrough(object);
  return canSplit ? [{ k: 'parts', of: object }] : null;
}

/** path.split(sep).join('/') and back: the same place with the separators swapped. */
function joinParts(object, name, call, ctx) {
  if (object.k !== 'parts' || name !== 'join') return null;
  const joiners = call.arguments.length === 1 ? evalNode(call.arguments[0], ctx) : [];
  return joiners.length > 0 && joiners.every(isSeparator) ? [object.of] : null;
}

/** What one callback returns for one item of the list, with its second parameter (the index) not known. */
function callbackResult(cb, item, ctx) {
  const [first, second] = cb.$params ?? [];
  const frame = new Map(ctx.frame ?? []);
  if (first) frame.set(first, [item]);
  if (second) frame.set(second, [unk('an array index')]);
  return returnValues(cb, { ...ctx, frame, depth: ctx.depth + 1 });
}

/** One position of list.map(cb) or list.flatMap(cb): what each callback returns for each value the position may hold. */
function mappedPosition(alternatives, callbacks, name, ctx) {
  const results = [];
  for (const { node: cb } of callbacks) {
    for (const item of alternatives) results.push(...callbackResult(cb, item, ctx));
  }
  return uniq(name === 'flatMap' ? results.flatMap((r) => (r.k === 'arr' ? itemsOf(r) : [r])) : results);
}

function mapItems(object, call, ctx, name) {
  if (ctx.depth >= MAX_CALL_DEPTH) return [unk('functions call each other too deeply to follow')];
  const callbacks = evalNode(call.arguments[0], ctx).filter((c) => c.k === 'fn');
  if (callbacks.length === 0) return [unk(`${name} with a function the guard cannot follow`)];
  return [arr(object.items.map((alternatives) => mappedPosition(alternatives, callbacks, name, ctx)))];
}

function concatItems(object, call, ctx) {
  const more = call.arguments.flatMap((a) => evalNode(a, ctx)).flatMap((v) => (v.k === 'arr' ? v.items : [[v]]));
  return [arr([...object.items, ...more])];
}

/** What each list method returns. A method not here is not followed. */
const ARRAY_METHODS = new Map([
  ...['filter', 'slice', 'sort', 'toSorted', 'reverse', 'toReversed'].map((method) => [method, (object) => [object]]),
  ...['shift', 'pop', 'at', 'find', 'findLast'].map((method) => [method, (object) => itemsOf(object)]),
  ['entries', (object) => [arr([[arr([[NAME], itemsOf(object)])]])]],
  ['flat', (object) => [arr(object.items.flatMap((alternatives) => alternatives.flatMap((a) => (a.k === 'arr' ? a.items : [[a]]))))]],
  ['concat', concatItems],
  ['map', mapItems],
  ['flatMap', mapItems],
]);

function arrayMethod(object, name, call, ctx) {
  const method = object.k === 'arr' ? ARRAY_METHODS.get(name) : null;
  return method ? method(object, call, ctx, name) : null;
}

/** The rules, in order; the first that gives an answer wins. Each returns null when it does not apply. */
const METHOD_RULES = [
  (object) => (object.k === 'unk' ? [object] : null),
  (object, name) => (object.k === 'name' && STRING_METHODS.has(name) ? [object] : null),
  (object, name) => (object.k === 'parts' && ['at', 'pop'].includes(name) ? [NAME] : null),
  replaceText,
  (object, name) => (object.k === 'str' && (name === 'toString' || name === 'trim') ? [object] : null),
  swapSeparators,
  splitPath,
  joinParts,
  (object, name) => ((object.k === 'tmp' || object.k === 'ext' || object.k === 'name') && STRING_METHODS.has(name) ? [object] : null),
  (object, name) => (object.k === 'req' && name === 'resolve' ? [EXT] : null),
  arrayMethod,
];

export function callMethod(object, name, call, ctx) {
  for (const rule of METHOD_RULES) {
    const result = rule(object, name, call, ctx);
    if (result) return result;
  }
  return [unk(`it calls .${name}() on ${inWords(object)}`)];
}
