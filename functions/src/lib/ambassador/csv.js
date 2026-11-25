/**
 * ambassador/csv.js — CSV text as rows of cells (RFC 4180: quoted cells,
 * doubled quotes, CRLF), for the evidence import's pasted exports. Pure;
 * import-readers.js re-exports parseCsv.
 */

/**
 * The text inside a quoted segment, from the character after the opening
 * quote to the closing one (a doubled quote is one literal quote), and the
 * index after the closing quote. An unterminated quote runs to the end.
 */
function readQuoted(source, start) {
  let text = '';
  let i = start;
  while (i < source.length) {
    if (source[i] !== '"') {
      text += source[i];
      i += 1;
    } else if (source[i + 1] === '"') {
      text += '"';
      i += 2;
    } else {
      return { text, next: i + 1 };
    }
  }
  return { text, next: i };
}

const isLineBreak = (ch) => ch === '\n' || ch === '\r';

/** How many characters the line break at `i` takes: two for CRLF, one otherwise. */
const lineBreakLength = (source, i) => (source[i] === '\r' && source[i + 1] === '\n' ? 2 : 1);

/**
 * One cell from `start`: its text, the index the next cell starts at, and
 * whether a line break (or the end of the text) rather than a comma ended it.
 */
function readCell(source, start) {
  let cell = '';
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      const quoted = readQuoted(source, i + 1);
      cell += quoted.text;
      i = quoted.next;
    } else if (ch === ',') {
      return { cell, next: i + 1, endsLine: false };
    } else if (isLineBreak(ch)) {
      return { cell, next: i + lineBreakLength(source, i), endsLine: true };
    } else {
      cell += ch;
      i += 1;
    }
  }
  return { cell, next: i, endsLine: true };
}

const isFilledRow = (cells) => cells.some((value) => value.trim() !== '');

/** Rows of cells from CSV text (RFC 4180: quoted cells, doubled quotes, CRLF); blank lines dropped. */
export function parseCsv(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let i = 0;
  while (i < source.length) {
    const { cell, next, endsLine } = readCell(source, i);
    row.push(cell);
    i = next;
    if (endsLine) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows.filter(isFilledRow);
}
