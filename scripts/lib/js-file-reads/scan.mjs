/** Goes over every node of the modules to report and records each place that reads files (see report.mjs). */
import { normalizeModule } from './values.mjs';
import { requiredModule } from './declarations.mjs';
import { isValueReference } from './uses.mjs';
import { moduleRef } from './links.mjs';
import { runsInTests } from './analysis.mjs';
import { addProblem, addReference, baseIsFileUrl, importClassifier } from './report.mjs';
import { FILE_LOOKING_NAMES, READ_FUNCTIONS, calledName } from './file-functions.mjs';
import { SKIP_NODE, checkCall } from './scan-calls.mjs';

function checkImportExpression(an, module, node) {
  const place = { module, where: node, primitive: 'import()' };
  if (node.source.type !== 'Literal' && runsInTests(an, node)) {
    addReference(an, place, node.source, { classifier: importClassifier(an, module.file) });
  } else if (node.source.type === 'Literal' && normalizeModule(String(node.source.value)) === 'fs' && node.parent.type !== 'AwaitExpression' && runsInTests(an, node)) {
    addProblem(an, place, 'the fs module is imported without await, so what is done with it cannot be followed');
  }
}

function checkNewUrl(an, module, node) {
  if (node.arguments.length < 2) return;
  // new URL(path, <a file URL>) names a file next to the module (or in a folder). It may only be
  // an import, so an unknown path here is not a problem unless an fs call receives it.
  const ref = moduleRef(an, node.callee);
  if (ref?.mod === 'url' && ref.name === 'URL' && runsInTests(an, node) && baseIsFileUrl(an, node.arguments[1])) {
    addReference(an, { module, where: node, primitive: 'new URL' }, node, { standalone: true });
  }
}

/** The checks for calls, import() and new, by kind of node. */
const EXPRESSION_CHECKS = new Map([
  ['CallExpression', checkCall],
  ['ImportExpression', checkImportExpression],
  ['NewExpression', checkNewUrl],
]);

/** A listed name taken from something the guard cannot trace to Node's fs and not called there: const r = io.readFileSync */
function checkFileLookingMember(an, module, node) {
  if (node.type !== 'MemberExpression') return;
  const parent = node.parent;
  const isCallee = parent.type === 'CallExpression' && parent.callee === node;
  const isAssigned = parent.type === 'AssignmentExpression' && parent.left === node;
  const name = calledName(node);
  if (!FILE_LOOKING_NAMES.has(name) || isCallee || isAssigned) return;
  if (moduleRef(an, node)?.mod !== 'fs' && runsInTests(an, node)) {
    addProblem(an, { module, where: node, primitive: name }, `${name} is taken from something the guard cannot trace to Node's fs and is not called there, so the paths it reads are unknown`);
  }
}

/** `const { a } = x`, with a value on the right. */
const isDestructuring = (node) => node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init;

/** const { readFileSync } = io */
function checkDestructuredRead(an, module, node) {
  if (!isDestructuring(node) || requiredModule(node.init) !== null || moduleRef(an, node.init)?.mod === 'fs') return;
  const listed = node.id.properties.filter((p) => p.type === 'Property' && !p.computed).map((p) => p.key.name ?? p.key.value).filter((name) => FILE_LOOKING_NAMES.has(name));
  if (listed.length > 0 && runsInTests(an, node)) {
    addProblem(an, { module, where: node, primitive: listed[0] }, `${listed.join(', ')} is taken out of something the guard cannot trace to Node's fs, so the paths it reads are unknown`);
  }
}

/** `x.name` or `x['name']`: a property with its name written out. */
const namesStaticProperty = (member) => !member.computed || (member.property.type === 'Literal' && typeof member.property.value === 'string');
const isMemberOf = (parent, node) => parent.type === 'MemberExpression' && parent.object === node && namesStaticProperty(parent);

/** const fs = require('node:fs'), or export default fs. */
const isDeclaredFs = (parent, node) => (parent.type === 'VariableDeclarator' && parent.init === node && requiredModule(node) !== null) || parent.type === 'ExportDefaultDeclaration';

/** Kinds of node, other than a plain name, that may stand for the fs module or one of its functions. */
const FS_VALUE_TYPES = new Set(['MemberExpression', 'CallExpression', 'AwaitExpression']);

/** A file function handed around, or the fs module stored or looked up by name, hides the paths read through it. */
function checkFsValue(an, module, node) {
  const mayNameFs = node.type === 'Identifier' ? isValueReference(node) : FS_VALUE_TYPES.has(node.type);
  if (!mayNameFs) return;
  const ref = moduleRef(an, node);
  if (ref?.mod !== 'fs') return;
  const parent = node.parent;
  if (ref.name !== null && READ_FUNCTIONS.has(ref.name)) {
    const isCallee = parent.type === 'CallExpression' && parent.callee === node;
    if (!isCallee && runsInTests(an, node)) {
      addProblem(an, { module, where: node, primitive: ref.name }, `${ref.name} is handed to other code instead of being called directly, so the paths it reads cannot be followed`);
    }
  } else if (ref.name === null && !isMemberOf(parent, node) && !isDeclaredFs(parent, node) && runsInTests(an, node)) {
    // export default fs is followed where the default export is imported (originOf), so it is not a problem here
    addProblem(an, { module, where: node, primitive: 'fs' }, 'the fs module is stored, passed on or looked up by a name worked out at run time, so the files read through it are unknown');
  }
}

function scanNode(an, module, node) {
  const check = EXPRESSION_CHECKS.get(node.type);
  if (check?.(an, module, node) === SKIP_NODE) return;
  checkFileLookingMember(an, module, node);
  checkDestructuredRead(an, module, node);
  checkFsValue(an, module, node);
}

/** Records every place in the modules to report that reads files. */
export function scanModules(an) {
  for (const module of an.loaded.values()) {
    if (!an.reportIn(module.file)) continue;
    for (const node of module.nodes) scanNode(an, module, node);
  }
}
