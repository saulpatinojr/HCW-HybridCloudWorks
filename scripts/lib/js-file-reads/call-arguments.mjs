/** What a call passes: the values of its arguments, position by position, with spreads (...) followed. */
import { MAX_ALTERNATIVES, TOO_MANY, arr, unk } from './values.mjs';
import { evalNode } from './evaluate.mjs';

/** What `call` gives parameter `param` (at `index`), when a spread in the call starts at `spreadAt` (-1 for none). */
function suppliedValues(param, call, { index, spreadAt }, ctx) {
  if (spreadAt !== -1 && index >= spreadAt) return [unk('a call passes its arguments with ... (spread)')];
  if (param.rest) return [arr(call.arguments.slice(index).map((a) => evalNode(a, ctx)))];
  const supplied = call.arguments[index] ? evalNode(call.arguments[index], ctx) : [];
  const defaults = supplied.length === 0 ? param.defaults.flatMap((d) => evalNode(d, { ...ctx, frame: null })) : [];
  return [...supplied, ...defaults];
}

/** The values a call gives each parameter of `fn`, on top of the values already given further up. */
export function callFrame(fn, call, ctx) {
  const frame = new Map(ctx.frame ?? []);
  const spreadAt = call.arguments.findIndex((a) => a.type === 'SpreadElement');
  for (const [index, param] of (fn.$params ?? []).entries()) {
    if (param) frame.set(param, suppliedValues(param, call, { index, spreadAt }, ctx));
  }
  return frame;
}

/** The variants of the argument lists so far, each with the positions one spread value adds. */
function spreadVariants(variants, spread, ctx) {
  const next = [];
  for (const v of evalNode(spread.argument, ctx)) {
    const positions = v.k === 'arr' ? v.items : [[v.k === 'unk' ? v : unk('it spreads a value that is not a list (array)')]];
    for (const variant of variants) next.push([...variant, ...positions]);
  }
  return next;
}

/** The argument lists a call may have: one list of values per position, one variant per way a spread can go. */
export function argumentVariants(call, ctx) {
  let variants = [[]];
  for (const a of call.arguments) {
    let next;
    if (a.type === 'SpreadElement') {
      next = spreadVariants(variants, a, ctx);
    } else {
      const alternatives = evalNode(a, ctx);
      next = variants.map((variant) => [...variant, alternatives]);
    }
    variants = next.length > MAX_ALTERNATIVES ? [[...variants[0], [unk(TOO_MANY)]]] : next;
  }
  return variants;
}
