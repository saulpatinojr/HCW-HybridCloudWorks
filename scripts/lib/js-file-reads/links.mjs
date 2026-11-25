/**
 * Following a name from the module that imports it to the module that declares
 * it, and from there to a Node module or a global it stands for.
 *
 * `an` is the state of one analysis (see analysis.mjs): the loaded modules and
 * the caller's `resolveImport`.
 */
import { isRelative, normalizeModule } from './values.mjs';
import { lookup } from './syntax.mjs';
import { requiredModule } from './declarations.mjs';

/** Names that need no import: what they stand for, as {mod, name}. */
const GLOBAL_REFS = {
  process: { mod: 'process', name: null },
  URL: { mod: 'url', name: 'URL' },
  Object: { mod: 'object', name: null },
  String: { mod: 'global', name: 'String' },
  Set: { mod: 'global', name: 'Set' },
};

/** The declaration that module `file` exports under `name`, following re-exports. */
export function exportedBinding(an, file, name, seen = new Set()) {
  const module = an.loaded.get(file);
  if (!module || seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const entry = module.exports.get(name);
  if (entry && !entry.from) return entry;
  const sources = entry ? [[entry.from, entry.name]] : name === 'default' ? [] : module.exports.all.map((spec) => [spec, name]);
  for (const [spec, exportedName] of sources) {
    const target = an.resolveImport(spec, file);
    const found = target && exportedBinding(an, target, exportedName, seen);
    if (found) return found;
  }
  return null;
}

/** Follows an import to the declaration in the module it comes from, when that module was scanned. */
export function linkImport(an, binding) {
  if (binding.kind !== 'import') return binding;
  const target = an.resolveImport(binding.source, binding.file);
  return (target && exportedBinding(an, target, binding.imported)) || binding;
}

/** Every name a module exports, including the ones that arrive through export * from. */
export function allExportNames(an, file, seen = new Set()) {
  const module = an.loaded.get(file);
  if (!module || seen.has(file)) return [];
  seen.add(file);
  const viaStar = module.exports.all.flatMap((spec) => {
    const target = an.resolveImport(spec, file);
    return target ? allExportNames(an, target, seen) : [];
  });
  return [...module.exports.keys(), ...viaStar];
}

/**
 * Where an imported name really comes from. A name imported from one of our own files may have been
 * re-exported from a Node module there (export { readFileSync } from 'node:fs'), and the file functions
 * must still be seen. Returns { source, imported } or null.
 */
export function originOf(an, binding, seen = new Set()) {
  if (binding.kind !== 'import') return null;
  if (!isRelative(binding.source)) return { source: binding.source, imported: binding.imported };
  const file = an.resolveImport(binding.source, binding.file);
  const key = `${file}#${binding.imported}`;
  if (!file || seen.has(key)) return null;
  seen.add(key);
  return originInModule(an, file, binding.imported, seen);
}

/** originOf, once the import has led to a scanned module: its own export, a re-export, or an export * from. */
function originInModule(an, file, imported, seen) {
  const exports = an.loaded.get(file)?.exports;
  const entry = exports?.get(imported);
  if (entry?.from) return originOf(an, { kind: 'import', source: entry.from, imported: entry.name, file }, seen);
  if (entry) return originOf(an, entry, seen);
  for (const spec of exports?.all ?? []) {
    const found = originOf(an, { kind: 'import', source: spec, imported, file }, seen);
    if (found) return found;
  }
  return null;
}

/** The module in process.getBuiltinModule('fs'), else null. */
function builtinModuleOf(node) {
  const callee = node.type === 'CallExpression' ? node.callee : null;
  if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'getBuiltinModule') return null;
  const [arg] = node.arguments;
  const onProcess = callee.object.type === 'Identifier' && callee.object.name === 'process';
  return onProcess && arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
}

/** A part of a module that is the whole of another (fs.promises, path.posix): it is followed as the module itself. */
const isWholeModule = (mod, name) => (mod === 'fs' && name === 'promises') || (mod === 'path' && (name === 'posix' || name === 'win32'));

/** require('node:fs'), await import('node:fs'), process.getBuiltinModule('fs') */
function callRef(an, node) {
  const lit = requiredModule(node) ?? builtinModuleOf(node);
  return lit === null || isRelative(lit) ? null : { mod: normalizeModule(lit), name: null };
}

/** A name: a global, or an import from a Node module (possibly through one of our own files). */
function identifierRef(an, node) {
  const binding = lookup(node, node.name);
  if (!binding) return GLOBAL_REFS[node.name] ?? null;
  const origin = originOf(an, binding);
  if (!origin || isRelative(origin.source)) return null;
  const mod = normalizeModule(origin.source);
  const whole = ['default', '*', 'promises'].includes(origin.imported) || (mod === 'path' && ['posix', 'win32'].includes(origin.imported));
  return { mod, name: whole ? null : origin.imported };
}

/** The property name in `a.b` or `a['b']`, else null. */
function memberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return null;
}

/** fs.readFileSync, path.posix.join: a function of a module that is named itself. */
function memberRef(an, node) {
  const base = moduleRef(an, node.object);
  if (!base || base.name !== null) return null;
  const name = memberName(node);
  if (name === null) return null;
  return { mod: base.mod, name: isWholeModule(base.mod, name) ? null : name };
}

const MODULE_REF_READERS = new Map([
  ['CallExpression', callRef],
  ['AwaitExpression', callRef],
  ['Identifier', identifierRef],
  ['MemberExpression', memberRef],
]);

/** What a name stands for when it is a Node module or a global: {mod, name} or null. */
export function moduleRef(an, node) {
  const reader = MODULE_REF_READERS.get(node.type);
  return reader ? reader(an, node) : null;
}
