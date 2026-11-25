/**
 * Reads the [[triage]] blocks of .qlty/qlty.toml and applies them to one Qlty issue, the way Qlty's
 * documentation describes them (https://docs.qlty.sh/cli/qlty-toml#triage): a block matches an issue when every
 * condition it names holds (plugins, rules, levels, file_patterns), the FIRST matching block wins, and its `set`
 * part says what changes (`ignored`, `level`).
 *
 * Why this exists (#1845): Qlty does not apply [[triage]] to its own code smells (similar-code, function
 * complexity and so on), in the CLI or in Qlty Cloud (qltysh/qlty#2902). The pull request smell check
 * (scripts/check-new-smells.mjs) applies the blocks itself, so the narrow "data tables" rule in qlty.toml is the
 * one place that decision is written.
 *
 * Not a general TOML parser: it reads the shapes qlty.toml uses for these blocks (`key = "text"`, `key = true`,
 * and arrays of double-quoted strings, which may span lines). Node built-ins only.
 */

/** The value text after `=`: a string, a boolean, or an array of strings (joined from several lines if needed). */
function parseValue(text) {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (trimmed.startsWith('[')) return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const quoted = trimmed.match(/^"((?:[^"\\]|\\.)*)"/);
  return quoted ? quoted[1] : trimmed;
}

/** Lines with whole-line comments removed; a `#` inside a value is left alone. */
function meaningfulLines(tomlText) {
  return tomlText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

/** One `key = value` entry, reading on to the closing `]` when an array spans lines. Returns the next index. */
function readEntry(lines, index, block) {
  const match = lines[index].match(/^\s*([A-Za-z0-9_.]+)\s*=\s*(.*)$/);
  if (!match) return index + 1;
  let text = match[2];
  let next = index + 1;
  while (text.trim().startsWith('[') && !text.includes(']') && next < lines.length) {
    text += ` ${lines[next]}`;
    next += 1;
  }
  block[match[1]] = parseValue(text);
  return next;
}

/** Every [[triage]] block, in file order, as `{ 'match.rules': [...], 'set.ignored': true, ... }`. */
export function parseTriageBlocks(tomlText) {
  const lines = meaningfulLines(tomlText);
  const blocks = [];
  let current = null;
  let index = 0;
  while (index < lines.length) {
    const header = lines[index].trim();
    if (header.startsWith('[')) {
      current = header === '[[triage]]' ? {} : null;
      if (current) blocks.push(current);
      index += 1;
    } else if (current) {
      index = readEntry(lines, index, current);
    } else {
      index += 1;
    }
  }
  return blocks;
}

/** What each glob token becomes in a regular expression; any other special character is escaped. */
const GLOB_TOKENS = Object.freeze({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' });

/** A glob as Qlty documents them: `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob) {
  const body = glob.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => GLOB_TOKENS[token] ?? `\\${token}`);
  return new RegExp(`^${body}$`);
}

/** `LEVEL_MEDIUM` (the CLI's JSON) and `medium` (qlty.toml) as the same word. */
export const levelName = (level) => String(level || '').replace(/^LEVEL_/, '').toLowerCase();

/** A condition the block does not name always holds. */
const holds = (values, test) => !Array.isArray(values) || values.length === 0 || values.some(test);

/** Whether every condition the block names holds for this issue. */
export function blockMatches(block, issue) {
  const path = issue.location?.path || '';
  const rule = `${issue.tool}:${issue.ruleKey}`;
  const conditions = [
    ['match.plugins', (plugin) => plugin === issue.tool],
    ['match.rules', (name) => name === rule || name === issue.ruleKey],
    ['match.levels', (level) => levelName(level) === levelName(issue.level)],
    ['match.file_patterns', (glob) => globToRegExp(glob).test(path)],
  ];
  return conditions.every(([key, test]) => holds(block[key], test));
}

/**
 * The issue after triage: `{ ignored, level }`. The first block that matches decides; a block with no `set.level`
 * keeps the issue's own level.
 */
export function triage(blocks, issue) {
  const block = blocks.find((candidate) => blockMatches(candidate, issue));
  return {
    ignored: block?.['set.ignored'] === true,
    level: levelName(block?.['set.level'] || issue.level),
  };
}
