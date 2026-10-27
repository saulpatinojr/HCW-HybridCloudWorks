/**
 * lab-pin-comments.mjs — do the comments beside a lab host pin still agree
 * with it? (#1444)
 *
 * What went wrong. The weekly bump (`lab-pins-upstream.mjs --bump host`) moves
 * a pin's value and leaves the sentences beside it alone, on purpose: a script
 * cannot rewrite prose safely, and lab-pin-bumps.mjs says why. So a comment
 * such as "2.11.4 is the newest release" was true on the day it was written and
 * false from the first bump on, and nothing noticed until a reviewer read the
 * bot's pull request (CodeRabbit on #1423, which named three such sentences;
 * there were more).
 *
 * The rule, which is what keeps the bump from ever making a file contradict
 * itself. A comment beside a pin the bump moves names no exact version and no
 * digest. It says "the pin below", or names a release line (2.38, or 18), and it
 * keeps its dated history as dates ("read 2026-09-26"). An exact version has as
 * many dotted parts as the pin it sits beside (29.9.2 has three, 18.6 has two);
 * a release line has fewer. Both kinds of mistake are reported:
 *
 *   - the comment names a version that is not the pin's: it contradicts the
 *     pin, today;
 *   - the comment names the pin's own value: true today, and false after the
 *     next bump, so it is reported now instead of in the bot's next pull request.
 *
 * "Beside" means the comment lines directly above the pin's group of lines (the
 * lines run together with no blank line and no comment between them, so the
 * five `caddy_*` lines share the comment above `caddy_version`), and a comment
 * at the end of the pin's own line. The caddy test is one short script whose
 * header describes its pin from some lines away, so every comment in it counts.
 *
 * Which lines are the pins is not written here: a caller passes the (file, key)
 * pairs the bump edits, taken from a plan, so a new key a bumper starts to edit
 * is checked without anyone remembering to add it.
 *
 * Text only, like the bump itself: nothing here parses YAML or shell.
 */
import { coreVersion } from '../lab-pins-upstream.mjs';
import { CADDY_TEST_PATH, setYamlScalar } from './lab-pin-bumps.mjs';

/** Files whose whole set of comments counts as beside the pin, not only the lines directly above it. */
const WHOLE_FILE = [CADDY_TEST_PATH];

// A dotted version with an optional leading `v` and a tag-style tail
// (`2.11.4-builder`, `26.10.0-1nodesource1`). Not preceded by a letter, digit
// or dot, so `sha256sums` and `microsoft-2025.asc` are left alone.
const VERSION = /(?<![0-9A-Za-z.])v?(\d+(?:\.\d+)+)(?:-[0-9A-Za-z.~+]*[0-9A-Za-z])?/g;
// A run of eight or more hex digits, with `sha256:` or `sha512:` in front or not.
const DIGEST = /(?<![0-9A-Za-z])(?:sha(?:256|512):)?([0-9a-f]{8,})(?![0-9A-Za-z])/g;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isComment = (line) => /^\s*#/.test(line);

/** Where one pin sits in one file: its 1-based line and its value. Throws when it is not exactly one line. */
function locate(file, text, where) {
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
function commentsBeside(file, lines, line) {
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

/**
 * Every comment beside a pin the bump moves that names an exact version or a
 * digest. `files` maps a path to its text; `pins` is a list of `{ file, where }`
 * where `where` is a dotted YAML key path (`docker_release_pins.resolute.engine`)
 * or a `KEY` of a `KEY=value` line. Returns `[]` when every comment is clean.
 *
 * Each problem is `{ file, line, kind, token, repeats, pins }`: the comment's
 * file and line, `version` or `digest`, the text it names, whether that is the
 * pin's own value (`repeats`) or something else, and the pins it sits beside as
 * `{ file, where, line, value }`.
 */
export function pinCommentProblems(files, pins) {
  const sites = new Map();
  const seen = new Set();
  for (const { file, where } of pins) {
    if (seen.has(`${file}|${where}`)) continue;
    seen.add(`${file}|${where}`);
    if (!(file in files)) throw new Error(`${file} was not read`);
    const lines = files[file].split(/\r?\n/);
    const { line, value } = locate(file, files[file], where);
    const comments = commentsBeside(file, lines, line);
    const key = `${file}|${comments.map((c) => c.line).join(',')}`;
    const site = sites.get(key) ?? { file, comments, pins: [] };
    site.pins.push({ file, where, line, value, core: coreVersion(value) });
    sites.set(key, site);
  }

  const problems = new Map();
  // The pins a problem is about: for a version, the pins of the same length (or the one it repeats);
  // for a digest, the checksums and digests. All of the group when none fits.
  const add = (site, comment, kind, token, repeats, aboutThis) => {
    const id = `${site.file}:${comment.line}:${token}`;
    if (problems.has(id)) return;
    const about = site.pins.filter(aboutThis);
    const shown = (about.length > 0 ? about : site.pins).map(({ file, where, line, value }) => ({ file, where, line, value }));
    problems.set(id, { file: site.file, line: comment.line, kind, token, repeats, pins: shown });
  };
  for (const site of sites.values()) {
    // A checksum or digest has no version of its own to compare with. The releases
    // the bump moves have three parts (29.9.2), so that is what an exact version
    // looks like beside one (the caddy test's CADDY_SHA512 is such a pin).
    const counted = site.pins.filter((p) => p.core).map((p) => p.core.split('.').length);
    const parts = new Set(counted.length > 0 ? counted : [3]);
    for (const comment of site.comments) {
      for (const m of comment.text.matchAll(VERSION)) {
        const core = m[1];
        const length = core.split('.').length;
        if (!parts.has(length)) continue;
        const repeats = site.pins.some((p) => p.core === core);
        add(site, comment, 'version', m[0], repeats, repeats ? (p) => p.core === core : (p) => p.core?.split('.').length === length);
      }
      for (const m of comment.text.matchAll(DIGEST)) {
        if (!/\d/.test(m[1]) || !/[a-f]/.test(m[1])) continue;
        const repeats = site.pins.some((p) => p.value.includes(m[1]));
        add(site, comment, 'digest', m[0], repeats, repeats ? (p) => p.value.includes(m[1]) : (p) => !p.core);
      }
    }
  }
  return [...problems.values()];
}

/** One problem as a sentence a junior administrator can act on: file, line, what the comment names, what the pin holds. */
export function describePinCommentProblem(p) {
  const what = p.kind === 'digest' ? 'the digest' : 'the version';
  const shown = (v) => (v.length > 40 ? `${v.slice(0, 12)}...` : v);
  const listed = p.pins.slice(0, 4).map((x) => `${x.where} = ${shown(x.value)} (line ${x.line})`);
  const pins = p.pins.length > 4 ? `${listed.join('; ')}; and ${p.pins.length - 4} more` : listed.join('; ');
  const advice =
    'Write "the pin below" or name only the release line, and keep the date the value was read. ' +
    'A number with as many dotted parts as the pin counts as a version, so 26.04 beside a two-part pin such as 18.6 is flagged too. ' +
    'The rule is explained in lab-host/README.md, "Bumping a pin".';
  return p.repeats
    ? `${p.file}:${p.line} names ${what} ${p.token}, which is what the pin holds today (${pins}). The weekly bump will move the pin and leave this comment behind. ${advice}`
    : `${p.file}:${p.line} names ${what} ${p.token}, but the pin it sits beside holds something else: ${pins}. ${advice}`;
}
