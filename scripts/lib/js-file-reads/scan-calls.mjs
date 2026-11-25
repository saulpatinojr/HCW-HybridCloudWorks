/**
 * The calls that read files, or hide what they read: fs.readFileSync(...),
 * import.meta.glob(...), require(...), process.chdir(...), eval(...) and a
 * function that looks like a file read but cannot be traced to Node's fs.
 */
import { FUNCTION_TYPES, lookup } from './syntax.mjs';
import { linkImport, moduleRef } from './links.mjs';
import { runsInTests } from './analysis.mjs';
import { addGlobReference, addProblem, addReference, importClassifier } from './report.mjs';
import { FILE_LOOKING_NAMES, READ_FUNCTIONS, calledName } from './file-functions.mjs';

/** A rule took the call. */
const HANDLED = 'handled';
/** A rule took the call, and the other checks of the same node are skipped too. */
export const SKIP_NODE = 'skip';

/** require(...) in any spelling: the plain name, or a function made by createRequire. */
function isRequireLike(an, callee) {
  // createRequire(import.meta.url)('../x.json')
  if (callee.type === 'CallExpression') return moduleRef(an, callee.callee)?.name === 'createRequire';
  if (callee.type !== 'Identifier') return false;
  if (callee.name === 'require') return true;
  const binding = lookup(callee, callee.name);
  return binding?.kind === 'var' && binding.inits.some((init) => init.type === 'CallExpression' && moduleRef(an, init.callee)?.name === 'createRequire');
}

/** Whether a called name is a function written in the files being scanned (not something that reads files for us). */
function isDefinedHere(an, callee) {
  if (callee.type !== 'Identifier') return false;
  const binding = lookup(callee, callee.name);
  if (!binding) return false;
  // an import of one of our own scanned files counts as written here
  const target = linkImport(an, binding);
  return target.kind === 'function' || Boolean(target.inits?.some((init) => FUNCTION_TYPES.has(init.type)));
}

/** `import.meta.glob(...)`. */
const isImportMetaGlob = (callee) => callee.type === 'MemberExpression' && callee.object.type === 'MetaProperty' && !callee.computed && callee.property.name === 'glob';

function readCall(an, module, node, ref) {
  if (ref?.mod !== 'fs' || !READ_FUNCTIONS.has(ref.name)) return undefined;
  if (!runsInTests(an, node)) return SKIP_NODE;
  const [first] = node.arguments;
  const place = { module, where: node, primitive: ref.name };
  if (first && first.type !== 'SpreadElement') addReference(an, place, first);
  else addProblem(an, place, `${ref.name} is called without a path argument the guard can read`);
  return HANDLED;
}

function globImport(an, module, node) {
  if (!isImportMetaGlob(node.callee)) return undefined;
  if (runsInTests(an, node)) addGlobReference(an, module, node);
  return HANDLED;
}

function fsGlob(an, module, node, ref) {
  if (ref?.mod !== 'fs' || (ref.name !== 'glob' && ref.name !== 'globSync') || !runsInTests(an, node)) return undefined;
  addProblem(an, { module, where: node, primitive: ref.name }, `${ref.name} reads every file that matches a pattern, which the guard does not follow`);
  return HANDLED;
}

function chdir(an, module, node, ref) {
  if (ref?.mod !== 'process' || ref.name !== 'chdir' || !runsInTests(an, node)) return undefined;
  // every relative path after this is relative to a different folder
  addProblem(an, { module, where: node, primitive: 'chdir' }, 'process.chdir changes the folder that relative paths start from, so the guard cannot tell which files later reads touch');
  return HANDLED;
}

function evalText(an, module, node) {
  const callee = node.callee;
  if (callee.type !== 'Identifier' || callee.name !== 'eval' || lookup(callee, 'eval') || !runsInTests(an, node)) return undefined;
  addProblem(an, { module, where: node, primitive: 'eval' }, 'eval runs text as code, which the guard cannot read');
  return HANDLED;
}

function fileLookingCall(an, module, node, ref) {
  const name = calledName(node.callee);
  if (!FILE_LOOKING_NAMES.has(name) || ref?.mod === 'fs' || isDefinedHere(an, node.callee) || !runsInTests(an, node)) return undefined;
  // readFileSync(...) from something the guard cannot trace to Node's fs: say so rather than ignore it
  addProblem(an, { module, where: node, primitive: name }, `${name}(...) looks like a file read, but the guard cannot tell it comes from Node's fs module, so the path it reads is unknown`);
  return HANDLED;
}

function requireCall(an, module, node) {
  const [first] = node.arguments;
  if (!isRequireLike(an, node.callee) || !first || first.type === 'SpreadElement') return undefined;
  // a plain package name is not a file in the repository
  const isPackageName = first.type === 'Literal' && !String(first.value).startsWith('.');
  if (!isPackageName && runsInTests(an, node)) addReference(an, { module, where: node, primitive: 'require' }, first, { classifier: importClassifier(an, module.file) });
  return HANDLED;
}

/** The rules for a call, in order; the first that takes it wins. */
const CALL_RULES = [readCall, globImport, fsGlob, chdir, evalText, fileLookingCall, requireCall];

/** Checks one call. Returns SKIP_NODE when the node's other checks are to be skipped. */
export function checkCall(an, module, node) {
  const ref = moduleRef(an, node.callee);
  for (const rule of CALL_RULES) {
    const outcome = rule(an, module, node, ref);
    if (outcome) return outcome;
  }
  return undefined;
}
