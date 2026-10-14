/**
 * Move the floors in scripts/version-floors.json when a newer release ships
 * (#715, #714).
 *
 * What it does, in order:
 *
 *   1. Reads https://endoflife.date/api/v1/products/<name>/ for python,
 *      nodejs, ubuntu, debian, alpine-linux, terraform, postgresql and
 *      hashicorp-vault, the Azure Functions Flex Consumption page on
 *      Microsoft Learn for the Node.js lines Flex offers, and the
 *      actions/runner-images README for the Ubuntu releases GitHub-hosted
 *      runners offer. endoflife.date rather than
 *      postgresql.org's versions.json for PostgreSQL, so every kind has one
 *      source format and the workflow's "endoflife.date's v1 API for each
 *      kind" stays true; it lists a major only from its general release.
 *      Portainer is not a kind for the same reason: endoflife.date has no
 *      product for it, and the file's "unsourced" section says so.
 *   2. Works out, per kind, the newest release the rule allows and the floor
 *      it implies (lib/version-floor-proposals.mjs, pure and tested).
 *   3. Writes version-floors.json when any value moved, and moves every pin
 *      the new floors leave behind that proposeMove() can move: an
 *      engines.node range behind within its line, in its package.json and
 *      the lockfile beside it (lib/version-floor-moves.mjs). Until #1152 the
 *      pull request carried the floors alone and went red on those ranges
 *      every time a Node.js minor shipped, for a person to move by hand what
 *      this can move exactly.
 *   4. Reads the tree again and prints a Markdown summary: each kind's
 *      old → new, the pins moved, and every pin still behind, which a person
 *      moves. `--body` wraps it in the pull request template.
 *
 * Exit 0 and no write when nothing moved: `checkedOn` moves only with its
 * entry, the same convention as AVM_VERIFIED_ON, so a quiet week is not a
 * pull request. `--dry-run` prints without writing; `--summary <path>` also
 * writes the summary to a file, and `--body <path>` the pull request body,
 * with `--run-url` the run it names. Exit 1 and one sentence, with nothing
 * written, when a source cannot be read or goes backwards; exit 2 on a bad
 * argument. A pin whose files refuse the move (lib/version-floor-moves.mjs
 * says when) stays behind with a warning, and the run carries on.
 *
 * THE FUNCTIONS CEILING is read from the Learn page's "Supported language
 * stack versions" table, the one place Microsoft states it for Flex. When the
 * table cannot be found or read, the ceiling is left where it is and the
 * summary says so in a line raised as a warning; the rest of the run still
 * completes. The machine-readable source,
 * `az functionapp list-flexconsumption-runtimes`, needs an Azure sign-in, and
 * a scheduled job that opens pull requests should not hold one.
 *
 * THE RUNNERS CEILING, the Ubuntu release every workflow's runs-on names, is
 * read the same way from the "Available Images" table of the
 * actions/runner-images README, the page GitHub marks a preview image on and
 * takes the badge off when the image is generally available. It fails soft
 * in the same way: an unreadable README leaves the ceiling where it is, with
 * a warning.
 *
 * TWO FILES. This one owns everything that touches the network, the
 * filesystem or the clock; lib/version-floor-proposals.mjs owns the decisions
 * and is re-exported here so a test imports from one place.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArgs } from './lib/cli.mjs';
import {
  PRODUCTS,
  SourceError,
  proposeFloors,
  readFlexNodeLines,
  readRunnerUbuntuReleases,
  renderPullRequestBody,
  renderSummary,
  serialise,
} from './lib/version-floor-proposals.mjs';
import { moveLockfileRange, moveManifestRange } from './lib/version-floor-moves.mjs';
import { ENGINES_EXEMPT, collectPins, findViolations, proposeMove, trackedFiles } from './version-floors.mjs';

export * from './lib/version-floor-proposals.mjs';
export * from './lib/version-floor-moves.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOORS_PATH = path.join(ROOT, 'scripts', 'version-floors.json');
const USAGE = 'Usage: node scripts/update-version-floors.mjs [--dry-run] [--summary <path>] [--body <path> --run-url <url>]';
const USER_AGENT = 'HCW-HybridCloudWorks update-version-floors (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

export const eolUrl = (product) => `https://endoflife.date/api/v1/products/${product}/`;
export const FLEX_URL = 'https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan';
export const RUNNER_IMAGES_URL = 'https://raw.githubusercontent.com/actions/runner-images/main/README.md';

async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (err) {
    throw new SourceError(`${url}: ${err.message}`);
  }
  if (!response.ok) throw new SourceError(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(`${url}: not JSON`);
  }
}

/** A page read by `parse`, or null with a warning: the two ceiling sources may fail without failing the run. */
async function readSoft(url, parse) {
  try {
    return parse(await fetchText(url));
  } catch (err) {
    console.error(`::warning::${err.message}`);
    return null;
  }
}

