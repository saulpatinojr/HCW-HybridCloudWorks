/** What a name holds: where it starts, plus everything later code sets it to. */
import { sep } from 'node:path';
import { MAX_ROUNDS, NAME, arr, inWords, keyOf, normalizeModule, positionsOf, sameOrFewer, str, uniq, unk } from './values.mjs';
import { linkImport } from './links.mjs';
import { evalNode } from './evaluate.mjs';
import { evalParam } from './evaluate-params.mjs';
import { loopValues, objectValues } from './evaluate-items.mjs';

/**
 * How many rounds a name gets. A name set again inside a loop gets three and is
 * reported if it still changes, so a climb up the folders (d = dirname(d)) gives
 * the same answer however deep the checkout is. A name set again in a straight
 * line gets one round per step and is not reported.
 */
function roundsFor(binding) {
  if (binding.loopAssigned) return { rounds: 3, straightLine: false };
  if (binding.assigns.length > 0) return { rounds: binding.assigns.length + 1, straightLine: true };
  return { rounds: MAX_ROUNDS, straightLine: false };
}

/** The items added to an array by name.push(...) and name.unshift(...). */
function pushedItems(binding, ctx) {
  return binding.pushes.flatMap((call) =>
    call.arguments.flatMap((a) => {
      if (a.type !== 'SpreadElement') return [evalNode(a, ctx)];
      return evalNode(a.argument, ctx).flatMap((v) => positionsOf(v, 'items added with a spread of something that is not a list (array)'));
    })
  );
}

const positionKey = (alternatives) => alternatives.map(keyOf).sort().join('|');

/** A list value with the pushed positions it does not hold yet added at its end. */
function withAddedPositions(v, added) {
  if (v.k !== 'arr') return v;
  const have = new Set(v.items.map(positionKey));
  const fresh = [];
  for (const position of added) {
    const key = positionKey(position);
    if (!have.has(key)) fresh.push(position);
    have.add(key);
  }
  return arr([...v.items, ...fresh]);
}

function withPushes(binding, values, ctx) {
  if (binding.pushes.length === 0) return values;
  const added = pushedItems(binding, ctx);
  return uniq(values.map((v) => withAddedPositions(v, added)));
}

/** What later code adds to a name: assignments, counters, other changes, pushes. */
function withLater(binding, values, ctx) {
  const out = [...values];
  for (const rhs of binding.assigns) out.push(...evalNode(rhs, ctx));
  if (binding.counted) out.push(NAME);
  if (binding.tainted) out.push(unk(`\`${binding.name}\` is changed in a way the guard does not follow (+=, ++ and the like)`));
  if (binding.mutated) out.push(unk(`\`${binding.name}\` has an item or property set after it is made`));
  return withPushes(binding, uniq(out), ctx);
}

/** `let x = ...` and `for (const x of list)`: what it is set to where it is declared. */
function varValues(binding, ctx) {
  const out = binding.loop ? loopValues(binding.loop, ctx) : binding.inits.flatMap((init) => evalNode(init, ctx));
  if (!binding.loop && binding.inits.length === 0 && binding.assigns.length === 0) out.push(unk(`\`${binding.name}\` is declared but never given a value`));
  return out;
}

/** Where a destructured name is taken from: another name, each item of a loop, or what it is set to. */
function partSources(binding, ctx) {
  if (binding.owner) return evalBinding(binding.owner, ctx);
  if (binding.loopOver) return loopValues({ kind: 'of', iterable: binding.loopOver }, ctx);
  return evalNode(binding.init, ctx);
}

/** Item `index` of a list value. */
const itemAt = (s, index) => (s.k === 'arr' ? (s.items[index] ?? []) : [s.k === 'unk' ? s : unk(`item ${index + 1} is taken out of ${inWords(s)}`)]);

/** const { a } = x and const [a] = x (in a loop too): the part of each value it is taken from, or its default. */
function partValues(binding, ctx) {
  const sources = partSources(binding, ctx);
  const byIndex = binding.index !== null && binding.index !== undefined;
  const out = byIndex ? sources.flatMap((s) => itemAt(s, binding.index)) : sources.flatMap((s) => pickProperty(s, binding.key, ctx));
  if (out.length === 0) out.push(...binding.defaults.flatMap((d) => evalNode(d, ctx)));
  return out;
}

function importValues(binding, ctx) {
  const target = linkImport(ctx.an, binding);
  if (target !== binding) return evalBinding(target, { ...ctx, frame: null });
  if (normalizeModule(binding.source) === 'path' && binding.imported === 'sep') return [str(sep)];
  return [unk(`\`${binding.name}\` is imported from ${binding.source}, which is not scanned`)];
}

/** How each kind of name is worked out. A kind not here is one the guard does not follow. */
const BINDING_READERS = new Map([
  ['var', (binding, ctx) => withLater(binding, varValues(binding, ctx), ctx)],
  ['function', (binding) => [{ k: 'fn', node: binding.fn }]],
  ['param', (binding, ctx) => withLater(binding, evalParam(binding, ctx), ctx)],
  ['part', (binding, ctx) => withLater(binding, partValues(binding, ctx), ctx)],
  ['import', importValues],
]);

/** What a name holds: where it starts, plus everything later code sets it to. */
function bindingValues(binding, ctx) {
  const read = BINDING_READERS.get(binding.kind);
  return read ? read(binding, ctx) : [unk(`\`${binding.name}\` is ${binding.why ?? 'not something the guard follows'}`)];
}

const bindingId = (an, binding) => (binding.id ??= ++an.bindingCounter);

/**
 * A name that is worked out from its own earlier value (p = join(p, 'x'), or a
 * walk that passes a folder to itself) is worked out in rounds: each round
 * starts from the best answer so far, until nothing new appears. A parameter
 * whose value the caller gave (a frame) goes through the same steps, so what
 * the function does to it afterwards is not lost.
 */
export function evalBinding(binding, ctx) {
  const framed = Boolean(ctx.frame?.has(binding));
  const key = framed ? `${bindingId(ctx.an, binding)}#${ctx.frame.get(binding).map(keyOf).join('|')}` : String(bindingId(ctx.an, binding));
  if (ctx.approx.has(key)) {
    ctx.reentered.add(key);
    return ctx.approx.get(key);
  }
  const { rounds, straightLine } = roundsFor(binding);
  let guess = [];
  for (let round = 0; round < rounds; round++) {
    const out = oneRound(binding, { key, guess, framed }, ctx);
    if (!ctx.reentered.has(key) || sameOrFewer(out, guess)) {
      ctx.reentered.delete(key);
      return uniq([...guess, ...out]);
    }
    guess = uniq([...guess, ...out]);
  }
  ctx.reentered.delete(key);
  return straightLine ? guess : uniq([...guess, unk(`\`${binding.name}\` keeps changing as it is rebuilt, so the guard stops following it`)]);
}

/** One round of evalBinding: the name's values, with `guess` standing in for the name wherever it uses itself. */
function oneRound(binding, { key, guess, framed }, ctx) {
  ctx.approx.set(key, guess);
  ctx.reentered.delete(key);
  try {
    return framed ? withLater(binding, ctx.frame.get(binding), ctx) : bindingValues(binding, ctx);
  } finally {
    ctx.approx.delete(key);
  }
}

/** The values of property `key` of an object literal value. */
function pickProperty(source, key, ctx) {
  if (source.k === 'unk') return [source];
  if (source.k === 'name') return [NAME];
  if (source.k !== 'obj') return [unk(`\`${key}\` is taken out of ${inWords(source)}`)];
  return objectValues(source.node, (name) => name === key, ctx);
}
