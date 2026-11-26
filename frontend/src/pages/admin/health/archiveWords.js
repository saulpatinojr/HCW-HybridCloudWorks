/**
 * The Archive card's plain words: what stands in the way of an archive, why a
 * record was left out, sizes, and the sentences about field names that look
 * sensitive. Pure functions, no React. Moved out of ArchiveCard.jsx, which
 * re-exports the ones its tests read, when that file grew too long.
 */

/** Each thing that can stand in the way of an archive starting, in plain words. */
const BLOCKERS = Object.freeze({
  'switch-off': 'the switch is off',
  'export-off':
    'the nightly export is off (the archive is made from its weekly backup, and its timer makes the daily check)',
  'before-1-february': 'it is still January, the month of grace',
  'already-archived': 'that year is already archived',
  'archive-container-missing':
    'the archive’s storage container does not exist yet (the Terraform run that creates it has not been confirmed)',
  'archive-not-readable': 'the archive’s storage container could not be read just now',
  'no-backup': 'no complete weekly full backup was found in the last 35 days',
  'backup-too-early': 'the newest complete weekly backup is from before 2 February',
  // An archive never starts from a state no finished dry-run report describes.
  'report-missing':
    'no dry run has been made yet (the daily check starts one by itself when that is all that is missing)',
  'report-running': 'a dry run is still reading the backup',
  'report-stalled':
    'the newest dry run did not finish (the daily check starts a new one when that is all that is missing)',
  'report-older-than-backup':
    'the newest dry-run report was made from an older backup than the one an archive would read (the daily check starts a new one when that is all that is missing)',
  'report-older-rules':
    'the newest dry-run report was made before the list of what is kept last changed (the daily check starts a new one when that is all that is missing)',
  'report-incomplete':
    'the newest dry-run report does not cover every container an archive would write (the daily check starts a new one when that is all that is missing)',
  'report-cut-short':
    'the newest dry-run report met a record too large to search whole for names that look like a secret, so it cannot vouch for that container',
  'report-mismatch':
    'the newest dry-run report counted a different number of records than the backup’s own list, or met a line it could not read',
  'report-flagged':
    'the newest dry-run report shows a field to look at in a container nobody has decided about (the red block below)',
  'report-waiting': 'the newest dry-run report shows a container waiting for you',
});

/** Why a record or a container is left out, in plain words. */
export const REASONS = Object.freeze({
  promise: 'a promise limits keeping it',
  secret: 'it is a secret',
  'access-list': 'it is the access list',
  derived: 'a job rebuilds it',
  'working-state': 'short-lived working state',
  unclassified: 'not classified yet',
  unlisted: 'a document the list does not name',
  orphan: 'its content item is not in the backup',
});

/** The entries of the status route's cut-short list that name a container. */
const namedCutShort = (cutShort) =>
  (Array.isArray(cutShort) ? cutShort : []).filter(
    (entry) => entry && typeof entry.container === 'string'
  );

/**
 * Which containers had a record too large to search whole, and how many:
 * `in content (1 record) and designs (2 records)`. Container names and
 * counts only; the server never sends a record id. Empty for none.
 */
export function cutShortWords(cutShort = []) {
  const parts = namedCutShort(cutShort).map(
    (entry) =>
      `${entry.container} (${number(entry.records)} record${entry.records === 1 ? '' : 's'})`
  );
  if (!parts.length) return '';
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `in ${list}`;
}

/** One blocker in words; `report-cut-short` names its containers when the status says which. */
function blockerWords(code, details) {
  if (code !== 'report-cut-short') return BLOCKERS[code] || code;
  const where = cutShortWords(details.cutShort);
  if (!where) return BLOCKERS[code];
  const several = namedCutShort(details.cutShort).length > 1;
  return `the newest dry-run report met a record too large to search whole for names that look like a secret ${where}, so it cannot vouch for ${several ? 'those containers' : 'that container'}`;
}

/**
 * Every blocker in words, joined. `details.cutShort` is the status route's
 * list of containers behind `report-cut-short` (`[{ container, records }]`).
 */
export const blockerSentence = (blockers = [], details = {}) =>
  blockers.map((code) => blockerWords(code, details || {})).join('; ');

export const reasonWords = (leftOutBy = {}) =>
  Object.entries(leftOutBy)
    .map(([reason, n]) => `${n} ${REASONS[reason] || reason}`)
    .join(', ');

/**
 * true: written; false: not written; anything else: not known. A container
 * that does not exist yet is "not known", never "not written": nothing was
 * looked at, so nothing can be said about the year.
 */
export function yearState(archived, containerExists) {
  if (containerExists === false) return 'Not known: no container yet';
  if (archived === true) return 'Written';
  if (archived === false) return 'Not written';
  return 'Not known';
}

export const number = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '0');

/** A size in plain words: "512 bytes", "1.5 MB". */
export function sizeWords(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size';
  if (bytes < 1024) return `${number(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * "3 records have a field named like a secret: apiKey, token". Names only;
 * the server never sends a value.
 */
export function sensitiveSentence(sensitive) {
  if (!sensitive?.records) return '';
  const names = (sensitive.names || []).map((field) => field.name);
  const hidden = sensitive.namesNotShown
    ? `${names.length ? ', and ' : ''}${number(sensitive.namesNotShown)} not shown`
    : '';
  const kept =
    sensitive.keptRecords > 0
      ? ` ${number(sensitive.keptRecords)} of them would still carry one in the archive.`
      : ' None of those names would be in the archive.';
  return `${number(sensitive.records)} record(s) have a field named like a secret or contact details: ${names.join(', ')}${hidden}.${kept}`;
}

/** The kinds of value the report tells apart, in plain words. */
const KIND_WORDS = Object.freeze({
  number: 'number',
  'yes-no': 'true/false',
  date: 'date-like text',
  'short-text': 'short text (under 64 characters)',
  'long-text': 'long text',
  list: 'list',
  object: 'object',
  empty: 'empty',
});

/** "short text (under 64 characters) ×12, empty ×1": the kinds of value seen, as counts. */
export const kindWords = (kinds = {}) =>
  Object.entries(kinds)
    .map(([kind, n]) => `${KIND_WORDS[kind] || kind} ×${number(n)}`)
    .join(', ');

/** "credential_register › rotated.some-name" or just the path. */
export const whereWords = (entry) =>
  entry.document ? `${entry.document} › ${entry.path}` : entry.path;

/** Why some names are counted and not printed. Empty when none are. */
export function notShownWords(notShown = {}) {
  const parts = [];
  if (notShown.notPlain)
    parts.push(
      `${number(notShown.notPlain)} more use(s) of a name that is not shown because it is shaped like an id or typed text`
    );
  if (notShown.tooMany)
    parts.push(
      `${number(notShown.tooMany)} more use(s) not listed because this container has more than 2,000 different such names`
    );
  return parts.join('; ');
}

/** True when this container has a name that would remain and is not explained. */
export const isFlagged = (part) =>
  part?.sensitive?.remaining
    ? part.sensitive.flagged > 0
    : // A report made before the lists were split says only how many kept records carry one.
      part?.sensitive?.keptRecords > 0;
