/**
 * Just enough of HCL's lexical structure to find where a block begins and ends,
 * and to read the attributes written directly inside it (PLAT-4, #964).
 *
 * WHY NOT THE SPLIT EVERY OTHER CHECK USES. `kql-alert-columns.test.mjs` cuts a
 * file at each `^resource "` and treats everything up to the next one as the
 * block. That is true of `observability.tf` and false of the module: a
 * `locals` or `data` block between two resources, as `lab-hybrid.tf` has, is
 * read as part of the resource above it. The alert verifier reads every `.tf`
 * file as one module, so it needs the real boundary. A brace is a boundary
 * only outside a string, a heredoc and a comment, and a string can hold an
 * interpolation that holds another string, so this tracks all four.
 *
 * WHAT IT DOES NOT DO: evaluate. Attribute values come back as their source
 * text, trimmed. `alert-declarations.mjs` evaluates the handful of shapes the
 * alert rules use and refuses the rest by name, which is the property that
 * matters: a value this cannot read must stop the check, not become `''`.
 */
import { CLOSERS, fail, OPENERS, scanCode, skipComment, skipHeredoc, skipString } from './hcl-scan.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { skipString, scanCode } from './hcl-scan.mjs';

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;

/**
 * Where the expression that starts at `i` ends: the first newline (or comment)
 * outside any bracket, string or heredoc. A heredoc consumes its own lines, and
 * a list or call that spans lines runs until its bracket closes.
 */
export function expressionEnd(src, i) {
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') return j;
    if (c === '#' || (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) return j;
    if (c === '"') {
      j = skipString(src, j);
    } else if (c === '<' && src[j + 1] === '<' && skipHeredoc(src, j) !== -1) {
      j = skipHeredoc(src, j);
    } else if (OPENERS[c]) {
      j = scanCode(src, j + 1, OPENERS[c]);
    } else if (CLOSERS.has(c)) {
      return fail(`unbalanced '${c}'`, j);
    } else {
      j += 1;
    }
  }
  return j;
}

/** Skip spaces, newlines and comments from `i`. */
function skipTrivia(src, i) {
  let j = i;
  while (j < src.length) {
    if (/\s/.test(src[j])) {
      j += 1;
      continue;
    }
    const comment = skipComment(src, j);
    if (comment === -1) return j;
    j = comment;
  }
  return j;
}

/** The identifier that starts at `i`, or null when none does. */
function readIdent(src, i) {
  IDENT.lastIndex = i;
  const m = IDENT.exec(src);
  return m ? m[0] : null;
}

/**
 * One level of HCL body: the attributes and blocks written directly in it.
 *
 * Attributes come back as `{ name -> source text }`; blocks as
 * `{ type, labels, body }`, with `body` the text between the braces. Nested
 * blocks are not descended into: call this again on a block's `body`.
 */
export function parseBody(src) {
  const attributes = new Map();
  const blocks = [];
  let j = skipTrivia(src, 0);
  while (j < src.length) {
    const name = readIdent(src, j);
    if (!name) fail(`expected an attribute or block name, found '${src[j]}'`, j);
    let k = j + name.length;
    while (src[k] === ' ' || src[k] === '\t') k += 1;
    if (src[k] === '=' && src[k + 1] !== '=') {
      const valueStart = k + 1;
      const end = expressionEnd(src, valueStart);
      attributes.set(name, src.slice(valueStart, end).trim());
      j = skipTrivia(src, end);
      continue;
    }
    const { labels, brace } = readLabels(src, k, name);
    const end = scanCode(src, brace + 1, '}');
    blocks.push({ type: name, labels, body: src.slice(brace + 1, end - 1), offset: j });
    j = skipTrivia(src, end);
  }
  return { attributes, blocks };
}

/**
 * A block's labels (`resource "a" "b" {`), read from `k` up to its opening
 * brace. Returns the labels and the index of that brace.
 */
function readLabels(src, start, name) {
  const labels = [];
  let k = start;
  while (src[k] !== '{') {
    k = skipTrivia(src, k);
    if (src[k] === '"') {
      const end = skipString(src, k);
      labels.push(src.slice(k + 1, end - 1));
      k = end;
    } else if (src[k] !== '{') {
      const label = readIdent(src, k);
      if (!label) fail(`expected '=' or '{' after '${name}'`, k);
      labels.push(label);
      k += label.length;
    }
    k = skipTrivia(src, k);
  }
  return { labels, brace: k };
}
