/**
 * The values the file-read analysis works with (see ../js-file-reads.mjs), and
 * the small helpers that build, compare and describe them.
 */
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_ALTERNATIVES = 200;
export const MAX_COMBINATIONS = 2000;
export const MAX_STEPS = 50000;
export const MAX_CALL_DEPTH = 10;
export const MAX_ROUNDS = 6;

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
export const str = (v) => ({ k: 'str', v });
export const pre = (v, why = null) => ({ k: 'pre', v, why });
export const unk = (why) => ({ k: 'unk', why });
export const urlv = (href, wild = false, why = null) => ({ k: 'url', href, wild, why });
export const arr = (items) => ({ k: 'arr', items });
export const NAME = { k: 'name' };
export const TMP = { k: 'tmp' };
export const EXT = { k: 'ext' };
export const TOO_MANY = 'it has too many possible values to follow';
export const DESTRUCTURED = 'taken out of an object or list (with { } or [ ] on the left of =), which the guard does not follow';

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
export const plainCode = (type) => CODE_WORDS[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** How each kind of value is written as a key, so two equal values get one key. A kind not here is its own key. */
const KEY_WRITERS = new Map([
  ['str', (v) => `str:${v.v}`],
  ['pre', (v) => `pre:${v.v}:${v.why ?? ''}`],
  ['url', (v) => `url:${v.href}:${v.wild}:${v.why ?? ''}`],
  ['unk', (v) => `unk:${v.why}`],
  ['arr', (v) => `arr[${v.items.map((alts) => alts.map(keyOf).join('|')).join(',')}]`],
  ['obj', (v) => `${v.k}:${v.node.file}:${v.node.range[0]}`],
  ['fn', (v) => `${v.k}:${v.node.file}:${v.node.range[0]}`],
  ['parts', (v) => `parts:${keyOf(v.of)}`],
]);

export function keyOf(v) {
  const write = KEY_WRITERS.get(v.k);
  return write ? write(v) : v.k;
}

export function uniq(values) {
  const seen = new Map();
  for (const v of values) seen.set(keyOf(v), v);
  const out = [...seen.values()];
  return out.length > MAX_ALTERNATIVES ? [unk(TOO_MANY)] : out;
}

/** Every way of picking one value from each list, or null if there are too many. */
export function product(lists) {
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
export const itemsOf = (array) => uniq(array.items.flat());

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
export const inWords = (v) => VALUE_WORDS[v.k] ?? v.k;

/** A value that stands for "not a path I can use", carried through unchanged. */
export const passesThrough = (v) => v.k === 'unk' || v.k === 'tmp' || v.k === 'ext';

export function normalizeModule(spec) {
  const name = spec.replace(/^node:/, '');
  if (name === 'fs/promises') return 'fs';
  if (name === 'path/posix' || name === 'path/win32') return 'path';
  return name;
}

export const isRelative = (spec) => spec.startsWith('.');
export const endsWithSeparator = (text) => text.endsWith('/') || text.endsWith(sep);

export function fileUrlToPathSafe(href) {
  try {
    return fileURLToPath(href);
  } catch {
    return null;
  }
}

/**
 * The positions a spread value adds to a list: a list's own positions, or one
 * position holding the unknown value (or `why`, when it is something else).
 */
export function positionsOf(v, why) {
  if (v.k === 'arr') return v.items;
  return [[v.k === 'unk' ? v : unk(why)]];
}

export function sameOrFewer(values, known) {
  const keys = new Set(known.map(keyOf));
  return values.every((v) => keys.has(keyOf(v)));
}
