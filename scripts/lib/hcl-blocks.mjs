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

const OPENERS = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(['}', ')', ']']);
const HEREDOC = /<<(-?)([A-Za-z_][A-Za-z0-9_]*)\r?\n/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;

/** Throw a scan error that names where in the source it happened. */
function fail(message, offset) {
  throw new Error(`${message} at offset ${offset}`);
}

/** Index of the end of the line holding `i` (the newline itself, or the end). */
function lineEnd(src, i) {
  const n = src.indexOf('\n', i);
  return n === -1 ? src.length : n;
}

/** Index just past the block comment whose opening slash-star is at `i`. */
function skipBlockComment(src, i) {
  const end = src.indexOf('*/', i + 2);
  if (end === -1) fail('unterminated /* comment', i);
  return end + 2;
}

/** Index just past a heredoc whose `<<` is at `i`, or -1 if `i` starts none. */
function skipHeredoc(src, i) {
  HEREDOC.lastIndex = i;
  const open = HEREDOC.exec(src);
  if (!open) return -1;
  const marker = open[2];
  let at = HEREDOC.lastIndex;
  while (at < src.length) {
    const end = lineEnd(src, at);
    if (src.slice(at, end).trim() === marker) return end;
    at = end + 1;
  }
  return fail(`unterminated heredoc <<${marker}`, i);
}

/** Whether a comment starts at `i`, and if so the index just past it. */
function skipComment(src, i) {
  const c = src[i];
  if (c === '#' || (c === '/' && src[i + 1] === '/')) return lineEnd(src, i);
  if (c === '/' && src[i + 1] === '*') return skipBlockComment(src, i);
  return -1;
}

/**
 * Index just past the quoted string whose opening `"` is at `i`. An
 * interpolation (`${…}`) or directive (`%{…}`) inside it is code, so it is
 * scanned as code and may hold strings of its own; `$${` and `%%{` are the
 * escapes for a literal one.
 */
export function skipString(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
    } else if (c === '"') {
      return j + 1;
    } else if ((c === '$' || c === '%') && src[j + 1] === c && src[j + 2] === '{') {
      j += 3;
    } else if ((c === '$' || c === '%') && src[j + 1] === '{') {
      j = scanCode(src, j + 2, '}');
    } else if (c === '\n') {
      return fail('newline inside a quoted string', i);
    } else {
      j += 1;
    }
  }
  return fail('unterminated string', i);
}

/**
 * Scan code from `start` until the bracket that closes `closer`, and return
 * the index just past it. Strings, heredocs and comments are skipped whole, so
 * a brace inside any of them is not counted.
 */
export function scanCode(src, start, closer) {
  const stack = [closer];
  let j = start;
  while (j < src.length) {
    const skipped = skipOpaque(src, j);
    if (skipped !== -1) {
      j = skipped;
      continue;
    }
    if (trackBracket(src, j, stack)) return j + 1;
    j += 1;
  }
  return fail(`unterminated block: no '${closer}'`, start);
}

/** Index just past a comment, string or heredoc that starts at `i`, or -1 if none does. */
function skipOpaque(src, i) {
  const comment = skipComment(src, i);
  if (comment !== -1) return comment;
  if (src[i] === '"') return skipString(src, i);
  if (src[i] === '<' && src[i + 1] === '<') return skipHeredoc(src, i);
  return -1;
}

/**
 * Push an opening bracket at `i` onto `stack`, or match a closing one against
 * it. Returns true when that closed the last bracket on the stack.
 */
function trackBracket(src, i, stack) {
  const c = src[i];
  if (OPENERS[c]) {
    stack.push(OPENERS[c]);
    return false;
  }
  if (!CLOSERS.has(c)) return false;
  const want = stack.pop();
  if (c !== want) fail(`expected '${want}' but found '${c}'`, i);
  return stack.length === 0;
}

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
