/**
 * read-note-file.mjs — read one note without checking it and reading it as two
 * separate steps on the same path.
 *
 * Asking for a file's size by its path and then reading it by its path leaves a
 * gap in which the file can change (CodeQL's js/file-system-race, flagged on
 * #1349). Here the file is opened once and everything after that, the type
 * check, the size check and the read, goes through the open handle, so the
 * answer and the content are about the same file.
 */
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

/** An idea note is a page of text; a bigger file is something else. */
export const MAX_NOTE_BYTES = 1024 * 1024;

/**
 * @param {string} path
 * @returns {{ text: string } | { tooBig: true }}
 * @throws when the file cannot be opened or is not a regular file
 */
export function readNoteFile(path) {
  const handle = openSync(path, 'r');
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_NOTE_BYTES) return { tooBig: true };
    return { text: readFileSync(handle, 'utf8') };
  } finally {
    closeSync(handle);
  }
}
