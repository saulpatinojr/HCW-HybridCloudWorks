/** What a parameter of a function holds: what its callers pass, or what a list method hands its callback. */
import { arr, itemsOf, uniq, unk } from './values.mjs';
import { ITEM_CALLBACK_METHODS } from './uses.mjs';
import { callsOf, isUsedAsValue, runsInTests } from './analysis.mjs';
import { evalNode } from './evaluate.mjs';
import { itemValues } from './evaluate-items.mjs';

function fnLabel(fn) {
  const name = fn.$binding?.name ?? fn.id?.name;
  return name ? `\`${name}\`` : 'a function written in place';
}

/** What one call passes for a parameter. */
function argumentValues(call, param, ctx) {
  const args = call.arguments;
  if (args.slice(0, param.index + 1).some((a) => a.type === 'SpreadElement')) return [unk('a call passes its arguments with ... (spread)')];
  if (param.rest) return [arr(args.slice(param.index).map((a) => evalNode(a, ctx)))];
  return args[param.index] ? evalNode(args[param.index], ctx) : [];
}

/** `list.map(callback)` and the other ITEM_CALLBACK_METHODS, written with a dot. */
const isItemMethod = (callee) => callee.type === 'MemberExpression' && !callee.computed && ITEM_CALLBACK_METHODS.has(callee.property.name);

/** describe.each(table)(...), it.each and test.each. */
const isEachTable = (callee) => callee.type === 'CallExpression' && callee.callee.type === 'MemberExpression' && callee.callee.property.name === 'each';

/** describe.each(table)('name', (a, b) => ...) and the same for it and test: the values of each row at the parameter's place. */
function eachRowValues(callee, param, ctx) {
  const rows = evalNode(callee.arguments[0], ctx).flatMap((v) => (v.k === 'arr' ? itemsOf(v) : [v.k === 'unk' ? v : unk('a table that is not a list (array)')]));
  return uniq(rows.flatMap((row) => (row.k === 'arr' ? (row.items[param.index] ?? []) : row.k === 'unk' || param.index === 0 ? [row] : [])));
}

/** The value of a parameter of an unnamed callback handed straight to a known method. */
function callbackValues(param, ctx) {
  const fn = param.fn;
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return null;
  const callee = call.callee;
  if (isItemMethod(callee)) {
    return param.index === 0 ? itemValues(call, ctx) : [unk(`argument ${param.index + 1} of the function given to .${callee.property.name}()`)];
  }
  // describe.each(table)('name', (a, b) => ...) and the same for it and test
  return isEachTable(callee) ? eachRowValues(callee, param, ctx) : null;
}

/** What the calls of a named function that a test runs pass for `param`, and a note when some calls are not seen. */
function valuesFromCallers(owner, param, ctx) {
  const out = [];
  for (const call of callsOf(owner)) if (runsInTests(ctx.an, call)) out.push(...argumentValues(call, param, ctx));
  for (const use of owner.callbackUses) {
    if (!runsInTests(ctx.an, use.call)) continue;
    out.push(...(param.index === 0 ? itemValues(use.call, ctx) : [unk(`argument ${param.index + 1} of the function given to .${use.call.callee.property.name}()`)]));
  }
  if (owner.escapes) out.push(unk(`${fnLabel(param.fn)} is also handed to other code instead of being called directly, so some of its calls are not seen`));
  return out;
}

export function evalParam(param, ctx) {
  const staticCtx = { ...ctx, frame: null };
  const out = [];
  for (const d of param.defaults) out.push(...evalNode(d, staticCtx));
  const owner = param.fn.$binding;
  if (owner && (callsOf(owner).length > 0 || isUsedAsValue(owner))) {
    out.push(...valuesFromCallers(owner, param, staticCtx));
  } else {
    const fromCallback = callbackValues(param, staticCtx);
    if (fromCallback) out.push(...fromCallback);
    else if (out.length === 0) out.push(unk(`\`${param.name}\` is a parameter of ${fnLabel(param.fn)}, which nothing in the scanned files calls`));
  }
  if (out.length === 0) out.push(unk(`no call from a test gives \`${param.name}\` of ${fnLabel(param.fn)} a value`));
  return uniq(out);
}
