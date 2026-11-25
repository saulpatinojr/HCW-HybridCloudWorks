/** Parsing one module: its table of names and what it exports. */
import { annotate, parse, patternIdentifiers } from './syntax.mjs';
import { DECLARERS } from './declarations.mjs';

/**
 * What a module exports: name -> its binding, or { from, name } for a
 * re-export (`export { f } from './x'`). `.all` lists the modules named by
 * `export * from`.
 */
function collectExports(program) {
  const exports = new Map();
  exports.all = [];
  const programBinding = (name) => program.$scope?.get(name);
  for (const node of program.body) EXPORT_READERS.get(node.type)?.(node, exports, programBinding);
  return exports;
}

/** What each kind of export statement adds to a module's exports. */
const EXPORT_READERS = new Map([
  ['ExportAllDeclaration', (node, exports) => exports.all.push(node.source.value)],
  [
    'ExportNamedDeclaration',
    (node, exports, programBinding) => {
      if (node.source) {
        for (const s of node.specifiers) exports.set(s.exported.name ?? s.exported.value, { from: node.source.value, name: s.local.name ?? s.local.value });
        return;
      }
      for (const [name, local] of namedExports(node)) exports.set(name, programBinding(local));
    },
  ],
  [
    'ExportDefaultDeclaration',
    (node, exports, programBinding) => {
      const d = node.declaration;
      if (d.type === 'FunctionDeclaration' && d.id) exports.set('default', programBinding(d.id.name));
      else if (d.type === 'Identifier') exports.set('default', programBinding(d.name));
    },
  ],
]);

/** The names an `export` of this module's own declarations makes, each with the local name behind it, in order. */
function namedExports(node) {
  const d = node.declaration;
  if (d?.type === 'FunctionDeclaration' || d?.type === 'ClassDeclaration') return [[d.id.name, d.id.name]];
  if (d?.type === 'VariableDeclaration') {
    return d.declarations.flatMap((decl) => patternIdentifiers(decl.id).map((id) => [id.name, id.name]));
  }
  return node.specifiers.map((s) => [s.exported.name ?? s.exported.value, s.local.name]);
}

/**
 * Parses one module and records its names. Throws if the text cannot be parsed. `handed` is the syntax tree of the
 * text when the caller has parsed it already (`listImports` does).
 *
 * The analysis writes onto the tree it works on: the names declared in each scope, the values each name was set
 * to, the function each parameter belongs to. A tree that has been through here once is therefore no use for a
 * second analysis (a name set once would look as if it were set twice, and what a module reads would change), so a
 * tree that is already marked is not used and the text is parsed again.
 */
export function loadModule(file, text, handed) {
  const ast = handed && !handed.$analysed ? handed : parse(text);
  ast.$analysed = true;
  const nodes = annotate(ast, file);
  for (const node of nodes) DECLARERS.get(node.type)?.(node);
  return { file, text, ast, nodes, exports: collectExports(ast) };
}
