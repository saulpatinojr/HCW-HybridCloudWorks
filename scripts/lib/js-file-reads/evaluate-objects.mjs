/** Reading a property (`a.b`, `a[i]`, `import.meta.url`) and making an object (`new URL(...)`, `new Set(...)`). */
import { dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT, arr, inWords, itemsOf, passesThrough, str, uniq, unk, urlv } from './values.mjs';
import { moduleRef } from './links.mjs';
import { evalNode } from './evaluate.mjs';
import { objectValues } from './evaluate-items.mjs';

/** The parts of import.meta that name the module's own file. */
const IMPORT_META = new Map([
  ['url', (node) => [urlv(pathToFileURL(node.file).href)]],
  ['dirname', (node) => [str(dirname(node.file))]],
  ['filename', (node) => [str(node.file)]],
]);

function importMetaValue(node) {
  const prop = node.property.name;
  const read = IMPORT_META.get(prop);
  return read ? read(node) : [unk(`import.meta.${prop} is not a file location`)];
}

/** The property names `a.b` or `a[k]` may read, or null when they are not known. */
function memberKeys(node, ctx) {
  if (!node.computed) return [node.property.name];
  const evaluated = evalNode(node.property, ctx);
  return evaluated.length > 0 && evaluated.every((v) => v.k === 'str') ? evaluated.map((v) => v.v) : null;
}

/** Item positions written as numbers (list[0]), or null. */
const numericIndexes = (keys) => (keys?.every((k) => /^\d+$/.test(k)) ? keys.map(Number) : null);

/** What reading the property `keys` of one value of the object gives. */
function memberValues(object, keys, ctx) {
  if (object.k === 'obj') return objectValues(object.node, (name) => keys === null || keys.includes(name), ctx);
  if (object.k === 'arr') {
    const indexes = numericIndexes(keys);
    return indexes ? indexes.flatMap((i) => object.items[i] ?? []) : itemsOf(object);
  }
  if (object.k === 'unk' || object.k === 'name') return [object];
  if ((object.k === 'url' || passesThrough(object)) && keys?.length === 1 && keys[0] === 'href') return [object];
  return [unk(`it reads a property of ${inWords(object)}`)];
}

export function evalMember(node, ctx) {
  if (node.object.type === 'MetaProperty') return importMetaValue(node);
  const ref = moduleRef(ctx.an, node);
  if (ref?.mod === 'path' && ref.name === 'sep') return [str(sep)];
  const keys = memberKeys(node, ctx);
  const out = [];
  for (const object of evalNode(node.object, ctx)) out.push(...memberValues(object, keys, ctx));
  return uniq(out);
}

/** new URL(text): a file URL, or something outside the repository (an https address). */
function absoluteUrl(v) {
  if (v.k !== 'str') return unk('new URL of a value that is not known');
  try {
    return v.v.startsWith('file:') ? urlv(new URL(v.v).href) : EXT;
  } catch {
    return unk('new URL could not make a URL from it');
  }
}

/** new URL(t, b) for one value of each, when the base is a URL. */
function urlAgainst(t, b) {
  if (t.k === 'str' || t.k === 'pre') {
    try {
      return urlv(new URL(t.v, b.href).href, b.wild || t.k === 'pre', b.why ?? t.why ?? null);
    } catch {
      return unk('new URL could not make a URL from it');
    }
  }
  // a name from a listing is one path segment: somewhere in the folder of the base
  if (t.k === 'name') return urlv(new URL('./', b.href).href, true, b.why);
  return t.k === 'unk' ? t : unk('new URL of a value that is not known');
}

/** new URL(target, base): each target against each base that is a URL. */
function urlsFromBase(target, base, ctx) {
  const out = [];
  for (const b of evalNode(base, ctx)) {
    if (b.k !== 'url') {
      out.push(b.k === 'unk' ? b : EXT);
      continue;
    }
    for (const t of evalNode(target, ctx)) out.push(urlAgainst(t, b));
  }
  return uniq(out);
}

/** new Set(list) holds the same items. */
function newSet(node, ctx) {
  if (!node.arguments[0]) return [arr([])];
  return uniq(evalNode(node.arguments[0], ctx).map((v) => (v.k === 'arr' || v.k === 'unk' ? v : unk('new Set of something that is not a list'))));
}

export function evalNew(node, ctx) {
  const ref = moduleRef(ctx.an, node.callee);
  if (ref?.mod === 'global' && ref.name === 'Set') return newSet(node, ctx);
  if (!ref || ref.mod !== 'url' || ref.name !== 'URL') return [unk(`it makes a new ${node.callee.name ?? 'object'}`)];
  const [target, base] = node.arguments;
  if (!target) return [unk('new URL has no argument')];
  return base ? urlsFromBase(target, base, ctx) : uniq(evalNode(target, ctx).map(absoluteUrl));
}
