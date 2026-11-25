/**
 * selection.js — the selection document, `admin_settings/ai-routing` version 2
 * (ADR 0034 §2, slice 3, #858).
 *
 *   {
 *     id: 'ai-routing', version: 2,
 *     global: { priority: [{ provider, model|null }, …] },
 *     tasks: { <task>: { mode: 'recommended'|'global'|'custom',
 *                        chain?: [{ provider, model|null }], thenGlobal?: boolean,
 *                        exclude?: string[] } },
 *     updatedAt, updatedBy
 *   }
 *
 * `global.priority` is the Priority 1, 2, 3 … list; `tasks` holds only the
 * tasks an administrator touched, and a task absent from it is `global`.
 * `chain` exists only for `custom`; `thenGlobal` (default true) says the
 * global list follows the chain; `exclude` names providers that never serve
 * the task whatever the mode says — the administrator's "off" for one task,
 * kept apart from the code-level locks in select.js, which no document lifts.
 *
 * Two readers, two strictnesses, the rule routing-table.js set for v1:
 *
 *   normalizeSelection DROPS what it cannot use — an unknown provider, an
 *   unknown task, a duplicate — so a stored oddity never breaks a call.
 *   validateSelection NAMES the mistake, so a save never stores one.
 *
 * The v1 document (`{ routes }`, ADR 0033 §4) is migrated to this shape in
 * memory on every read and on disk at the first save: migrate-selection.js.
 *
 * TWO PROVIDER LISTS (ADR 0034 slice 5, #860). `global.priority` names chat
 * providers only (DEFAULT_PROVIDER_ORDER): it is the list the text router
 * fails over along, and a media provider in it would be a step that answers
 * no chat call. A task's `chain` and `exclude` may name any provider the
 * resolver knows (KNOWN_PROVIDERS, the media providers included), and a
 * chain step must name a provider that can carry the task's `needs`
 * (PROVIDER_CAPABILITIES): ElevenLabs for a speech task, never for a
 * drafting one. normalizeSelection drops a step that cannot; validateSelection
 * names it.
 */
import { DEFAULT_PROVIDER_ORDER, KNOWN_PROVIDERS, providerCarries } from './provider-order.js';
import { AI_TASKS, TASK_NAMES } from './tasks.js';
import { selectChain } from './select.js';
import {
  MAX_CHAIN_LENGTH,
  SELECTION_MODES,
  SELECTION_VERSION,
  cleanProvider,
  isChatProvider,
  isKnownProvider,
  isPlainObject,
  normalizeSelection,
} from './selection-normalize.js';

export {
  MAX_CHAIN_LENGTH,
  SELECTION_MODES,
  SELECTION_VERSION,
  isSelectionV2,
  normalizeSelection,
  normalizeSteps,
} from './selection-normalize.js';

const PROVIDERS_SENTENCE = `one of ${KNOWN_PROVIDERS.join(', ')}`;
const CHAT_PROVIDERS_SENTENCE = `one of ${DEFAULT_PROVIDER_ORDER.join(', ')} (the Priority list is the chat list; a media provider is named in a task's chain)`;

/** The Priority list's provider rule: a chat provider (header). */
const priorityProviderError = (at, provider) =>
  isChatProvider(provider) ? null : `${at}.provider must be ${CHAT_PROVIDERS_SENTENCE}`;

/** A chain step's provider rule for `task`: known, and able to carry the task's needs (header). */
const chainProviderError = (task) => (at, provider) => {
  if (!isKnownProvider(provider)) return `${at}.provider must be ${PROVIDERS_SENTENCE}`;
  const needs = AI_TASKS[task]?.needs || [];
  return providerCarries(provider, needs)
    ? null
    : `${at}.provider: ${provider} cannot carry ${needs.join(', ')} (${AI_TASKS[task].label} needs it)`;
};

/**
 * Errors in a list of steps, each sentence prefixed with `where`;
 * `providerError(at, provider)` is the list's own provider rule.
 */
