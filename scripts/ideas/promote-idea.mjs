/**
 * promote-idea.mjs — turns one outlined Obsidian idea note into a draft article
 * file in the owner's private vault, ready to upload on Admin > Drafts.
 *
 *   node scripts/ideas/promote-idea.mjs <note.md> [--vault <folder>] [--name <words-with-hyphens>] [--dry-run]
 *
 * WHERE THE DRAFT GOES. Into `<vault>/Drafts`, where the vault is the folder
 * given with --vault, or else the one named by the HCW_VAULT environment
 * variable. With neither it stops and says so. It never writes into this
 * repository: an article that is not yet published must not sit in a public
 * repository or on the public docs site (owner rule 2026-10-25). Any output
 * folder that turns out to be inside the repository is refused, however it is
 * spelt: a relative path, `..`, a different upper/lower case on Windows, or a
 * symlink or junction (a folder that is really a shortcut to another folder)
 * that leads in. The Drafts folder is created if the vault does not have one yet.
 *
 * It reads the note and writes one new file. It never changes the note, so set
 * the note's status to drafted yourself afterwards. It never overwrites: a
 * file that already exists is a reason to stop and pick another --name.
 *
 * WHAT YOU DO AFTER IT RUNS. Read the draft, then upload it on Admin > Drafts
 * (Paste or upload a markdown draft). The script refuses what can only be
 * private notes or only work in Obsidian (see idea-notes.mjs) but it cannot
 * know what else you would not want published.
 *
 * The file format is unchanged: front matter, then the article. The server's
 * markdown reader (parseRepoDraft in functions/src/lib/cms/repo-draft.js) reads
 * it, and functions/src/lib/cms/idea-promotion.test.js holds the two together.
 *
 * Exit 0: written (or shown, with --dry-run). 1: the note cannot be promoted,
 * the file exists, or the output folder is inside the repository. 2: could not
 * run (usage, no vault, unreadable note).
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkNote, planPromotion } from './idea-notes.mjs';
import { readNoteFile } from './read-note-file.mjs';
import { chooseDraftsFolder, isInside, realPathOf, REPO_ROOT } from './promote-paths.mjs';
import { readArgs } from './promote-args.mjs';

const USAGE = `Usage: node scripts/ideas/promote-idea.mjs <note.md> [--vault <folder>] [--name <words-with-hyphens>] [--dry-run]

Turns an outlined idea note (type blog, format how-to or build-log) into
blog-<name>.md in the Drafts folder of your Obsidian vault. Give the vault with
--vault, or set the HCW_VAULT environment variable. Then upload the file on
Admin > Drafts. The note is never changed, no file is overwritten, and nothing
is ever written inside this repository. --dry-run prints the draft and writes
nothing. Exit 0: done. Exit 1: the note cannot be promoted, or the output
folder is inside the repository. Exit 2: could not run.`;

/** The run stops here: exit `code`, with `lines` on stderr. */
class Stop extends Error {
  constructor(code, lines) {
    super(lines[0]);
    this.code = code;
    this.lines = lines;
  }
}

function main(argv, { now = () => new Date(), env = process.env, repoRoot = REPO_ROOT } = {}) {
  const { options, error } = readArgs(argv);
  if (error) {
    console.error(`${error}\n\n${USAGE}`);
    return 2;
  }
  if (options.help || !options.note) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }
  try {
    return promote(options, { now, env, repoRoot });
  } catch (stop) {
    if (!(stop instanceof Stop)) throw stop;
    for (const line of stop.lines) console.error(line);
    return stop.code;
  }
}

/**
 * The folder the draft goes in. It is decided, and refused if it is inside the
 * repository, before anything else is read or made.
 */
function draftsFolderFor(options, { env, repoRoot }) {
  const where = chooseDraftsFolder({ vault: options.vault, env, repoRoot });
  if (where.error) throw new Stop(where.refused ? 1 : 2, [where.error]);
  const vaultFolder = dirname(where.drafts);
  if (!existsSync(vaultFolder) || !statSync(vaultFolder).isDirectory()) {
    throw new Stop(2, [`The vault folder "${vaultFolder}" does not exist. Check the path you gave.`]);
  }
  return where;
}

function readNoteText(notePath) {
  try {
    const read = readNoteFile(notePath);
    if (read.tooBig) throw new Error('the file is over 1 MB');
    return read.text;
  } catch (readError) {
    throw new Stop(2, [`Cannot read "${notePath}": ${readError.message}`]);
  }
}

/** The draft's file name and text, or a Stop naming why the note is not promoted. */
function promotionFor(notePath, text, { name, now }) {
  const { issues, note } = checkNote(basename(notePath), text);
  if (!note) {
    throw new Stop(1, [
      `${notePath} does not follow the idea-note format, so it was not promoted:`,
      ...issues.map((issue) => `  ${issue.line ? `line ${issue.line}: ` : ''}${issue.message}`),
    ]);
  }
  const plan = planPromotion(note, { name, now });
  if (!plan.ok) throw new Stop(1, [`${notePath} was not promoted:`, ...plan.reasons.map((reason) => `  ${reason}`)]);
  return plan;
}

/** Write the draft, never over an existing file and never inside the repository. */
function writeDraft(where, target, text, repoRoot) {
  try {
    mkdirSync(where.drafts, { recursive: true });
    // Look again now that the folder exists: a link made in the meantime, or one
    // the first look could not see, must not carry the file into the repository.
    if (isInside(realPathOf(where.drafts), where.realRoot)) {
      throw new Stop(1, [`Refused: "${where.drafts}" is inside the repository "${repoRoot}". Nothing was written.`]);
    }
    writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
  } catch (writeError) {
    if (writeError instanceof Stop) throw writeError;
    if (writeError.code === 'EEXIST') {
      throw new Stop(1, [`${target} already exists, and this script never overwrites. Pick another file name with --name.`]);
    }
    throw new Stop(2, [`Cannot write ${target}: ${writeError.message}`]);
  }
}

function promote(options, { now, env, repoRoot }) {
  const where = draftsFolderFor(options, { env, repoRoot });
  const text = readNoteText(options.note);
  const plan = promotionFor(options.note, text, { name: options.name, now });

  const target = join(where.drafts, plan.fileName);
  if (options.dryRun) {
    console.log(`Would write ${target}\n`);
    console.log(plan.text);
    return 0;
  }
  writeDraft(where, target, plan.text, repoRoot);
  console.log(`Wrote ${target}`);
  console.log('');
  console.log('Next:');
  console.log('  1. Read the draft through.');
  console.log('  2. In your note, change status to drafted. This script never edits your vault notes.');
  console.log('  3. Upload the file on Admin > Drafts (Paste or upload a markdown draft).');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { chooseDraftsFolder, isInside, main, realPathOf };
