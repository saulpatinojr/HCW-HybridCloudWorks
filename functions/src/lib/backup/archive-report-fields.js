/**
 * archive-report-fields.js — which field names the archive dry run may print,
 * and which names look like a secret or someone's contact details
 * (ADR 0046, issue #1811). Re-exported by archive-report.js, which describes
 * the dry run.
 */
import { looksSensitive } from './archive-classification.js';
import {
  MAX_FIELD_NAMES,
  MAX_NAME_LENGTH,
  MIN_NAME_RECORDS,
  MIN_NAME_SHARE,
  SENSITIVE_MAX_DEPTH,
  SENSITIVE_MAX_NODES,
  count,
} from './archive-report-base.js';

// ── Which field names may be printed ─────────────────────────────────────────

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
const HEX_RUN = /[0-9a-f]{12,}/i;

/**
 * Is this name PLAIN: one that reads like a field a programmer named, not
 * like an id, an address or text someone typed? All of these must hold:
 *
 *   - it starts with a letter and holds only letters, digits, `_` and `-`
 *     (so no `@`, no space and no dot: `jane.doe` and `a@b.c` are out);
 *   - it is at most MAX_NAME_LENGTH characters;
 *   - it has no run of four or more digits (`user_12345` is out);
 *   - it is not shaped like a UUID and has no long run of hex characters.
 *
 * @param {unknown} name
 */
export function isPlainName(name) {
  return isShortWord(name) && !looksLikeAnId(name);
}

const isShortWord = (name) => typeof name === 'string' && name.length <= MAX_NAME_LENGTH && /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
const looksLikeAnId = (name) => /\d{4,}/.test(name) || UUID_SHAPE.test(name) || HEX_RUN.test(name);

/** How many records must carry a name before it is printed, for a container of `read` records. */
export function nameThreshold(read) {
  return Math.max(MIN_NAME_RECORDS, Math.ceil(count(read) * MIN_NAME_SHARE));
}

/**
 * The names to print from a tally of plain names, most common first, then
 * by name. A name is printed only when it is COMMON: at least
 * MIN_NAME_RECORDS records carry it, and at least 1 in 100 of the
 * container's records. So a container with one record prints no name at
 * all, and a name only one visitor's record has is never printed.
 *
 * @param {Map<string, number>} tally - plain name → records that carry it
 * @param {number} read - records read
 * @param {number} [limit]
 * @returns {{ names: { name: string, records: number }[], truncated: boolean }}
 */
export function listableNames(tally, read, limit = MAX_FIELD_NAMES) {
  const least = nameThreshold(read);
  const common = [...tally]
    .filter(([, records]) => records >= least)
    .map(([name, records]) => ({ name, records }))
    .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
  return { names: common.slice(0, limit), truncated: common.length > limit };
}

/**
 * Walk one record's objects and lists, at any depth, bounded like the two
 * searches below: past SENSITIVE_MAX_DEPTH or SENSITIVE_MAX_NODES the walk
 * stops and answers `true` (cut short). `onField(key, inner, above)` is
 * called for each field of an object and answers the path to carry below it;
 * a position in a list adds no part.
 */
function walkBounded(doc, onField) {
  const walk = { nodes: 0, cutShort: false, stack: [[doc, 0, '']] };
  while (walk.stack.length) {
    const [value, depth, above] = walk.stack.pop();
    if (!visitable(walk, value, depth)) continue;
    for (const [inner, path] of childrenOf(value, above, onField)) pushChild(walk, inner, depth + 1, path);
  }
  return walk.cutShort;
}

/** Count a popped value as one node; false when it is not an object or a list, or the walk is past its bounds. */
function visitable(walk, value, depth) {
  if (value === null || typeof value !== 'object') return false;
  walk.nodes += 1;
  if (depth > SENSITIVE_MAX_DEPTH || walk.nodes > SENSITIVE_MAX_NODES) {
    walk.cutShort = true;
    return false;
  }
  return true;
}

