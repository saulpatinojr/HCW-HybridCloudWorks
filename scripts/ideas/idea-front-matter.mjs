/** Reading an idea note's front matter (the block of key: value lines at its top) line by line (idea-notes.mjs). */
import { KNOWN_KEYS } from './idea-rules.mjs';
import { fieldFrom } from './idea-fields.mjs';

export function unquote(raw) {
  const text = String(raw ?? '').trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length > 1) {
    const close = text.indexOf(quote, 1);
    if (close > 0) return text.slice(1, close);
  }
  return text.split(' #')[0].trim();
}

export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The properties block of a note and the text after it.
 *
 * `fields` is null when the note does not open with a closed block. Each field
 * is `{ key, line, kind: 'scalar'|'list'|'empty', value, items }`, with `line`
 * counted from 1 in the file. `problems` are lines the reader could not
 * understand inside a key it needs.
 *
 * @param {string} text
 */
export function parseNote(text) {
  const source = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  if (lines[0].trimEnd() !== '---') {
    return { fields: null, unclosed: false, problems: [], body: source, bodyLine: 1 };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end === -1) {
    return { fields: null, unclosed: true, problems: [], body: source, bodyLine: 1 };
  }

  const fields = new Map();
  const problems = [];
  let current = null;
  for (let index = 1; index < end; index += 1) {
    current = readPropertyLine(lines[index].trimEnd(), index + 1, { current, fields, problems });
  }

  return {
    fields,
    unclosed: false,
    problems,
    body: lines.slice(end + 1).join('\n'),
    bodyLine: end + 2,
  };
}

/**
 * One line of the properties block, onto `fields` or `problems`. Returns the
 * field that list items and continued lines below it belong to.
 */
function readPropertyLine(raw, line, { current, fields, problems }) {
  if (!raw.trim() || raw.trimStart().startsWith('#')) return current;

  const item = /^\s*-\s+(.*)$/.exec(raw) ?? /^\s*-$/.exec(raw);
  if (item && current) {
    current.kind = 'list';
    const value = unquote(item[1] ?? '');
    if (value) current.items.push(value);
    return current;
  }

  // Obsidian allows any text as a property name ("date created", "année"), so
  // take everything up to the first colon that is followed by a space or the
  // end of the line. Keys the format does not name are ignored, whatever they say.
  const entry = /^([^\s:#'"[-][^:]*?):(?:[ \t]+(.*))?$/.exec(raw);
  if (!entry) return unreadablePropertyLine(raw, line, current, problems);

  const field = fieldFrom(entry[1].trim(), (entry[2] ?? '').trim(), line);
  if (fields.has(field.key)) {
    problems.push({ line, field: field.key, message: `${field.key} is written twice` });
  } else {
    fields.set(field.key, field);
  }
  return field;
}

/**
 * A line that is not `name: value`: an indented line goes on from the field
 * above it (a problem only for a key the format reads); anything else is a
 * problem, and ends that field.
 */
function unreadablePropertyLine(raw, line, current, problems) {
  if (/^\s/.test(raw) && current) {
    if (KNOWN_KEYS.includes(current.key)) {
      problems.push({
        line,
        field: current.key,
        message: `${current.key} must fit on one line`,
      });
    }
    return current;
  }
  problems.push({
    line,
    field: null,
    message: `cannot read this line of the properties; write it as name: value`,
  });
  return null;
}
