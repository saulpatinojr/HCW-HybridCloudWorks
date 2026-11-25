/**
 * selection-normalize.js — the shape of the AI selection document (ADR 0034
 * §6): its modes and bounds, and the normalizer that reads a stored document
 * into that shape. selection.js validates against it and re-exports these
 * names.
 */
import { DEFAULT_PROVIDER_ORDER, KNOWN_PROVIDERS, providerCarries } from './provider-order.js';
import { AI_TASKS, TASK_NAMES } from './tasks.js';

export const SELECTION_VERSION = 2;
export const SELECTION_MODES = Object.freeze(['recommended', 'global', 'custom']);
/**
 * A custom chain's length cap: one step per provider the router implements.
 * The Tasks tab offers four (ADR 0034 §4); the document allows one more so a
 * migrated v1 route (a primary, three fallbacks) with a placement prepended
 * keeps every provider it named. Duplicates collapse, so nothing longer is
 * ever useful.
 */
export const MAX_CHAIN_LENGTH = DEFAULT_PROVIDER_ORDER.length;

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const cleanProvider = (value) =>
  String(value ?? '')
    .toLowerCase()
    .trim();

const cleanModel = (value) => {
  const model = typeof value === 'string' ? value.trim() : '';
  return model || null;
};

/** Any provider the resolver knows, the media providers included (header). */
export const isKnownProvider = (provider) => KNOWN_PROVIDERS.includes(provider);

/** A chat provider: what the Priority list may name (header). */
export const isChatProvider = (provider) => DEFAULT_PROVIDER_ORDER.includes(provider);

/**
 * A list of `{ provider, model }` steps, normalised: providers `allowed`
 * only (every known one by default; the chat ones for the Priority list),
 * the first occurrence of a provider kept (§6: duplicates collapse to the
 * first), models trimmed or null, at most `limit` entries.
 */
export function normalizeSteps(raw, limit = Infinity, allowed = isKnownProvider) {
  const steps = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const provider = cleanProvider(isPlainObject(entry) ? entry.provider : entry);
    if (!allowed(provider) || seen.has(provider)) continue;
    seen.add(provider);
    steps.push({ provider, model: cleanModel(isPlainObject(entry) ? entry.model : null) });
    if (steps.length >= limit) break;
  }
  return steps;
}

/** A list of provider names, normalised: known, unique, in the order given. */
function normalizeProviders(raw) {
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const provider = cleanProvider(entry);
    if (isKnownProvider(provider) && !out.includes(provider)) out.push(provider);
  }
  return out;
}

/** A chain step for `task` may name a provider that can carry the task's needs (header). */
const stepAllowedFor = (task) => (provider) =>
  isKnownProvider(provider) && providerCarries(provider, AI_TASKS[task]?.needs);

/** One task's entry, normalised; `chain` and `thenGlobal` only for `custom`. */
function normalizeTask(task, raw) {
  const base = isPlainObject(raw) ? raw : {};
  const mode = SELECTION_MODES.includes(base.mode) ? base.mode : 'global';
  const exclude = normalizeProviders(base.exclude);
  const entry = { mode };
  if (mode === 'custom') {
    entry.chain = normalizeSteps(base.chain, MAX_CHAIN_LENGTH, stepAllowedFor(task));
    entry.thenGlobal = base.thenGlobal !== false;
  }
  if (exclude.length) entry.exclude = exclude;
  return entry;
}

/**
 * The document, normalised to the shape above. Nothing here throws: an
 * unknown provider or task is dropped, a bad mode reads as `global`, a
 * missing `global.priority` reads as empty (the resolver falls back to the
 * default order for a document with no list at all — see select.js).
 *
 * @param {unknown} doc
 */
export function normalizeSelection(doc) {
  const base = isPlainObject(doc) ? doc : {};
  const tasks = {};
  for (const [task, raw] of Object.entries(isPlainObject(base.tasks) ? base.tasks : {})) {
    if (!TASK_NAMES.includes(task)) continue;
    tasks[task] = normalizeTask(task, raw);
  }
  return {
    version: SELECTION_VERSION,
    global: {
      priority: normalizeSteps(
        isPlainObject(base.global) ? base.global.priority : null,
        Infinity,
        isChatProvider
      ),
    },
    tasks,
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : null,
    updatedBy: typeof base.updatedBy === 'string' ? base.updatedBy : null,
  };
}

/** True when the document carries this module's version. */
export const isSelectionV2 = (doc) => isPlainObject(doc) && doc.version === SELECTION_VERSION;
