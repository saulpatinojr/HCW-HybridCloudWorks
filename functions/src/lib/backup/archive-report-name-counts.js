/**
 * archive-report-name-counts.js — bounded counters of field names for one
 * container's part of an archive dry-run report (ADR 0046, issue #1811).
 * Names and counts only, never a value. Used by archive-report-tally.js.
 */
import { MAX_TALLIED_NAMES } from './archive-report-base.js';
import { isPlainName } from './archive-report-fields.js';

/** Count one name into a bounded tally; false when the tally is full and the name is new. */
function tallyName(tally, name) {
  if (tally.has(name)) tally.set(name, tally.get(name) + 1);
  else if (tally.size < MAX_TALLIED_NAMES) tally.set(name, 1);
  else return false;
  return true;
}

export function noteSensitive(sensitive, names) {
  for (const name of names) {
    if (!isPlainName(name) || !tallyName(sensitive.tally, name)) sensitive.otherNames += 1;
  }
}

export function noteTakenOut(takenOut, names) {
  for (const name of names) {
    if (!isPlainName(name)) takenOut.notPlain += 1;
    else if (!tallyName(takenOut.tally, name)) takenOut.tooMany += 1;
  }
}

export function noteRemaining(remaining, fields, document) {
  for (const field of fields.values()) {
    // A name that is not plain may be an id or text someone typed: counted, never printed.
    if (!field.plain) {
      remaining.notPlain += 1;
      continue;
    }
    const entry = remainingEntry(remaining, field, document);
    if (!entry) {
      remaining.tooMany += 1;
      continue;
    }
    entry.records += 1;
    for (const [kind, n] of Object.entries(field.kinds)) entry.kinds[kind] = (entry.kinds[kind] || 0) + n;
  }
}

/** The entry for one place a name sits, made when new; null when the tally is full. */
function remainingEntry(remaining, field, document) {
  const key = `${document ?? ''}\u0000${field.path}`;
  const known = remaining.entries.get(key);
  if (known) return known;
  if (remaining.entries.size >= MAX_TALLIED_NAMES) return null;
  const entry = { document, path: field.path, name: field.name, records: 0, kinds: {} };
  remaining.entries.set(key, entry);
  return entry;
}
