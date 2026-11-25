/**
 * archive-report-tally.js — the counting behind one container's part of an
 * archive dry-run report (ADR 0046, issue #1811): which top-level names the
 * records carry, which names look sensitive, and which of those an archive
 * would take out or keep. Names and counts only, never a value. Used by
 * archive-report-worker.js; the dry run is described in archive-report.js.
 * The name counters are in archive-report-name-counts.js, and what the part
 * says once every record is counted is in archive-report-summary.js.
 */
import { REASONS, archiveDocumentLabel, archiveRecord } from './archive-classification.js';
import { MAX_TALLIED_NAMES, bump } from './archive-report-base.js';
import { isPlainName, sensitiveFieldsIn } from './archive-report-fields.js';
import { noteRemaining, noteSensitive, noteTakenOut } from './archive-report-name-counts.js';

/** A fresh set of counts for one container. */
export function newTallies() {
  return {
    // Plain top-level names → records that carry each. Bounded (MAX_TALLIED_NAMES).
    tally: new Map(),
    nameUses: 0,
    // Names that look sensitive, at any depth, in the records as read.
    sensitive: { records: 0, keptRecords: 0, cutShort: 0, tally: new Map(), otherNames: 0 },
    // The same names, split by what happens to them: taken out before
    // archiving, or still there in what an archive would keep.
    takenOut: { tally: new Map(), notPlain: 0, tooMany: 0 },
    remaining: { entries: new Map(), notPlain: 0, tooMany: 0 },
  };
}

const namesOf = (fields) => new Set([...fields.values()].map((field) => field.name));

/** Count the plain top-level names of one record, and search it for sensitive names. */
function noteRecordNames(state, doc) {
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) continue; // the database's own fields (_ts, _etag, _rid)
    state.nameUses += 1;
    if (!isPlainName(key)) continue;
    if (state.tally.has(key)) state.tally.set(key, state.tally.get(key) + 1);
    else if (state.tally.size < MAX_TALLIED_NAMES) state.tally.set(key, 1);
  }
  const found = sensitiveFieldsIn(doc);
  if (found.cutShort) state.sensitive.cutShort += 1;
  if (found.fields.size) {
    state.sensitive.records += 1;
    noteSensitive(state.sensitive, namesOf(found.fields));
  }
  return found;
}

const isPlainObject = (doc) => doc && typeof doc === 'object' && !Array.isArray(doc);

/**
 * Count one record into `part` and `state`: what an archive would do with it,
 * and which sensitive names it carries before and after.
 */
export function noteRecord(state, part, { container, doc, contentIndex }) {
  part.read += 1;
  if (doc === undefined) {
    part.unreadable += 1;
    return;
  }
  const found = isPlainObject(doc) ? noteRecordNames(state, doc) : null;
  const result = archiveRecord(container, doc, { contentIndex });
  // The same question about what an archive would actually keep.
  const kept = keptFields(result, doc, found);
  if (kept?.fields.size) {
    state.sensitive.keptRecords += 1;
    noteRemaining(state.remaining, kept.fields, archiveDocumentLabel(container, doc?.id));
  }
  if (found?.fields.size) {
    // Taken out: a name the record carried that what is kept no longer carries.
    const still = kept ? namesOf(kept.fields) : new Set();
    noteTakenOut(state.takenOut, [...namesOf(found.fields)].filter((name) => !still.has(name)));
  }
  countResult(part, result);
}

/** The sensitive fields of what an archive would keep of a record, or null when it is left out. */
function keptFields(result, doc, found) {
  if (!result.keep) return null;
  return result.doc === doc && found ? found : sensitiveFieldsIn(result.doc);
}

function countResult(part, result) {
  if (!result.keep) {
    part.leftOut += 1;
    bump(part.leftOutBy, result.reason || REASONS.unlisted);
    return;
  }
  part.kept += 1;
  if (result.removed.length) {
    part.changed += 1;
    for (const field of result.removed) bump(part.removed, field);
  }
}
