/** Which comment lines sit beside a pin in a lab file: the lines directly above it, or the whole file for some (lab-pin-comments.mjs). */
import { CADDY_TEST_PATH, escapeRe } from './lab-pin-constants.mjs';
import { setYamlScalar } from './lab-pin-edits.mjs';

/** Files whose whole set of comments counts as beside the pin, not only the lines directly above it. */
const WHOLE_FILE = [CADDY_TEST_PATH];
const isComment = (line) => /^\s*#/.test(line);

/** Where one pin sits in one file: its 1-based line and its value. Throws when it is not exactly one line. */
export function locate(file, text, where) {
  if (/\.ya?ml$/.test(file)) {
    // setYamlScalar finds the key by path and refuses a key that is missing or
    // appears twice; its edit is thrown away, only the line and old value are used.
    const { line, from } = setYamlScalar(text, where.split('.'), 'x');
    return { line, value: from };
  }
  const pattern = file.endsWith('.json')
    ? new RegExp(`^\\s*"${escapeRe(where)}"\\s*:\\s*"?([^",]*)"?,?\\s*$`)
    : new RegExp(`^${escapeRe(where)}=['"]?([^'"\\s#]*)['"]?(?:\\s+#.*)?$`);
  const hits = text
    .split(/\r?\n/)
    .map((l, i) => [i, l.match(pattern)])
    .filter(([, m]) => m);
  if (hits.length !== 1) throw new Error(`${file}: expected one \`${where}\` line, found ${hits.length}`);
  return { line: hits[0][0] + 1, value: hits[0][1][1] };
}

/** The comment lines beside the pin on 1-based line `line`: `{ line, text }` each. */
export function commentsBeside(file, lines, line) {
  const at = line - 1;
  const found = [];
  if (file.endsWith('.json')) {
    // JSON has no comments; this fixture keeps its words in `$comment`.
    lines.forEach((l, i) => {
      const m = l.match(/^\s*"\$comment"\s*:\s*"(.*)",?\s*$/);
      if (m) found.push({ line: i + 1, text: m[1] });
    });
    return found;
  }
  if (WHOLE_FILE.includes(file)) {
    lines.forEach((l, i) => {
      if (isComment(l)) found.push({ line: i + 1, text: l });
    });
  } else {
    // Up through the pin's own group of lines, then the unbroken run of comments above it.
    let top = at;
    while (top > 0 && lines[top - 1].trim() !== '' && !isComment(lines[top - 1])) top -= 1;
    for (let i = top - 1; i >= 0 && isComment(lines[i]); i -= 1) found.unshift({ line: i + 1, text: lines[i] });
  }
  const inline = lines[at].match(/\s#\s?(.*)$/);
  if (inline) found.push({ line, text: inline[1] });
  return found;
}
