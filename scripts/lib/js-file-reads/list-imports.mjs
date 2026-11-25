/** The modules a file names with the path written out (see listImports). */
import { childrenOf, parse } from './syntax.mjs';

/** The methods of `vi` and `jest` that name a module, as `vi.mock('./x.js')` does. */
const MODULE_NAMING_METHODS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock', 'requireActual']);

/** A string written out in the code ('x', "x" or a template string with nothing worked out inside it), else null. */
function plainText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * The import-like words in a text, for a file that cannot be parsed (TypeScript, for one). It reads the text, so a
 * comment or a string that looks like an import is found too; for a file that parses, `listImports` uses the code.
 */
const TEXT_IMPORT = new RegExp(
  '(?:(?:import|export|from|require)\\s*(?:\\(\\s*)?|(?:vi|jest)\\s*\\.\\s*(?:' + [...MODULE_NAMING_METHODS].join('|') + ')\\s*\\(\\s*)[\'"]([^\'"\\n]+)[\'"]',
  'g'
);

/** Statements and expressions whose `source` names a module. */
const SOURCE_NODES = new Set(['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression']);

/** The module path a node names with the path written out, else null. */
function importSpecOf(node) {
  if (SOURCE_NODES.has(node.type)) return plainText(node.source);
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  const isRequire = callee.type === 'Identifier' && callee.name === 'require';
  return isRequire || isModuleNamingCall(callee) ? plainText(node.arguments[0]) : null;
}

/** `vi.mock`, `jest.requireActual` and the rest of MODULE_NAMING_METHODS. */
function isModuleNamingCall(callee) {
  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier') return false;
  return (callee.object.name === 'vi' || callee.object.name === 'jest') && MODULE_NAMING_METHODS.has(callee.property.name);
}

/**
 * The modules a file names: `import x from '...'`, `export ... from '...'`, `import('...')` and `require('...')` with
 * a path written out, and the `vi.mock('...')` family (a module a test names is one it depends on, even when it
 * replaces it). Each is `{ spec, line }`, the path as written and the line it is on, in the order they appear.
 * Paths that are worked out at run time are not here; `findFileReads` reports those.
 *
 * It reads the syntax tree, so an import inside a comment or a string (a test that writes a module to a temporary
 * folder, say) is not counted. A file that cannot be parsed is read as text instead (`parsed` is false).
 */
export function listImports(text) {
  let ast;
  try {
    ast = parse(text);
  } catch {
    return {
      parsed: false,
      ast: null,
      specs: [...text.matchAll(TEXT_IMPORT)].map((m) => ({ spec: m[1], line: text.slice(0, m.index).split('\n').length })),
    };
  }
  const found = [];
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    const spec = importSpecOf(node);
    if (spec !== null) found.push({ spec, line: node.loc.start.line, at: node.range[0] });
    for (const child of childrenOf(node)) stack.push(child);
  }
  // `ast` is handed back so that findFileReads does not parse the same text a second time
  return { parsed: true, ast, specs: found.sort((a, b) => a.at - b.at).map(({ spec, line }) => ({ spec, line })) };
}
