/** Who assigns to a name, who calls a function, and which functions are passed around, across all the modules. */
import { functionOf, isFunctionBinding, lookup } from './syntax.mjs';
import { isItemCallbackArgument, isMethodCallOnName, isValueReference, recordAssignment } from './uses.mjs';
import { allExportNames, exportedBinding, linkImport } from './links.mjs';

/** A namespace import (import * as m) used as anything but m.name(...) hides which of its functions run. */
function markNamespaceUse(an, id) {
  const holder = lookup(id, id.name);
  if (holder?.kind !== 'import' || holder.imported !== '*') return;
  const file = an.resolveImport(holder.source, holder.file);
  if (!file || !an.loaded.has(file)) return;
  const parent = id.parent;
  const isNamedMember = parent.type === 'MemberExpression' && parent.object === id && !parent.computed;
  if (isNamedMember && parent.parent.type === 'CallExpression' && parent.parent.callee === parent) return;
  const names = isNamedMember ? [parent.property.name] : allExportNames(an, file);
  for (const name of names) {
    const exported = exportedBinding(an, file, name);
    if (exported) exported.escapes = true;
  }
}

/** lib.f(x): a push onto a list held by a name, or a call of a function of `import * as lib from './x.mjs'`. */
function recordMethodCall(an, node) {
  const holder = lookup(node.callee.object, node.callee.object.name);
  const method = node.callee.property.name;
  if (['push', 'unshift'].includes(method)) holder?.pushes.push(node);
  // lib.f(x) where lib is `import * as lib from './x.mjs'`
  if (holder?.kind !== 'import' || holder.imported !== '*') return;
  const target = an.resolveImport(holder.source, holder.file);
  const called = target && exportedBinding(an, target, method);
  if (called) called.calls.push(node);
}

/** A function used by name as a value: a callback of a list method, an argument a helper calls, or handed elsewhere. */
function recordFunctionValue(an, node) {
  markNamespaceUse(an, node);
  const isCallee = node.parent.type === 'CallExpression' && node.parent.callee === node;
  const binding = isCallee ? null : lookup(node, node.name);
  const target = binding && linkImport(an, binding);
  if (!target || !isFunctionBinding(target)) return;
  const call = node.parent;
  const receiver = call.type === 'CallExpression' && call.callee.type === 'Identifier' ? lookup(call.callee, call.callee.name) : null;
  const receiverFn = receiver && linkImport(an, receiver);
  const receiverParam = receiverFn && functionOf(receiverFn)?.$params?.[call.arguments.indexOf(node)];
  if (isItemCallbackArgument(call, node)) target.callbackUses.push({ call });
  // helper(read): the helper's own calls of its parameter are calls of `read`
  else if (receiverParam) target.viaParams.push(receiverParam);
  else target.escapes = true;
}

export function recordUse(an, node) {
  if (node.type === 'AssignmentExpression') {
    recordAssignment(node);
  } else if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
    const binding = lookup(node.argument, node.argument.name);
    if (binding) binding.counted = true;
  } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
    const binding = lookup(node.callee, node.callee.name);
    if (binding) linkImport(an, binding).calls.push(node);
  } else if (isMethodCallOnName(node)) {
    recordMethodCall(an, node);
  } else if (node.type === 'Identifier' && isValueReference(node)) {
    recordFunctionValue(an, node);
  }
}
