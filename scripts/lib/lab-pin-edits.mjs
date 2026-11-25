/** The text edits a lab pin bump makes, each to exactly one match or refused, and applying a plan (see lab-pin-bumps.mjs). */
import { escapeRe, GROUP_VARS_PATH } from './lab-pin-constants.mjs';

// ── Text edits (exactly one match, or refuse) ──────────────────────────────

const blank = (line) => /^\s*(#.*)?$/.test(line);
const indentOf = (line) => line.match(/^ */)[0].length;

/**
 * Set the scalar at a key path in a YAML file by editing its one line, so the
 * comments and layout around it survive. Each key must occur exactly once at
 * its level; the value keeps the quoting it had.
 */
/** The one line in [start, end) that holds `key:` at the shallowest indentation there. */
function findKey(lines, [start, end], key, where) {
  const levels = lines.slice(start, end).filter((l) => !blank(l)).map(indentOf);
  if (levels.length === 0) throw new Error(`${where}: nothing under the parent of \`${key}\``);
  const level = Math.min(...levels);
  const re = new RegExp(`^ {${level}}${escapeRe(key)}:(\\s|$)`);
  const hits = [];
  for (let i = start; i < end; i += 1) if (re.test(lines[i])) hits.push(i);
  if (hits.length !== 1) throw new Error(`${where}: expected one \`${key}:\` at its level, found ${hits.length}`);
  return { at: hits[0], level };
}

/** The lines nested under the key on line `at`, as a [start, end) range. */
function childrenOf(lines, at, level) {
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (blank(lines[i])) continue;
    if (indentOf(lines[i]) <= level) break;
    end = i + 1;
  }
  return [at + 1, end];
}

export function setYamlScalar(text, path, value) {
  const lines = String(text).split('\n');
  const where = path.join('.');
  let range = [0, lines.length];
  let at = -1;
  for (const key of path) {
    const found = findKey(lines, range, key, where);
    at = found.at;
    range = childrenOf(lines, at, found.level);
  }
  const m = lines[at].match(/^( *[^:#]+:[ \t]*)("?)([^"#\n]*?)("?)([ \t]+#.*)?$/);
  if (!m || !m[3]) throw new Error(`${path.join('.')}: line ${at + 1} is not a scalar on one line`);
  const from = m[3].trim();
  lines[at] = `${m[1]}${m[2]}${value}${m[4]}${m[5] ?? ''}`;
  return { text: lines.join('\n'), from, line: at + 1 };
}

/** Set `KEY=value` in a shell-assignment file (versions.env); exactly one line. */
export function setEnvValue(text, key, value) {
  const re = new RegExp(`^${escapeRe(key)}=(.*)$`, 'gm');
  const hits = [...String(text).matchAll(re)];
  if (hits.length !== 1) throw new Error(`${key}: expected one \`${key}=\` line, found ${hits.length}`);
  const from = hits[0][1];
  return { text: String(text).replace(re, `${key}=${value}`), from };
}

/** The values of a shell-assignment file, single-line ones only. */
export function readEnv(text) {
  const out = {};
  for (const m of String(text).matchAll(/^([A-Z][A-Z0-9_]*)=([^'\n]*)$/gm)) out[m[1]] = m[2];
  return out;
}

/** Replace every `FROM <old>` (the image@digest, not a stage) with `FROM <new>`; at least one, or refuse. */
export function replaceFrom(text, oldRef, newRef) {
  const re = new RegExp(`^(\\s*FROM\\s+)${escapeRe(oldRef)}(?=\\s|$)`, 'gim');
  const count = [...String(text).matchAll(re)].length;
  if (count === 0) throw new Error(`no FROM ${oldRef} line`);
  return { text: String(text).replace(re, `$1${newRef}`), from: oldRef, count };
}

/** Replace every occurrence of a literal; at least one, or refuse. */
export function replaceEvery(text, from, to, what) {
  const count = String(text).split(from).length - 1;
  if (count === 0) throw new Error(`${what}: no occurrence of ${from}`);
  return { text: String(text).split(from).join(to), from, count };
}

/**
 * Set a guide page's `CHECKED_ON` line to a date — the day the page's claims
 * were last checked against the files they describe. The image-base bump
 * moves the page, and the pull request's `frontend` check is that read
 * (DockerGuides.test.jsx holds the page to versions.env), so the date moves
 * with it (CodeRabbit on #1123). The label is `en-GB` long form, as the test
 * requires of it (`14 October 2026`).
 */
export function setCheckedOn(text, date) {
  const iso = date.toISOString().slice(0, 10);
  const label = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const re = /^export const CHECKED_ON = Object\.freeze\(\{ iso: '(\d{4}-\d{2}-\d{2})', label: '[^']+' \}\);$/gm;
  const hits = [...String(text).matchAll(re)];
  if (hits.length !== 1) throw new Error(`CHECKED_ON: expected one line, found ${hits.length}`);
  return {
    text: String(text).replace(re, `export const CHECKED_ON = Object.freeze({ iso: '${iso}', label: '${label}' });`),
    from: hits[0][1],
    to: iso,
  };
}

/** Replace the one match of a pattern's first group; refuse zero or two. */
export function replaceOne(text, pattern, value, what) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits = [...String(text).matchAll(re)];
  if (hits.length !== 1) throw new Error(`${what}: expected one match, found ${hits.length}`);
  const [whole, group] = hits[0];
  const at = hits[0].index + whole.lastIndexOf(group);
  const next = String(text).slice(0, at) + value + String(text).slice(at + group.length);
  return { text: next, from: group };
}

// ── Applying a plan ────────────────────────────────────────────────────────

/**
 * Apply each bump's edits to a copy of the files; a bump whose edit cannot be
 * made exactly (the file is not shaped as expected) becomes a note and
 * changes nothing, so a half-applied bump cannot reach a pull request.
 */
export function applyBumps(files, bumps) {
  let current = { ...files };
  const applied = [];
  const notes = [];
  for (const bump of bumps) {
    const next = { ...current };
    const changes = [];
    try {
      for (const edit of bump.edits) {
        if (!(edit.file in next)) throw new Error(`${edit.file} was not read`);
        const result = edit.apply(next[edit.file]);
        changes.push({ file: edit.file, where: edit.where, from: result.from, to: edit.to });
        next[edit.file] = result.text;
      }
      current = next;
      applied.push({ ...bump, changes });
    } catch (error) {
      notes.push({ label: bump.label, from: bump.from, to: bump.to, reason: `the edit could not be made: ${error.message}` });
    }
  }
  return { files: current, applied, notes };
}

export const yamlEdit = (path, to) => ({
  file: GROUP_VARS_PATH,
  where: path.join('.'),
  to,
  apply: (text) => setYamlScalar(text, path, to),
});
