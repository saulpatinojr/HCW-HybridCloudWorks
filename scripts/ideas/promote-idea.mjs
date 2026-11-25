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

/** Options that are on when given: option -> the field it sets. */
const FLAG_OPTIONS = { '--help': 'help', '-h': 'help', '--dry-run': 'dryRun' };
/** Options that take the next argument: option -> [the field it sets, what the value must be]. */
const VALUE_OPTIONS = { '--name': ['name', 'a value'], '--vault': ['vault', 'a folder'] };
/** Options that are refused with their own message. */
const RETIRED_OPTIONS = {
  '--out-dir': '--out-dir no longer exists: drafts go to <vault>/Drafts. Give your vault with --vault <folder> or set HCW_VAULT',
};

function readArgs(argv) {
  const options = { note: null, name: undefined, vault: undefined, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const step = readArg(argv[index], argv[index + 1], options);
    if (step.error) return { error: step.error };
    index += step.consumed;
  }
  return { options };
}

/** One argument onto `options`: `{ consumed }`, how many arguments after it were its value, or `{ error }`. */
function readArg(arg, next, options) {
  if (Object.hasOwn(FLAG_OPTIONS, arg)) {
    options[FLAG_OPTIONS[arg]] = true;
    return { consumed: 0 };
  }
  if (Object.hasOwn(VALUE_OPTIONS, arg)) return readValue(arg, next, options);
  if (arg.startsWith('-')) return { error: RETIRED_OPTIONS[arg] ?? `unknown option ${arg}` };
  if (options.note !== null) return { error: 'give one note at a time' };
  options.note = arg;
  return { consumed: 0 };
}

function readValue(arg, value, options) {
  // The next argument is this option's value. A missing one, or another
  // option standing where the value should be, is a mistake to report, not
  // a path to guess (an empty folder name would resolve to the current folder).
  const [field, needs] = VALUE_OPTIONS[arg];
  if (!value || value.startsWith('-')) return { error: `${arg} needs ${needs}` };
  options[field] = value;
  return { consumed: 1 };
}

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
