/**
 * check-new-smells.mjs (#1845) — does this pull request add a medium or high Qlty code smell?
 *
 * A code smell is a pattern Qlty's own checks report: a function that is too complex, one with too many `return`
 * lines, a file whose total complexity is too high, or a block of code copied (identically or nearly) somewhere
 * else. Qlty Cloud lists them after a merge; this check stops a pull request from adding one first.
 *
 *   node scripts/check-new-smells.mjs --head <head.json> --base <base.json> --config <qlty.toml> [--renames <file>]
 *
 *   --head     `qlty smells --upstream <base commit> --json` run on the pull request: the smells in the files it
 *              changes (and copies of their code found anywhere).
 *   --base     `qlty smells --json <the same files>` run on the base commit: what was already there.
 *   --config   the BASE branch's .qlty/qlty.toml. Its [[triage]] blocks are applied to every smell (see
 *              lib/qlty-triage.mjs for why this script does that and Qlty does not).
 *   --renames  optional `git diff -z --name-status -M <base> HEAD` output, so a moved file keeps its old smells.
 *
 * A smell counts as new when, after triage, it is medium or high and the base had no smell with the same rule, file
 * and function (for copied code: the same set of files). A smell the base already had does not fail the check, even
 * when the pull request touches it: the check stops new smells, it does not ask for every old one to be fixed first.
 *
 * Exit 0: nothing new. Exit 1: one or more new smells, each printed as a GitHub annotation on its file and line.
 * Exit 2: the command was used wrongly or a file could not be read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTriageBlocks, triage } from './lib/qlty-triage.mjs';

/** The levels that fail the check, as lib/qlty-triage.mjs spells them. */
export const FAILING_LEVELS = Object.freeze(['medium', 'high']);

/**
 * `git diff -z --name-status -M` output → Map(new path → old path) for each rename. With -z every field ends in
 * a NUL and no name is quoted or escaped, so a file name with a tab, a newline or a quote keeps its smells. A
 * rename or copy (R, C) carries two paths, every other status one.
 */
export function parseRenames(text) {
  const fields = String(text || '').split('\0');
  const renames = new Map();
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    if (!status) break;
    const twoPaths = /^[RC]\d*$/.test(status);
    if (/^R\d*$/.test(status) && fields[i + 1] && fields[i + 2]) renames.set(fields[i + 2], fields[i + 1]);
    i += twoPaths ? 3 : 2;
  }
  return renames;
}

/**
 * What makes two smells "the same one" across the base and the pull request. Line numbers are left out, since an
 * edit above a smell moves it, and so are the counts in the message ("count = 7"), since a smell that grew is
 * still the same smell. For copied code the other files are part of it, sorted, so a new copy is a new smell.
 */
export function smellKey(issue, pathOf = (path) => path) {
  const path = pathOf(issue.location?.path || '');
  const message = String(issue.message || '')
    .replace(/\s*\((?:count|mass) = [\d.]+\)/g, '')
    .replace(/\b\d+ lines\b/g, 'N lines')
    .replace(/\bin \d+ locations\b/g, 'in N locations');
  if (issue.driver === 'duplication') {
    const others = (issue.otherLocations || []).map((other) => pathOf(other.path)).sort();
    return [issue.ruleKey, path, others.join(',')].join('|');
  }
  return [issue.ruleKey, path, message].join('|');
}

/** How many smells the base had of each key. */
function countByKey(issues) {
  const counts = new Map();
  for (const issue of issues) {
    const key = smellKey(issue);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * The pull request's smells that fail the check: medium or high after triage, and more of their key than the base
 * had. Counted, not just looked up, because some keys name no function ("Deeply nested control flow", "Complex
 * binary expression") and two functions in one file can share a name: with a plain lookup, one such smell on the
 * base would excuse any number of new ones. When the base had N of a key, the first N in the pull request are the
 * old ones and every one after them is new.
 */
export function newSmells({ head, base, blocks, renames = new Map() }) {
  const remaining = countByKey(base);
  const toBasePath = (path) => renames.get(path) || path;
  return head.filter((issue) => {
    const verdict = triage(blocks, issue);
    if (verdict.ignored || !FAILING_LEVELS.includes(verdict.level)) return false;
    const key = smellKey(issue, toBasePath);
    const left = remaining.get(key) || 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
}

/** A GitHub Actions error annotation: it shows on the file and line in the pull request's diff. */
export function annotation(issue) {
  const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (text) => escape(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const where = issue.location || {};
  const line = where.range?.startLine || 1;
  const also = (issue.otherLocations || []).map((other) => `${other.path}:${other.range?.startLine ?? '?'}`);
  const detail = also.length ? ` Also at ${also.join(', ')}.` : '';
  return `::error file=${property(where.path || '')},line=${line},title=${property(`Code smell: ${issue.ruleKey}`)}::${escape(`${issue.message}.${detail}`)}`;
}

const USAGE =
  'usage: node check-new-smells.mjs --head <head.json> --base <base.json> --config <qlty.toml> [--renames <file>]';

const OPTIONS = new Set(['head', 'base', 'config', 'renames']);

/** The option's name when `word` is a known `--option` not given yet, else null. */
function optionName(word, args) {
  const name = word?.startsWith('--') ? word.slice(2) : null;
  return OPTIONS.has(name) && !(name in args) ? name : null;
}

/** `--name value` pairs only; anything else is a usage error. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = optionName(argv[i], args);
    const value = argv[i + 1];
    if (!name || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    args[name] = value;
  }
  if (!args.head || !args.base || !args.config) throw new Error(USAGE);
  return args;
}

/** A smells JSON file as an array; Qlty prints `[]` when there is nothing. */
// No fallback for an empty file: Qlty prints `[]` when it finds nothing, and the workflow writes `[]` itself when
// the base has no files to read, so an empty file means a run that failed, and that is a usage error (exit 2).
function readIssues(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list of smells`);
  return parsed;
}

function main(argv) {
  let inputs;
  try {
    const args = parseArgs(argv);
    inputs = {
      head: readIssues(args.head),
      base: readIssues(args.base),
      blocks: parseTriageBlocks(readFileSync(args.config, 'utf8')),
      renames: parseRenames(args.renames ? readFileSync(args.renames, 'utf8') : ''),
    };
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const found = newSmells(inputs);
  if (found.length === 0) {
    process.stdout.write(
      `No new medium or high code smell (${inputs.head.length} in the changed files, each already on the base branch, ` +
        `below medium, or set aside by a [[triage]] block in .qlty/qlty.toml).\n`
    );
    return 0;
  }
  for (const issue of found) process.stdout.write(`${annotation(issue)}\n`);
  process.stdout.write(
    `${found.length} new code smell${found.length === 1 ? '' : 's'} in this pull request. Simplify the code (split a ` +
      'long function, share copied code), or, for a file that is only data, see ' +
      'docs/security/scanner-triage.md#code-smells-in-data-and-style-tables.\n'
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
