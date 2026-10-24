/**
 * promote-idea.mjs — turns one outlined Obsidian idea note into a draft article
 * in docs/content/blog-<name>.md, in the shape the admin's "Import from
 * docs/content" takes.
 *
 *   node scripts/ideas/promote-idea.mjs <note.md> [--name <words-with-hyphens>] [--out-dir <folder>] [--dry-run]
 *
 * It reads the note and writes one new file. It never changes the note, so set
 * the note's status to drafted yourself afterwards. It never overwrites: a
 * file that already exists is a reason to stop and pick another --name.
 *
 * WHAT YOU MUST DO AFTER IT RUNS. The new file is in the repository's working
 * folder, and what is committed under docs/content is public. Read the draft
 * through before you commit it. The script refuses what can only be private
 * notes or only work in Obsidian (see idea-notes.mjs) but it cannot know what
 * else you would not want published.
 *
 * Exit 0: written (or shown, with --dry-run). 1: the note cannot be promoted,
 * or the file exists. 2: could not run (usage, unreadable note).
 */
import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkNote, planPromotion } from './idea-notes.mjs';
import { readNoteFile } from './read-note-file.mjs';

const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'content');

const USAGE = `Usage: node scripts/ideas/promote-idea.mjs <note.md> [--name <words-with-hyphens>] [--out-dir <folder>] [--dry-run]

Turns an outlined idea note (type blog, format how-to or build-log) into
docs/content/blog-<name>.md. The note is never changed and no file is
overwritten. --dry-run prints the draft and writes nothing. Exit 0: done.
Exit 1: the note cannot be promoted. Exit 2: could not run.`;

function readArgs(argv) {
  const options = { note: null, name: undefined, outDir: DEFAULT_OUT_DIR, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--name') options.name = argv[++index];
    else if (arg === '--out-dir') options.outDir = resolve(argv[++index] ?? '');
    else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else if (options.note === null) options.note = arg;
    else return { error: 'give one note at a time' };
  }
  if (options.name === '' || (argv.includes('--name') && options.name === undefined)) {
    return { error: '--name needs a value' };
  }
  return { options };
}

function main(argv, { now = () => new Date() } = {}) {
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

  const target = join(options.outDir, plan.fileName);
  if (options.dryRun) {
    console.log(`Would write ${target}\n`);
    console.log(plan.text);
    return 0;
  }
  try {
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
  console.log('Before you commit it:');
  console.log('  1. Read the draft through. What is committed under docs/content is public.');
  console.log('  2. In your note, change status to drafted. This script never edits your vault.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
