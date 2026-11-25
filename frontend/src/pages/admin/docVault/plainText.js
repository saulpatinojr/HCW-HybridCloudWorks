/**
 * "Copy as plain text" in the document vault: Markdown turned into the text a
 * person would have typed. Moved out of docVaultModel.js, which re-exports
 * `markdownToPlainText`, when that file grew too long.
 */

// ── copy as plain text ─────────────────────────────────────────────────────

import { stripInline } from './plainTextInline';

const isRule = (trimmed) => {
  if (trimmed.length < 3) return false;
  const [first] = trimmed;
  if (first !== '-' && first !== '*' && first !== '_') return false;
  return [...trimmed].every((char) => char === first || char === ' ');
};

/** A heading line ("## Title ##") as its words, or null when the line is not a heading. */
function stripHeading(text) {
  let hashes = 0;
  while (hashes < 6 && text[hashes] === '#') hashes += 1;
  if (hashes === 0 || (text[hashes] !== ' ' && text[hashes] !== '\t')) return null;
  const words = text.slice(hashes).trim();
  let end = words.length;
  while (end > 0 && words[end - 1] === '#') end -= 1;
  // A closing run of # counts only after a space: "C#" keeps its #.
  const closes = end < words.length && (end === 0 || words[end - 1] === ' ');
  return closes ? words.slice(0, end).trimEnd() : words;
}

/** A quoted line without its ">" marks. */
function stripQuote(text) {
  let rest = text;
  while (rest.startsWith('>')) rest = rest.slice(rest[1] === ' ' ? 2 : 1);
  return rest;
}

/** The heading marks, quote marks and list bullet at the start of a line, as plain text. */
function stripBlock(line) {
  const text = line.trimStart();
  const heading = stripHeading(text);
  if (heading !== null) return heading;
  if (text.startsWith('>')) return stripQuote(text);
  // A bullet keeps its indent, so a nested list stays nested.
  const indent = line.slice(0, line.length - text.length);
  if (/^[-*+] /.test(text)) return `${indent}- ${text.slice(2)}`;
  return line;
}

/** ``` or ~~~ when the line opens or closes a fenced code block, else null. */
function fenceMarker(trimmed) {
  if (trimmed.startsWith('```')) return '```';
  return trimmed.startsWith('~~~') ? '~~~' : null;
}

/**
 * Markdown as the plain text a person would have typed: no heading marks,
 * emphasis marks, code ticks or link syntax (a link keeps its address in
 * brackets after its words), lists kept as "- " lines, code blocks kept as
 * written. For pasting into a form or an email, where the marks would show.
 * Linear in the text; never throws.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToPlainText(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let fence = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const marker = fenceMarker(trimmed);
    if (fence) {
      if (marker === fence) fence = null;
      else out.push(raw);
    } else if (marker) {
      fence = marker;
    } else if (isRule(trimmed)) {
      out.push('');
    } else {
      out.push(stripInline(stripBlock(raw)).trimEnd());
    }
  }
  const squeezed = [];
  for (const line of out) {
    if (line === '' && squeezed[squeezed.length - 1] === '') continue;
    squeezed.push(line);
  }
  return squeezed.join('\n').trim();
}
