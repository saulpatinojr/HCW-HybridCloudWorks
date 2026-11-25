/**
 * archive-report-summary.js — what one container's part of an archive
 * dry-run report says once every record is counted (ADR 0046, issue #1811):
 * the printable field names, and the `sensitive` block. Names and counts
 * only, never a value. Used by archive-report-worker.js.
 */
import { MAX_SENSITIVE_NAMES } from './archive-report-base.js';
import { HARMLESS_KINDS, listableNames } from './archive-report-fields.js';

/** Field names, for every container read: only the common, plain ones (listableNames). */
export function fieldNameSummary(state, read) {
  const listed = listableNames(state.tally, read);
  return {
    fieldNames: listed.names,
    fieldNamesTruncated: listed.truncated,
    // How many times a field was met whose name is not printed above.
    otherNames: state.nameUses - listed.names.reduce((n, field) => n + field.records, 0),
  };
}

const byRecordsThenName = (a, b) => b.records - a.records || a.name.localeCompare(b.name);

/** The part's `sensitive` block. `onPurpose` is SENSITIVE_KEPT_ON_PURPOSE for the container. */
export function sensitiveSummary(state, onPurpose) {
  const { sensitive, takenOut, remaining } = state;
  // Names that look like a secret or contact details. They come from a
  // fixed word list, so one record is enough to print a name, but the name
  // still has to be plain (an id that happens to contain "token" is only counted).
  const sensitiveNames = [...sensitive.tally].map(([name, records]) => ({ name, records })).sort(byRecordsThenName);
  const remainingList = remainingRows(remaining, onPurpose);
  return {
    records: sensitive.records,
    keptRecords: sensitive.keptRecords,
    // The names as read, before anything is taken out (what earlier reports listed).
    names: sensitiveNames.slice(0, MAX_SENSITIVE_NAMES),
    namesNotShown: sensitive.otherNames + Math.max(0, sensitiveNames.length - MAX_SENSITIVE_NAMES),
    // Taken out before archiving: the record is left out, or the field is dropped.
    takenOut: [...takenOut.tally].map(([name, records]) => ({ name, records })).sort(byRecordsThenName),
    // Uses of a name that is not printed, and why: it is shaped like an id
    // or typed text (`notPlain`), or the container has more different
    // names than one report tallies (`tooMany`).
    takenOutNotShown: { notPlain: takenOut.notPlain, tooMany: takenOut.tooMany },
    remaining: remainingList,
    remainingNotShown: { notPlain: remaining.notPlain, tooMany: remaining.tooMany },
    // What the red block is driven by: names that would remain and are not
    // explained, plus any that would remain and cannot be printed.
    flagged: remainingList.filter((entry) => entry.flagged).length + (remaining.notPlain || remaining.tooMany ? 1 : 0),
    cutShort: sensitive.cutShort,
  };
}

/**
 * What would remain, one line per place a name sits. `quiet`: every value
 * seen was a number or true/false (a token COUNT, an "email verified"
 * switch), so it cannot be a secret or an address. `keptOnPurpose`: the
 * classification keeps it deliberately and says why. Neither is flagged.
 */
function remainingRows(remaining, onPurpose) {
  return [...remaining.entries.values()]
    .map((entry) => {
      const kinds = Object.keys(entry.kinds).filter((kind) => kind !== 'empty');
      const quiet = kinds.length > 0 && kinds.every((kind) => HARMLESS_KINDS.has(kind));
      const keptOnPurpose = entry.path === entry.name && Object.hasOwn(onPurpose, entry.name) ? onPurpose[entry.name] : null;
      return { ...entry, quiet, keptOnPurpose, flagged: !quiet && !keptOnPurpose };
    })
    .sort(byFlaggedThenRecords);
}

const byFlaggedThenRecords = (a, b) =>
  Number(b.flagged) - Number(a.flagged) || b.records - a.records || a.path.localeCompare(b.path) || String(a.document).localeCompare(String(b.document));