function stepErrors(where, raw, limit, providerError) {
  if (!Array.isArray(raw)) return [`${where} must be an array of { provider, model? }`];
  const errors = [];
  if (raw.length > limit) errors.push(`${where}: at most ${limit} entries`);
  const seen = new Set();
  raw.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} must be { provider, model? }`);
      return;
    }
    const provider = cleanProvider(entry.provider);
    const refused = providerError(at, provider);
    if (refused) {
      errors.push(refused);
      return;
    }
    if (seen.has(provider)) errors.push(`${at}: ${provider} is listed twice`);
    seen.add(provider);
    if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
      errors.push(`${at}.model must be a string or null`);
    }
  });
  return errors;
}

/** The mode rule of one task's entry: an error, or null. */
const modeError = (where, raw) =>
  SELECTION_MODES.includes(raw.mode)
    ? null
    : `${where}.mode must be one of ${SELECTION_MODES.join(', ')}`;

/** The chain rule: present only for `custom`, required for it, and well-formed. */
function chainErrors(where, raw, task) {
  if (raw.chain === undefined) {
    return raw.mode === 'custom' ? [`${where}.chain is required for mode custom`] : [];
  }
  if (raw.mode !== 'custom') return [`${where}.chain is only for mode custom`];
  return stepErrors(`${where}.chain`, raw.chain, MAX_CHAIN_LENGTH, chainProviderError(task));
}

/** The thenGlobal rule: absent or a boolean. */
const thenGlobalError = (where, raw) =>
  raw.thenGlobal === undefined || typeof raw.thenGlobal === 'boolean'
    ? null
    : `${where}.thenGlobal must be a boolean`;

/** The exclude rule: absent, or an array of known providers. */
function excludeErrors(where, raw) {
  if (raw.exclude === undefined) return [];
  if (!Array.isArray(raw.exclude)) return [`${where}.exclude must be an array of providers`];
  return raw.exclude
    .filter((entry) => !isKnownProvider(cleanProvider(entry)))
    .map((entry) => `${where}.exclude: unknown provider "${entry ?? ''}"`);
}

/** Errors in one task's entry: each rule's, in the order the shape reads. */
function taskErrors(task, raw) {
  const where = `tasks.${task}`;
  if (!isPlainObject(raw)) return [`${where} must be { mode, chain?, thenGlobal?, exclude? }`];
  return [
    modeError(where, raw),
    ...chainErrors(where, raw, task),
    thenGlobalError(where, raw),
    ...excludeErrors(where, raw),
  ].filter(Boolean);
}

/** The version rule: an error, or null. */
const versionError = (doc) =>
  doc.version === SELECTION_VERSION ? null : `version must be ${SELECTION_VERSION}`;

/** The Priority list's rules: an object, well-formed steps, at least one. */
function globalErrors(doc) {
  if (!isPlainObject(doc.global)) return ['global must be { priority: [{ provider, model? }] }'];
  const priority = stepErrors('global.priority', doc.global.priority, Infinity, priorityProviderError);
  if (!priority.length && doc.global.priority.length === 0) {
    return ['global.priority needs at least one provider'];
  }
  return priority;
}

/** The tasks' rules: an object of known tasks, each entry checked by taskErrors. */
function tasksErrors(doc) {
  if (doc.tasks !== undefined && !isPlainObject(doc.tasks)) return ['tasks must be an object'];
  return Object.entries(doc.tasks || {}).flatMap(([task, raw]) =>
    TASK_NAMES.includes(task)
      ? taskErrors(task, raw)
      : [`Unknown AI task: ${task}. Known: ${TASK_NAMES.join(', ')}`]
  );
}

/** The updatedAt rule: absent, null or a string. */
const updatedAtError = (doc) =>
  doc.updatedAt === undefined || doc.updatedAt === null || typeof doc.updatedAt === 'string'
    ? null
    : 'updatedAt must be a string or null';

/** Every shape error, in the order the document reads: version, global, tasks, updatedAt. */
function shapeErrors(doc) {
  return [versionError(doc), ...globalErrors(doc), ...tasksErrors(doc), updatedAtError(doc)].filter(
    Boolean
  );
}

/**
 * §6's first rule, the one that needs more than the document: a `custom`
 * chain with no eligible candidate and `thenGlobal: false` "would have no
 * model". On read the resolver falls back to the Priority list for this
 * case and flags it; on save it is refused. So the question is whether any
 * entry of the chain itself was eligible, not whether the chain is empty.
 */
function noModelErrors(doc, { availability, catalog }) {
  const normalized = normalizeSelection(doc);
  return Object.entries(normalized.tasks)
    .filter(([, entry]) => entry.mode === 'custom' && !entry.thenGlobal)
    .filter(([task]) => {
      const { chain } = selectChain({ task, selection: normalized, catalog, availability });
      return !chain.some((candidate) => candidate.selection === 'custom');
    })
    .map(
      ([task]) =>
        `tasks.${task}: this task would have no model — no entry of its custom chain is eligible and the Priority list does not follow it (${AI_TASKS[task].label})`
    );
}

/**
 * Every error in a document a save would store, as sentences; empty when it
 * is valid. Stricter than normalizeSelection on purpose (header).
 *
 * The shape rules come first; only a well-shaped document is then held to
 * §6's "would have no model" rule, which runs the resolver (select.js) over
 * the `availability` and `catalog` the caller read. Without `availability`
 * that rule is not checked (a unit test of the shape alone).
 *
 * @param {unknown} doc
 * @param {{ availability?: { keyed: string[], enabled: string[] }, catalog?: object|null }} [deps]
 * @returns {string[]}
 */
export function validateSelection(doc, { availability, catalog = null } = {}) {
  if (!isPlainObject(doc)) return ['Body must be { version: 2, global: { priority }, tasks }'];
  const errors = shapeErrors(doc);
  return errors.length || !availability ? errors : noModelErrors(doc, { availability, catalog });
}
