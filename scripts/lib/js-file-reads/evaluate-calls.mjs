/** What a call returns: a function from the scanned files run with the call's arguments, a Node function, or a method. */
import { MAX_CALL_DEPTH, arr, keyOf, positionsOf, uniq, unk } from './values.mjs';
import { FUNCTION_TYPES, childrenOf } from './syntax.mjs';
import { moduleRef } from './links.mjs';
import { evalNode } from './evaluate.mjs';
import { evalBuiltin } from './builtins.mjs';
import { callMethod } from './methods.mjs';
import { callFrame } from './call-arguments.mjs';

/** Notes what a return or yield inside a function gives. Returns whether the code under `node` is looked at too. */
function noteExit(node, found, ctx) {
  if (node.type === 'ReturnStatement') {
    if (node.argument) found.returned.push(...evalNode(node.argument, ctx));
    return false;
  }
  if (node.type === 'YieldExpression' && node.argument) {
    // yield x adds one item; yield* list adds the items of list
    const values = evalNode(node.argument, ctx);
    found.yielded.push(...(node.delegate ? values.flatMap((v) => positionsOf(v, 'yield* of something that is not a list (array)')) : [values]));
  }
  return true;
}

export function returnValues(fn, ctx) {
  if (fn.body.type !== 'BlockStatement') return evalNode(fn.body, ctx);
  const found = { returned: [], yielded: [] };
  const stack = [fn.body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!noteExit(node, found, ctx)) continue;
    for (const child of childrenOf(node)) if (!FUNCTION_TYPES.has(child.type)) stack.push(child);
  }
  return fn.generator ? [arr(found.yielded)] : uniq(found.returned);
}

/** Works out what calling `fn` with the arguments of `call` returns. */
export function inlineCall(fn, call, ctx) {
  if (ctx.depth >= MAX_CALL_DEPTH) return [unk('functions call each other too deeply to follow')];
  const frame = callFrame(fn, call, ctx);
  // the same function with the same arguments, already being worked out, adds nothing new
  const key = `${fn.file}:${fn.range[0]}|${(fn.$params ?? []).map((param) => (param ? (frame.get(param) ?? []).map(keyOf).join('+') : '')).join(',')}`;
  if (ctx.active.has(key)) return [];
  // a function that keeps calling itself with a new argument (root(dirname(d))) gets three levels, however deep the checkout is
  const levels = ctx.nested.get(fn) ?? 0;
  if (levels >= 3) return [unk('it calls itself with an argument that keeps changing, so the guard stops following it')];
  ctx.active.add(key);
  ctx.nested.set(fn, levels + 1);
  try {
    return returnValues(fn, { ...ctx, frame, depth: ctx.depth + 1 });
  } finally {
    ctx.active.delete(key);
    ctx.nested.set(fn, levels);
  }
}

/** The function an object literal holds under `name`, written as a plain property, or null. */
function objectMethod(object, name) {
  if (object.k !== 'obj') return null;
  return object.node.properties.find((p) => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === name);
}

/** x.name(...): a function of an object literal, or a method of a string, list or require function. */
function evalMethodCall(node, ctx) {
  const callee = node.callee;
  const out = [];
  for (const object of evalNode(callee.object, ctx)) {
    const method = objectMethod(object, callee.property.name);
    if (method && FUNCTION_TYPES.has(method.value.type)) out.push(...inlineCall(method.value, node, ctx));
    else out.push(...callMethod(object, callee.property.name, node, ctx));
  }
  return uniq(out);
}

/** name(...): a function the name holds. */
function evalNamedCall(node, ctx) {
  const callee = node.callee;
  const out = [];
  for (const target of evalNode(callee, ctx)) {
    if (target.k === 'fn') out.push(...inlineCall(target.node, node, ctx));
    else out.push(target.k === 'unk' ? target : unk(`it calls \`${callee.name}\`, which is not a function the guard can follow`));
  }
  return uniq(out);
}

export function evalCall(node, ctx) {
  const callee = node.callee;
  const ref = moduleRef(ctx.an, callee);
  if (ref) return evalBuiltin(ref, node, ctx);
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return evalMethodCall(node, ctx);
  if (callee.type === 'Identifier') return evalNamedCall(node, ctx);
  return [unk('it calls something the guard cannot follow')];
}
