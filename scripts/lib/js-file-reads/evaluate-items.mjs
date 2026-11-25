/** The parts of a value: the properties of an object, the items of a list a loop or a list method goes over. */
import { itemsOf, str, uniq, unk } from './values.mjs';
import { evalNode } from './evaluate.mjs';

/** The values of the properties of an object literal whose name passes `wanted`, and why others could not be read. */
export function objectValues(objectNode, wanted, ctx) {
  const out = [];
  for (const p of objectNode.properties) {
    if (p.type === 'SpreadElement') out.push(unk('it is taken from an object that spreads another object'));
    else if (p.computed) out.push(unk('it is taken from an object that has a key written in [ ]'));
    else if (wanted(String(p.key.name ?? p.key.value))) out.push(...evalNode(p.value, ctx));
  }
  return out;
}

/** The keys of a plain object, for a for...in loop over it. */
function objectKeys(s) {
  if (s.k === 'obj' && s.node.properties.every((p) => p.type === 'Property' && !p.computed)) {
    return s.node.properties.map((p) => str(String(p.key.name ?? p.key.value)));
  }
  return [unk('a for...in loop over something that is not a plain object')];
}

/** What a loop's name is set to on each turn: the keys (for...in) or the items (for...of). */
export function loopValues(loop, ctx) {
  const sources = evalNode(loop.iterable, ctx);
  if (loop.kind === 'in') return uniq(sources.flatMap(objectKeys));
  return uniq(sources.flatMap((s) => (s.k === 'arr' ? itemsOf(s) : [s.k === 'unk' ? s : unk('a loop over a value that is not a list (array)')])));
}

/** The items a callback receives from `list.map(callback)` and the like. */
export function itemValues(call, ctx) {
  return uniq(evalNode(call.callee.object, ctx).flatMap((v) => (v.k === 'arr' ? itemsOf(v) : [v.k === 'unk' ? v : unk('a function run over the items of a value that is not a list (array)')])));
}