/** Every source, read. */
async function readSources() {
  const eol = {};
  for (const [kind, product] of Object.entries(PRODUCTS)) eol[kind] = await fetchJson(eolUrl(product));
  return {
    eol,
    flexNodeLines: await readSoft(FLEX_URL, readFlexNodeLines),
    runnerUbuntuReleases: await readSoft(RUNNER_IMAGES_URL, readRunnerUbuntuReleases),
  };
}

/** Every finding the floors leave in the tree as it is now. */
const findingsAt = (floors) => findViolations(floors, collectPins(ROOT, floors), { enginesExempt: ENGINES_EXEMPT });

/**
 * Move each pin proposeMove() can move, in its package.json and, when one is
 * tracked beside it, its package-lock.json. Both files are edited before
 * either is written, so a refusal leaves the pair as it was; and a write that
 * fails puts back whatever was already written for that pin, because a pair
 * half-moved is worse than one not moved (CodeRabbit on #1160). `io` and
 * `root` are the filesystem, replaced in a test.
 */
export async function movePins(floors, findings, { write, root = ROOT, tracked = new Set(trackedFiles(root)), io = fs }) {
  const moved = [];
  for (const pin of findings) {
    const to = proposeMove(pin, floors);
    if (!to) continue;
    const lockfile = path.posix.join(path.posix.dirname(pin.file), 'package-lock.json');
    const files = [[pin.file, moveManifestRange], ...(tracked.has(lockfile) ? [[lockfile, moveLockfileRange]] : [])];
    const written = [];
    try {
      const edits = [];
      for (const [file, move] of files) {
        const original = await io.readFile(path.join(root, file), 'utf8');
        edits.push({ file, original, text: move(file, original, pin.range, to) });
      }
      for (const edit of write ? edits : []) {
        await io.writeFile(path.join(root, edit.file), edit.text);
        written.push(edit);
      }
      moved.push({ file: pin.file, line: pin.line, where: pin.where, from: pin.range, to, files: edits.map((e) => e.file) });
    } catch (err) {
      for (const edit of written) await io.writeFile(path.join(root, edit.file), edit.original);
      console.error(`::warning::${err.message}`);
    }
  }
  return moved;
}

/** One run: read the sources, move the floors and the pins they carry, and write the summary and body asked for. */
async function run(args) {
  const today = new Date().toISOString().slice(0, 10);
  const write = !args.flags['dry-run'];
  const current = JSON.parse(await fs.readFile(FLOORS_PATH, 'utf8'));
  const proposal = proposeFloors(current, await readSources(), today);
  const found = findingsAt(proposal.next);
  // Pins move only with a floor: a quiet week writes nothing at all.
  const moved = proposal.changes.length ? await movePins(proposal.next, found, { write }) : [];
  // Judged again from the tree once written, so "still behind" is read, not assumed.
  const behind = write && moved.length ? findingsAt(proposal.next) : found.filter((f) => !moved.some((m) => m.where === f.where));
  const summary = renderSummary({ ...proposal, moved, behind, today });
  process.stdout.write(summary);
  for (const note of proposal.notes.filter((n) => /could not be read/.test(n))) console.error(`::warning::${note}`);
  if (args.options.summary) await fs.writeFile(args.options.summary, summary);
  if (args.options.body) await fs.writeFile(args.options.body, renderPullRequestBody({ summary, moved, behind, runUrl: args.options['run-url'] }));
  if (proposal.changes.length && write) await fs.writeFile(FLOORS_PATH, serialise(proposal.next));
}

/** The exit code: 0 done, 1 a source could not be read or went backwards, 2 a bad argument. */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { flags: ['dry-run', 'help'], options: ['summary', 'body', 'run-url'] });
    if (args.options.body && !args.options['run-url']) throw new Error('--body needs --run-url, the run the body names');
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.flags.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    await run(args);
    return 0;
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    console.error(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
