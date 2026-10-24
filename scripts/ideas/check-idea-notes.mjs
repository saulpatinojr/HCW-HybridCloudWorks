/**
 * check-idea-notes.mjs — holds a folder of Obsidian idea notes to the format in
 * ./idea-notes.mjs and says, per file, what to fix.
 *
 *   node scripts/ideas/check-idea-notes.mjs <folder>
 *
 * Point it at the folder that holds the idea notes, not at the whole vault:
 * every .md file under it is read as an idea note, except files and folders
 * whose names start with a dot (.obsidian, .trash) or an underscore (a place
 * for templates), and anything under node_modules. It only reads. It never
 * writes to the folder, and it follows no symbolic link out of it.
 *
 * Exit 0 when every note is fine, 1 when any note has a problem, 2 when it
 * cannot run (no folder given, not a folder, no notes in it).
 */
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDEA_STATUSES, IDEA_TYPES, checkNote } from './idea-notes.mjs';
import { readNoteFile } from './read-note-file.mjs';

const MAX_NOTES = 5000;

const USAGE = `Usage: node scripts/ideas/check-idea-notes.mjs <folder>

Reads every .md file under <folder> as an idea note and lists what is wrong
with each. Files and folders starting with "." or "_" are skipped. Nothing is
written. Exit 0: all fine. Exit 1: problems found. Exit 2: could not run.`;

/** Every note under `root`, as paths relative to it, in a stable order. */
export function findNotes(root) {
  const found = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (entry.name === 'node_modules') continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
      if (found.length > MAX_NOTES) {
        throw new Error(`more than ${MAX_NOTES} notes; point this at a smaller folder`);
      }
    }
  };
  walk(root);
  return found.map((full) => relative(root, full));
}

/**
 * Check every note under `root`.
 *
 * @returns {{ notes: number, bad: number, lines: string[], byStatus: Record<string, number>, byType: Record<string, number> }}
 */
export function checkFolder(root) {
  const lines = [];
  const byStatus = Object.fromEntries(IDEA_STATUSES.map((status) => [status, 0]));
  const byType = Object.fromEntries(IDEA_TYPES.map((type) => [type, 0]));
  const paths = findNotes(root);
  let bad = 0;
  for (const path of paths) {
    const name = path.split(sep).at(-1);
    let read;
    try {
      read = readNoteFile(join(root, path));
    } catch (error) {
      bad += 1;
      lines.push(path.split(sep).join('/'), `  cannot read this file: ${error.message}`);
      continue;
    }
    if (read.tooBig) {
      bad += 1;
      lines.push(path.split(sep).join('/'), '  the file is over 1 MB, which is not an idea note');
      continue;
    }
    const { issues, note } = checkNote(name, read.text);
    if (note) {
      byStatus[note.status] += 1;
      byType[note.type] += 1;
    }
    if (issues.length > 0) {
      bad += 1;
      lines.push(path.split(sep).join('/'));
      for (const issue of issues) {
        lines.push(`  ${issue.line ? `line ${issue.line}: ` : ''}${issue.message}`);
      }
    }
  }
  return { notes: paths.length, bad, lines, byStatus, byType };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const folder = argv.find((arg) => !arg.startsWith('-'));
  if (!folder) {
    console.log(USAGE);
    return 2;
  }
  let stats;
  try {
    stats = checkFolder(folder);
  } catch (error) {
    console.error(`Cannot read "${folder}": ${error.message}`);
    return 2;
  }
  if (stats.notes === 0) {
    console.error(`No .md notes found under "${folder}". Is this the folder that holds your ideas?`);
    return 2;
  }
  for (const line of stats.lines) console.log(line);
  const good = stats.notes - stats.bad;
  const tally = (counts) =>
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key} ${count}`)
      .join(', ') || 'none';
  if (stats.bad === 0) {
    console.log(`${stats.notes} notes checked, all fine.`);
  } else {
    console.log(`${stats.notes} notes checked: ${good} fine, ${stats.bad} with problems.`);
  }
  console.log(`Fine notes by status: ${tally(stats.byStatus)}.`);
  console.log(`Fine notes by type: ${tally(stats.byType)}.`);
  return stats.bad === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
