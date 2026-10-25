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
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkNote, planPromotion } from './idea-notes.mjs';
import { readNoteFile } from './read-note-file.mjs';

/** The repository this script belongs to: two folders up from scripts/ideas. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The vault's folder for drafts, and the environment variable that names the vault. */
const DRAFTS_FOLDER = 'Drafts';
const VAULT_ENV = 'HCW_VAULT';

const USAGE = `Usage: node scripts/ideas/promote-idea.mjs <note.md> [--vault <folder>] [--name <words-with-hyphens>] [--dry-run]

Turns an outlined idea note (type blog, format how-to or build-log) into
blog-<name>.md in the Drafts folder of your Obsidian vault. Give the vault with
--vault, or set the HCW_VAULT environment variable. Then upload the file on
Admin > Drafts. The note is never changed, no file is overwritten, and nothing
is ever written inside this repository. --dry-run prints the draft and writes
nothing. Exit 0: done. Exit 1: the note cannot be promoted, or the output
folder is inside the repository. Exit 2: could not run.`;

/**
 * The real, absolute form of a path that may not exist yet: the longest part
 * that exists is resolved through symlinks and junctions, and the rest is put
 * back on the end. Without this a link in the path would be taken at its word,
 * and a Drafts folder that does not exist yet could hide a link in its parent.
 */
function realPathOf(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length === 0 ? real : join(real, ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Is `target` the repository root or anywhere below it? Both paths are taken as
 * already real (see realPathOf). Windows and macOS file systems ignore case by
 * default, so there `C:\Repo` and `c:\repo` are the same folder; elsewhere case
 * counts. A sibling whose name only starts with the repository's name
 * (`repo-copy` next to `repo`) is not inside it.
 */
function isInside(target, root, caseInsensitive = process.platform === 'win32' || process.platform === 'darwin') {
  const fold = (path) => (caseInsensitive ? path.toLowerCase() : path);
  const below = relative(fold(resolve(root)), fold(resolve(target)));
  return below === '' || (below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below));
}

/**
 * Where drafts go: `<vault>/Drafts`, or a plain-language reason there is none.
 * Nothing is created here; the folder is only worked out and checked.
 */
function chooseDraftsFolder({ vault, env, repoRoot }) {
  const given = vault ?? env[VAULT_ENV];
  if (!given || !given.trim()) {
    return {
      error:
        'No vault was given, so there is nowhere safe to put the draft. Give the folder of your Obsidian vault with ' +
        `--vault <folder>, or set the ${VAULT_ENV} environment variable to it. Drafts are never written into this ` +
        'repository, because it is public.',
    };
  }
  const drafts = join(resolve(given), DRAFTS_FOLDER);
  let real;
  let realRoot;
  try {
    real = realPathOf(drafts);
    realRoot = realPathOf(repoRoot);
  } catch (error) {
    return { error: `Cannot work out where "${drafts}" is: ${error.message}` };
  }
  if (isInside(real, realRoot)) {
    return {
      refused: true,
      error:
        `Refused: "${drafts}"${real === drafts ? '' : ` (which is really "${real}")`} is inside the repository ` +
        `"${repoRoot}". The repository is public, and a draft that is not published yet must never be saved in it. ` +
        'Use the folder of your private Obsidian vault, which belongs somewhere outside the repository.',
    };
  }
  return { drafts, realRoot };
}

function readArgs(argv) {
  const options = { note: null, name: undefined, vault: undefined, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--out-dir') {
      return {
        error:
          '--out-dir no longer exists: drafts go to <vault>/Drafts. Give your vault with --vault <folder> or set HCW_VAULT',
      };
    } else if (arg === '--name' || arg === '--vault') {
      // The next argument is this option's value. A missing one, or another
      // option standing where the value should be, is a mistake to report, not
      // a path to guess (an empty folder name would resolve to the current folder).
      const value = argv[++index];
      if (!value || value.startsWith('-')) {
        return { error: `${arg} needs ${arg === '--name' ? 'a value' : 'a folder'}` };
      }
      if (arg === '--name') options.name = value;
      else options.vault = value;
    } else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else if (options.note === null) options.note = arg;
    else return { error: 'give one note at a time' };
  }
  return { options };
}

function main(argv, { now = () => new Date(), env = process.env, repoRoot = REPO_ROOT } = {}) {
  const { options, error } = readArgs(argv);
  if (error) {
    console.error(`${error}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.note) {
    console.log(USAGE);
    return 2;
  }

  // The folder is decided, and refused if it is inside the repository, before
  // anything else is read or made.
  const where = chooseDraftsFolder({ vault: options.vault, env, repoRoot });
  if (where.error) {
    console.error(where.error);
    return where.refused ? 1 : 2;
  }
  const vaultFolder = dirname(where.drafts);
  if (!existsSync(vaultFolder) || !statSync(vaultFolder).isDirectory()) {
    console.error(`The vault folder "${vaultFolder}" does not exist. Check the path you gave.`);
    return 2;
  }

  let text;
  try {
    const read = readNoteFile(options.note);
    if (read.tooBig) throw new Error('the file is over 1 MB');
    text = read.text;
  } catch (readError) {
    console.error(`Cannot read "${options.note}": ${readError.message}`);
    return 2;
  }

  const { issues, note } = checkNote(basename(options.note), text);
  if (!note) {
    console.error(`${options.note} does not follow the idea-note format, so it was not promoted:`);
    for (const issue of issues) {
      console.error(`  ${issue.line ? `line ${issue.line}: ` : ''}${issue.message}`);
    }
    return 1;
  }

  const plan = planPromotion(note, { name: options.name, now });
  if (!plan.ok) {
    console.error(`${options.note} was not promoted:`);
    for (const reason of plan.reasons) console.error(`  ${reason}`);
    return 1;
  }

  const target = join(where.drafts, plan.fileName);
  if (options.dryRun) {
    console.log(`Would write ${target}\n`);
    console.log(plan.text);
    return 0;
  }
  try {
    mkdirSync(where.drafts, { recursive: true });
    // Look again now that the folder exists: a link made in the meantime, or one
    // the first look could not see, must not carry the file into the repository.
    if (isInside(realPathOf(where.drafts), where.realRoot)) {
      console.error(`Refused: "${where.drafts}" is inside the repository "${repoRoot}". Nothing was written.`);
      return 1;
    }
    writeFileSync(target, plan.text, { encoding: 'utf8', flag: 'wx' });
  } catch (writeError) {
    if (writeError.code === 'EEXIST') {
      console.error(`${target} already exists, and this script never overwrites. Pick another file name with --name.`);
      return 1;
    }
    console.error(`Cannot write ${target}: ${writeError.message}`);
    return 2;
  }
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
