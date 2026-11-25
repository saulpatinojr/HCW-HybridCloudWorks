/** Stepping through HCL text: over strings, heredocs and comments, and keeping count of open brackets (hcl-blocks.mjs). */

export const OPENERS = { '{': '}', '(': ')', '[': ']' };
export const CLOSERS = new Set(['}', ')', ']']);
const HEREDOC = /<<(-?)([A-Za-z_][A-Za-z0-9_]*)\r?\n/y;
/** Throw a scan error that names where in the source it happened. */
export function fail(message, offset) {
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
export function skipHeredoc(src, i) {
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
export function skipComment(src, i) {
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
