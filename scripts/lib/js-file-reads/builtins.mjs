/** What the Node functions that build or find a path return: path.join, fileURLToPath, process.cwd and the rest. */
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT, NAME, TMP, TOO_MANY, arr, endsWithSeparator, fileUrlToPathSafe, passesThrough, pre, product, str, uniq, unk, urlv } from './values.mjs';
import { joinValues } from './path-join.mjs';
import { evalNode } from './evaluate.mjs';
import { argumentVariants } from './call-arguments.mjs';

/** The values of argument `index`, or a note that there is none the guard can read. */
function argumentAt(call, index, ctx) {
  const a = call.arguments[index];
  return a && a.type !== 'SpreadElement' ? evalNode(a, ctx) : [unk('there is no path argument')];
}

/** path.join and path.resolve over every argument list the call may have. */
function joinCall(call, ctx, isResolve) {
  const out = [];
  for (const variant of argumentVariants(call, ctx)) {
    if (variant.length === 0 || variant.some((alternatives) => alternatives.length === 0)) continue;
    const combos = product(variant);
    if (combos === null) return [unk(TOO_MANY)];
    out.push(...combos.map((combo) => joinValues(combo, isResolve, ctx.an.cwd)));
  }
  return uniq(out);
}

/** path.dirname and path.normalize. */
function pathOfOne(ref, call, ctx) {
  return uniq(
    argumentAt(call, 0, ctx).map((v) => {
      if (v.k === 'str') return str(ref.name === 'dirname' ? dirname(v.v) : join(v.v));
      return passesThrough(v) ? v : unk('dirname of a path that is not fully known');
    })
  );
}

function fileUrlToPathValue(v) {
  const href = v.k === 'url' ? v.href : v.k === 'str' && v.v.startsWith('file:') ? v.v : null;
  if (href === null) return passesThrough(v) ? v : unk('fileURLToPath of a value that is not a file URL');
  const p = fileUrlToPathSafe(href);
  if (p === null) return unk('fileURLToPath could not convert it');
  return v.k === 'url' && v.wild ? pre(p, v.why) : str(p);
}

function pathToFileUrlValue(v) {
  if (v.k === 'str') return urlv(pathToFileURL(v.v).href);
  if (v.k === 'pre') return urlv(pathToFileURL(endsWithSeparator(v.v) ? v.v : dirname(v.v)).href.replace(/\/?$/, '/'), true, v.why);
  return passesThrough(v) ? v : unk('pathToFileURL of a path that is not known');
}

/** relative(base, target) for one value of each. */
function relativeValue(f, t) {
  if (f.k !== 'str') return passesThrough(f) ? f : unk('relative from a path that is not known');
  if (t.k === 'str') return str(relative(f.v, t.v));
  if (t.k === 'pre') return pre(relative(f.v, t.v) + (endsWithSeparator(t.v) ? sep : ''));
  return passesThrough(t) ? t : unk('relative to a path that is not known');
}

/** relative(base, target): the part of target below base, which join(base, ...) puts back. */
function relativeCall(call, ctx) {
  const [from, to] = [0, 1].map((i) => argumentAt(call, i, ctx));
  return uniq(from.flatMap((f) => to.map((t) => relativeValue(f, t))));
}

/** Object.keys, Object.values or Object.entries of one value. */
function objectListing(v, which, ctx) {
  if (v.k !== 'obj') return v.k === 'unk' ? v : unk(`Object.${which} of a value that is not an object literal`);
  const items = [];
  for (const p of v.node.properties) {
    if (p.type === 'SpreadElement' || p.computed) return unk('an object that spreads another object or has a key written in [ ]');
    const name = str(String(p.key.name ?? p.key.value));
    if (which === 'keys') items.push([name]);
    else if (which === 'values') items.push(evalNode(p.value, ctx));
    else items.push([arr([[name], evalNode(p.value, ctx)])]);
  }
  return arr(items);
}

const always = (value) => () => [value];
const firstArgument = (ref, call, ctx) => argumentAt(call, 0, ctx);
const listing = (ref, call, ctx) => uniq(argumentAt(call, 0, ctx).map((v) => objectListing(v, ref.name, ctx)));

/** What each Node function returns, by `module.name`. A function not here is not followed. */
const BUILTINS = new Map([
  ['path.join', (ref, call, ctx) => joinCall(call, ctx, false)],
  ['path.resolve', (ref, call, ctx) => joinCall(call, ctx, true)],
  ['path.dirname', pathOfOne],
  ['path.normalize', pathOfOne],
  ['url.fileURLToPath', (ref, call, ctx) => uniq(argumentAt(call, 0, ctx).map(fileUrlToPathValue))],
  ['url.pathToFileURL', (ref, call, ctx) => uniq(argumentAt(call, 0, ctx).map(pathToFileUrlValue))],
  ['path.relative', (ref, call, ctx) => relativeCall(call, ctx)],
  ['process.cwd', (ref, call, ctx) => [str(ctx.an.cwd)]],
  ['os.tmpdir', always(TMP)],
  ['fs.mkdtempSync', always(TMP)],
  ['fs.mkdtemp', always(TMP)],
  ['os.homedir', always(EXT)],
  ['fs.openSync', always(EXT)],
  ['fs.open', always(EXT)],
  // the names in a folder: joined to the folder's path they name something inside it
  ['fs.readdirSync', () => [arr([[NAME]])]],
  ['fs.readdir', () => [arr([[NAME]])]],
  ['module.createRequire', () => [{ k: 'req' }]],
  ['global.String', firstArgument],
  ['object.freeze', firstArgument],
  ['object.keys', listing],
  ['object.values', listing],
  ['object.entries', listing],
]);

export function evalBuiltin(ref, call, ctx) {
  const builtin = BUILTINS.get(`${ref.mod}.${ref.name}`);
  return builtin ? builtin(ref, call, ctx) : [unk(`it is the result of ${ref.mod}${ref.name ? `.${ref.name}` : ''}, which the guard does not follow`)];
}