/** Queue a child object or list to be walked, unless the queue is full. */
function pushChild(walk, inner, depth, path) {
  if (inner === null || typeof inner !== 'object') return;
  if (walk.stack.length >= SENSITIVE_MAX_NODES) walk.cutShort = true;
  else walk.stack.push([inner, depth, path]);
}

/** `[inner, path]` for each child of an object or list. */
function childrenOf(value, above, onField) {
  if (Array.isArray(value)) return value.map((item) => [item, above]);
  return Object.entries(value).map(([key, inner]) => [inner, onField(key, inner, above)]);
}

/**
 * The names in one record, at any depth, that look like a secret or
 * someone's contact details (archive-classification.js looksSensitive).
 * Names only: a value is never read, copied or returned. Bounded, so one
 * huge record cannot hold a job: past the depth or the size limit the search
 * stops and says so.
 *
 * @param {unknown} doc
 * @returns {{ names: Set<string>, cutShort: boolean }}
 */
export function sensitiveNamesIn(doc) {
  const names = new Set();
  const cutShort = walkBounded(doc, (key) => {
    if (looksSensitive(key)) names.add(key);
    return '';
  });
  return { names, cutShort };
}

/** What a path shows in place of a field name that is not plain (it may be an id). */
export const ID_PART = '(id)';

/** The kinds of value the report tells apart. Words, never the value. */
export const VALUE_KINDS = Object.freeze(['number', 'yes-no', 'date', 'short-text', 'long-text', 'list', 'object', 'empty']);
/** Text shorter than this is "short text". A key or a token is usually shorter; a paragraph is longer. */
export const SHORT_TEXT_LENGTH = 64;
/** A field whose every value is one of these cannot hold a secret or an address: a count, or a yes/no. */
export const HARMLESS_KINDS = new Set(['number', 'yes-no']);

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** The kind of a value of these types, by `typeof`. */
const KIND_BY_TYPE = new Map([
  ['number', 'number'],
  ['bigint', 'number'],
  ['boolean', 'yes-no'],
]);

/**
 * The kind of one value: `number`, `yes-no` (true or false), `date` (text
 * shaped like a date or a date and time), `short-text` (under
 * SHORT_TEXT_LENGTH characters), `long-text`, `list`, `object` or `empty`
 * (null, or text with nothing in it). The value itself is never returned.
 * @param {unknown} value
 */
export function valueKind(value) {
  if (value === null || value === undefined || value === '') return 'empty';
  if (KIND_BY_TYPE.has(typeof value)) return KIND_BY_TYPE.get(typeof value);
  if (typeof value === 'object') return Array.isArray(value) ? 'list' : 'object';
  if (typeof value !== 'string') return 'empty';
  return textKind(value);
}

function textKind(text) {
  if (DATE_LIKE.test(text)) return 'date';
  return text.length < SHORT_TEXT_LENGTH ? 'short-text' : 'long-text';
}

/**
 * Every field in one record, at any depth, whose name looks like a secret or
 * someone's contact details: where it sits and what kind of value it holds.
 *
 * `path` is the names of the fields above it and its own name, joined with
 * dots (`speakerProfile.email`). A part that is not a plain name
 * (`isPlainName`) shows as `(id)`, because a field name can itself be an id.
 * A position in a list adds no part. `plain` says whether the field's own
 * name may be printed. Bounded like `sensitiveNamesIn`.
 *
 * @param {unknown} doc
 * @returns {{ fields: Map<string, { name: string, path: string, plain: boolean, kinds: Record<string, number> }>, cutShort: boolean }}
 */
export function sensitiveFieldsIn(doc) {
  const fields = new Map();
  const cutShort = walkBounded(doc, (key, inner, above) => {
    const plain = isPlainName(key);
    const path = `${above ? `${above}.` : ''}${plain ? key : ID_PART}`;
    if (looksSensitive(key)) {
      const field = fields.get(path) || { name: key, path, plain, kinds: {} };
      const kind = valueKind(inner);
      field.kinds[kind] = (field.kinds[kind] || 0) + 1;
      fields.set(path, field);
    }
    return path;
  });
  return { fields, cutShort };
}
