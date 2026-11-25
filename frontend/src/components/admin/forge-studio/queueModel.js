/**
 * The Forge Studio Queue as the page holds it (owner request 2026-10-06),
 * pure: the editable "From a URL" fields, a form from one entry or from
 * several at once (a field is shown when every selected entry agrees), the
 * payload a save sends, and the words an entry's status gets.
 */
import { statusTable } from '@/lib/status';
import { EMPTY_BRIEF, splitList } from './brief';

/** The brief fields a queue entry carries, in the order the editor shows them. */
export const QUEUE_FIELDS = Object.freeze([
  'objective',
  'audience',
  'keyMessage',
  'tone',
  'readingLevel',
  'targetLength',
  'requiredTopics',
  'prohibitedTopics',
  'callsToAction',
  'sources',
  'targetChannel',
  'campaign',
  'seoKeywords',
]);

/** The fields a stored entry keeps as lists; the form holds them as one-per-line text. */
const LIST_FIELDS = new Set([
  'requiredTopics',
  'prohibitedTopics',
  'callsToAction',
  'sources',
  'seoKeywords',
]);

export const QUEUE_STATUS = statusTable({
  queued: ['Queued', 'muted', 'Waiting for its fields and a Save.'],
  forging: ['Forging', 'warn', 'The forge job is scraping and writing. A few minutes.'],
  forged: ['Forged', 'ok', 'The draft is written; open it from here.'],
  failed: ['Failed', 'error', 'The job reported an error; Save again re-queues it.'],
});

export const statusOf = (entry) => QUEUE_STATUS[entry?.status] || QUEUE_STATUS.queued;

/** An empty editor form: every field as the input shows it, plus kind. */
export const EMPTY_QUEUE_FORM = Object.freeze({
  kind: '',
  ...Object.fromEntries(QUEUE_FIELDS.map((field) => [field, EMPTY_BRIEF[field] ?? ''])),
  targetChannel: '',
});

const asText = (field, value) => {
  if (value === null || value === undefined) return '';
  if (LIST_FIELDS.has(field)) return (Array.isArray(value) ? value : splitList(value)).join('\n');
  return String(value);
};

/** One entry's fields as the form holds them. */
export function formFromEntry(entry) {
  const brief = entry?.brief || {};
  const form = { ...EMPTY_QUEUE_FORM, kind: entry?.kind || '' };
  for (const field of QUEUE_FIELDS) form[field] = asText(field, brief[field]);
  return form;
}

/**
 * Several entries at once: a field shows a value only when every entry has
 * that same value, else '' — the bulk editor's "leave as is".
 */
export function sharedForm(entries) {
  if (!entries?.length) return { ...EMPTY_QUEUE_FORM };
  const forms = entries.map(formFromEntry);
  const shared = { ...EMPTY_QUEUE_FORM };
  for (const key of Object.keys(shared)) {
    const first = forms[0][key];
    shared[key] = forms.every((form) => form[key] === first) ? first : '';
  }
  return shared;
}

/**
 * What a save sends. For one entry every field goes (so a cleared field
 * clears); for several only the filled ones go, because blank means "leave
 * each entry's own value". Lists travel as arrays.
 */
export function fieldsPayload(form, { onlyFilled = false } = {}) {
  const fields = {};
  for (const field of QUEUE_FIELDS) {
    const raw = form[field];
    const text = String(raw ?? '').trim();
    if (onlyFilled && !text) continue;
    fields[field] = LIST_FIELDS.has(field) ? [...new Set(splitList(raw))] : text;
  }
  const kind = String(form.kind ?? '').trim();
  if (kind || !onlyFilled) fields.kind = kind;
  return fields;
}

/** Does the entry's brief say anything a drafter could work from (beyond its URL)? */
const SUBSTANCE_TEXT = ['objective', 'keyMessage', 'audience'];
const SUBSTANCE_LISTS = ['requiredTopics', 'sources'];

export function entryHasFields(entry) {
  const brief = entry?.brief || {};
  const hasText = SUBSTANCE_TEXT.some((field) => Boolean(brief[field]));
  const hasList = SUBSTANCE_LISTS.some((field) => (brief[field] || []).length > 0);
  return hasText || hasList;
}

/** The one-line summary under an entry: what is filled, or that nothing is. */
export function describeEntry(entry) {
  const brief = entry?.brief || {};
  const parts = [];
  if (entry?.kind) parts.push(entry.kind);
  if (brief.targetChannel) parts.push(`→ ${brief.targetChannel}`);
  if (brief.objective)
    parts.push(brief.objective.length > 60 ? `${brief.objective.slice(0, 57)}…` : brief.objective);
  if (brief.tone) parts.push(brief.tone);
  if (brief.targetLength) parts.push(`${brief.targetLength} words`);
  return parts.length ? parts.join(' · ') : 'No fields yet';
}

/** The selection after toggling one id. */
export function toggleId(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The entries a save may act on: not mid-job. */
export const editable = (entry) => entry?.status !== 'forging';
