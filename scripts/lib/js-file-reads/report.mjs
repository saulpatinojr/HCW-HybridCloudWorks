/**
 * Writing down a place that reads files: the files and folders its path can
 * name, and why the guard could not tell, when it could not.
 *
 * A place is `{ module, where, primitive }`: the module it is in, the node to
 * quote, and the function (or kind of code) that reads.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { endsWithSeparator, fileUrlToPathSafe, inWords, unk } from './values.mjs';
import { evalNode, freshContext } from './evaluate.mjs';

const sourceOf = (module, node) => module.text.slice(node.range[0], node.range[1]).replace(/\s+/g, ' ');

function classifyUrl(value) {
  const p = fileUrlToPathSafe(value.href);
  if (p === null) return { unresolved: 'it is a URL that is not a file path' };
  return value.wild ? { dir: endsWithSeparator(p) ? p : dirname(p), unresolved: value.why ?? undefined } : { file: p };
}

function classifyStart(value, cwd) {
  const p = isAbsolute(value.v) ? value.v : resolve(cwd, value.v);
  return { dir: endsWithSeparator(value.v) ? p : dirname(p), unresolved: value.why ?? undefined };
}

/** What each kind of value means as the path a file function reads. A kind not here is not a path. */
const CLASSIFIERS = new Map([
  ['str', (value, cwd) => ({ file: isAbsolute(value.v) ? value.v : resolve(cwd, value.v) })],
  ['url', classifyUrl],
  ['pre', classifyStart],
  ['tmp', () => ({})],
  ['ext', () => ({})],
  ['name', () => ({ unresolved: 'it is a file name from a folder listing, used without its folder' })],
  ['unk', (value) => ({ unresolved: value.why })],
]);

export function classify(value, cwd) {
  const classifier = CLASSIFIERS.get(value.k);
  return classifier ? classifier(value, cwd) : { unresolved: `it is ${inWords(value)}, not a path` };
}

/** A module path written out: a file URL, a path relative to the module (or absolute), or a package name. */
function classifyImportText(an, text, here) {
  const spec = text.replace(/[?#].*$/, '');
  if (/^(?:data|https?|node):/.test(spec)) return {};
  if (spec.startsWith('file:')) {
    const p = fileUrlToPathSafe(spec);
    return p === null ? { unresolved: 'it is a URL that is not a file path' } : { file: p };
  }
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const written = isAbsolute(spec) ? spec : resolve(here, spec);
    return { file: an.probeFile(written) ?? written };
  }
  return {};
}

/** A module path of which only the start is known. */
function classifyImportStart(value, here) {
  if (/^(?:data|https?|node):/.test(value.v)) return {};
  const startsLikeAPath = value.v.startsWith('.') || isAbsolute(value.v);
  if (!startsLikeAPath) return value.why ? { unresolved: value.why } : {};
  const p = resolve(here, value.v);
  return { dir: endsWithSeparator(value.v) ? p : dirname(p), unresolved: value.why ?? undefined };
}

/** A module path (import(...), require(...)) is relative to the file it is written in; a bare name is a package. */
export const importClassifier = (an, file) => (value) => {
  const here = dirname(file);
  if (value.k === 'str') return classifyImportText(an, value.v, here);
  if (value.k === 'pre') return classifyImportStart(value, here);
  return classify(value, an.cwd);
};

/**
 * Whether the base of a `new URL(path, base)` is a file URL. A base too deep to evaluate is treated as an
 * unknown base, which is not a file URL. Nothing is lost by that: a file function or an import() that
 * receives the URL evaluates it again in addReference, which reports a value it cannot follow.
 */
export function baseIsFileUrl(an, baseNode) {
  try {
    return evalNode(baseNode, freshContext(an)).some((b) => b.k === 'url');
  } catch {
    return false;
  }
}

/** The values the path at `valueNode` may have, or one unknown value when working them out fails. */
function pathValues(an, valueNode) {
  try {
    return evalNode(valueNode, freshContext(an));
  } catch (error) {
    return [unk(`it is too complicated for the guard to follow (${error.name})`)];
  }
}

function pushReference(an, { module, where, primitive }, results, unresolved) {
  an.references.push({ file: module.file, line: where.loc.start.line, expression: sourceOf(module, where), primitive, results, unresolved });
}

/** Records a place that reads the path `valueNode`. */
export function addReference(an, place, valueNode, { standalone = false, classifier = (value) => classify(value, an.cwd) } = {}) {
  const results = [];
  const unresolved = [];
  const values = pathValues(an, valueNode);
  if (values.length === 0) unresolved.push('the guard cannot find any value for the path');
  for (const value of values) {
    const c = classifier(value);
    if (c.file) results.push({ kind: 'file', path: c.file });
    if (c.dir) results.push({ kind: 'dir', path: c.dir });
    if (c.unresolved && !standalone) unresolved.push(c.unresolved);
  }
  if (standalone && results.length === 0) return;
  pushReference(an, place, results, [...new Set(unresolved)]);
}

export function addProblem(an, place, reason) {
  pushReference(an, place, [], [reason]);
}

/** import.meta.glob('../x/*.md'): every file in the folder before the first * or ?. */
export function addGlobReference(an, module, node) {
  const place = { module, where: node, primitive: 'import.meta.glob' };
  const [patternNode] = node.arguments;
  const patterns = patternNode?.type === 'ArrayExpression' ? patternNode.elements : [patternNode];
  if (!patterns.every((p) => p?.type === 'Literal' && typeof p.value === 'string')) {
    addProblem(an, place, 'import.meta.glob is given a pattern that is not plain text');
    return;
  }
  const results = [];
  for (const { value } of patterns) {
    if (value.startsWith('!')) continue;
    const prefix = value.split(/[*?[{(]/)[0];
    const base = value.startsWith('/') ? join(an.cwd, prefix) : resolve(dirname(module.file), prefix);
    results.push({ kind: 'dir', path: endsWithSeparator(prefix) ? base : dirname(base) });
  }
  pushReference(an, place, results, []);
}
