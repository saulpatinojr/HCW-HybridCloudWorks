/**
 * The selection document's pure rules on the page (ADR 0034 §4, slice 4,
 * #859): how a provider is named, how the Priority list is split into the
 * rows that can be reordered and the ones that cannot, how one change
 * rewrites the document, and what the resolver's answer says in a sentence.
 * No React, so the tabs can be read for what they render and this for what
 * it decides. Nothing here resolves a chain: the effective model is the
 * API's answer (`getEffectiveRouting`), and this file only reads it.
 */

/** The chain editor's cap (ADR 0034 §4). */
export const MAX_CHAIN = 4;

/** The model select's "no model named" value: a null in the document. */
export const PROVIDER_DEFAULT = '__default__';

export const MODES = Object.freeze(['recommended', 'global', 'custom']);

/**
 * The media providers' names (ADR 0034 slice 5, #860). They have no card —
 * a key is what switches them on — so no document carries a name for them;
 * these are provider names, not model ids, which never appear in UI code.
 */
export const MEDIA_PROVIDER_LABELS = Object.freeze({
  elevenlabs: 'ElevenLabs',
  replicate: 'Replicate',
});

/** A provider's display name: the card's, else a media provider's, else the id. */
export function providerLabel(id, providers = []) {
  return providers.find((p) => p.id === id)?.name || MEDIA_PROVIDER_LABELS[id] || id;
}

/**
 * The providers a task's chain editor and exclusions offer (ADR 0034 slice
 * 5): the cards, joined by the media providers the effective read names
 * (`availability.media`), each kept only when it can carry every one of the
 * task's `needs` (`availability.capabilities`) and, for a task with a
 * product rule (`only`), when the rule allows it. With no capabilities on
 * the answer, every card is offered, as before the media tasks.
 */
export function chainProvidersFor(resolved, providers = [], availability = {}) {
  const media = (availability.media || []).map((id) => ({
    id,
    name: MEDIA_PROVIDER_LABELS[id] || id,
  }));
  const all = [...providers, ...media.filter((m) => !providers.some((p) => p.id === m.id))];
  const needs = Array.isArray(resolved?.needs) ? resolved.needs : [];
  const capabilities = availability.capabilities || null;
  const only = Array.isArray(resolved?.only) ? resolved.only : null;
  return all.filter((p) => {
    if (only && !only.includes(p.id)) return false;
    if (!capabilities) return true;
    const carried = capabilities[p.id];
    return Array.isArray(carried) && needs.every((need) => carried.includes(need));
  });
}

/** `Provider default` in a select means a null model. */
export const modelOrNull = (value) => (!value || value === PROVIDER_DEFAULT ? null : value);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A document to render from, whatever the API handed over. */
export function normalizeSelection(selection) {
  const base = isObject(selection) ? selection : {};
  return {
    version: 2,
    global: { priority: Array.isArray(base.global?.priority) ? base.global.priority : [] },
    tasks: isObject(base.tasks) ? base.tasks : {},
    updatedAt: base.updatedAt ?? null,
  };
}

/**
 * The Priority list in two parts: `listed`, the rows a call may reach
 * (keyed and switched on, in the document's order), which the page lets the
 * owner reorder; and `unlisted`, every other implemented provider with the
 * reason it is not in the list — switched off, no key, or simply not named
 * by the document yet (`add` says the page may add it).
 */
export function splitPriority(selection, availability, providers = []) {
  const { priority } = normalizeSelection(selection).global;
  const keyed = new Set(availability?.keyed || []);
  const enabled = new Set(availability?.enabled || []);
  const named = new Set(priority.map((s) => s.provider));
  const listed = priority.filter((s) => keyed.has(s.provider) && enabled.has(s.provider));
  const reasonFor = (id) => {
    if (!keyed.has(id)) return 'no key';
    if (!enabled.has(id)) return 'switched off';
    return 'not in the list';
  };
  const unlisted = [
    ...priority
      .filter((s) => !listed.includes(s))
      .map((s) => ({ provider: s.provider, reason: reasonFor(s.provider), add: false })),
    ...providers
      .map((p) => p.id)
      .filter((id) => !named.has(id))
      .map((id) => ({
        provider: id,
        reason: reasonFor(id),
        add: keyed.has(id) && enabled.has(id),
      })),
  ];
  return { listed, unlisted };
}

/** The document with the listed rows in `order` (provider ids), the rest after them as they were. */
function withListedOrder(selection, order) {
  const doc = normalizeSelection(selection);
  const byProvider = new Map(doc.global.priority.map((s) => [s.provider, s]));
  const rest = doc.global.priority.filter((s) => !order.includes(s.provider));
  return {
    ...doc,
    global: { priority: [...order.map((id) => byProvider.get(id)), ...rest] },
  };
}

/** The document with one listed row moved up (-1) or down (+1) among the listed rows. */
export function movePriority(selection, availability, provider, delta) {
  const { listed } = splitPriority(selection, availability);
  const order = listed.map((s) => s.provider);
  const index = order.indexOf(provider);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= order.length) return normalizeSelection(selection);
  [order[index], order[target]] = [order[target], order[index]];
  return withListedOrder(selection, order);
}

/** The document with one row's model set (null for the provider default). */
export function setPriorityModel(selection, provider, model) {
  const doc = normalizeSelection(selection);
  return {
    ...doc,
    global: {
      priority: doc.global.priority.map((s) =>
        s.provider === provider ? { provider, model: modelOrNull(model) } : s
      ),
    },
  };
}

/** The document with a provider appended to the list, when it is not there. */
export function addToPriority(selection, provider) {
  const doc = normalizeSelection(selection);
  if (doc.global.priority.some((s) => s.provider === provider)) return doc;
  return { ...doc, global: { priority: [...doc.global.priority, { provider, model: null }] } };
}

/**
 * One task's entry as the editor holds it: every field present, so a radio
 * and a switch have a value, with `chain` and `thenGlobal` kept across a
 * mode change so switching to Custom and back loses nothing.
 */
export function draftEntry(entry) {
  const base = isObject(entry) ? entry : {};
  return {
    mode: MODES.includes(base.mode) ? base.mode : 'global',
    chain: Array.isArray(base.chain)
      ? base.chain
          .slice(0, MAX_CHAIN)
          .map((s) => ({ provider: s.provider, model: s.model ?? null }))
      : [],
    thenGlobal: base.thenGlobal !== false,
    exclude: Array.isArray(base.exclude) ? [...base.exclude] : [],
  };
}

/**
 * The entry as the document stores it: `chain` and `thenGlobal` only for
 * `custom`, `exclude` only when it names someone, and nothing at all — null
 * — for a plain `global` task, which the document leaves out.
 */
export function storedEntry(draft) {
  const d = draftEntry(draft);
  const entry = { mode: d.mode };
  if (d.mode === 'custom') {
    entry.chain = d.chain.map(({ provider, model }) => ({ provider, model: modelOrNull(model) }));
    entry.thenGlobal = d.thenGlobal;
  }
  if (d.exclude.length) entry.exclude = d.exclude;
  return d.mode === 'global' && !d.exclude.length ? null : entry;
}

/** The document with one task's entry replaced, or removed when it is plain global. */
export function withTaskEntry(selection, task, draft) {
  const doc = normalizeSelection(selection);
  const tasks = { ...doc.tasks };
  const entry = storedEntry(draft);
  if (entry) tasks[task] = entry;
  else delete tasks[task];
  return { ...doc, tasks };
}

/** True when the draft would store something other than what the document holds. */
export function isDirty(draft, entry) {
  return JSON.stringify(storedEntry(draft)) !== JSON.stringify(storedEntry(entry));
}

/** The draft's chain with one step changed, added, or removed; a provider appears once. */
export const CHAIN_CHANGES = {
  add: (chain, { provider }) =>
    chain.length < MAX_CHAIN && !chain.some((s) => s.provider === provider)
      ? [...chain, { provider, model: null }]
      : chain,
  provider: (chain, { index, provider }) =>
    chain.some((s, i) => s.provider === provider && i !== index)
      ? chain
      : chain.map((s, i) => (i === index ? { provider, model: null } : s)),
  model: (chain, { index, model }) =>
    chain.map((s, i) => (i === index ? { ...s, model: modelOrNull(model) } : s)),
  remove: (chain, { index }) => chain.filter((_, i) => i !== index),
};

export function updateChain(chain, change) {
  const apply = CHAIN_CHANGES[change.type];
  return apply ? apply(chain, change) : chain;
}

/** The draft with a provider added to or removed from `exclude`. */
export function toggleExclude(draft, provider, excluded) {
  const d = draftEntry(draft);
  const exclude = d.exclude.filter((id) => id !== provider);
  return { ...d, exclude: excluded ? [...exclude, provider] : exclude };
}

/**
 * What a task will use, in a sentence, from the resolver's chain: the model
 * named on the first candidate, or the provider's default (judged on the
 * modality model), via the provider; or that nothing is eligible.
 */
export function describeEffective(resolved, providers = []) {
  const first = resolved?.chain?.[0];
  if (resolved?.planned) return 'Not connected yet';
  if (!first) return 'No eligible model';
  const via = providerLabel(first.provider, providers);
  if (first.model) return `${first.model} via ${via}`;
  // modalityModel is an eligibility check, not the model used for each purpose.
  if (resolved?.media && first.modalityModel) return `${first.modalityModel} via ${via}`;
  return `Provider default via ${via}`;
}

/** The first turned-away candidate, as "Provider: why", or null. */
export function firstRejection(resolved, providers = []) {
  const first = resolved?.rejected?.[0];
  return first ? `${providerLabel(first.provider, providers)}: ${first.why}` : null;
}

/**
 * The badges a task row carries (ADR 0034 §4): the recommendation did not
 * lead, the custom chain had nothing eligible, the model it will use is
 * unpriced, or nothing is eligible at all.
 */
export function taskBadges(resolved, catalog = null) {
  if (resolved?.planned) return ['planned'];
  const asked = resolved?.entry?.mode;
  const got = resolved?.mode;
  const first = resolved?.chain?.[0] || null;
  return [
    asked === 'recommended' && got !== 'recommended' && 'recommendation not live',
    asked === 'custom' && got !== 'custom' && 'custom had nothing eligible',
    !first && 'no eligible model',
    first && isUnpriced(catalog, first) && 'unpriced',
  ].filter(Boolean);
}

/** True when the catalogue prices neither the candidate's model nor the one it was judged on. */
function isUnpriced(catalog, candidate) {
  const model = candidate.model || candidate.modalityModel;
  return catalog?.providers?.[candidate.provider]?.models?.[model]?.unpriced === true;
}

/**
 * Retired models the Priority list or a custom chain still names, from the
 * resolver's rejections (`code: 'retired'`), each with where it is named.
 */
export function retiredInUse(effective) {
  const seen = new Map();
  for (const [task, resolved] of Object.entries(effective?.tasks || {})) {
    for (const r of resolved?.rejected || []) {
      if (r.code !== 'retired') continue;
      const key = `${r.provider}/${r.model}`;
      const where = r.selection === 'custom' ? resolved.label || task : 'the Priority list';
      const entry = seen.get(key) || { provider: r.provider, model: r.model, where: [] };
      if (!entry.where.includes(where)) entry.where.push(where);
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

/**
 * The Priority row's one-line "will use": the named model, or what a null
 * resolves to for text (drafts and short answers) and for vision, from what
 * the API reports per row.
 */
export function describePriorityRow(row) {
  if (!row) return '';
  if (row.model) return `Will use ${row.model} for every task.`;
  const d = row.defaults || {};
  const text =
    d.draft && d.general && d.draft !== d.general
      ? `${d.draft} for drafts, ${d.general} for short answers`
      : d.general || d.draft || 'provider default';
  const vision = row.modality?.vision ? d.multimodal || row.modality.vision : null;
  return `Will use ${text}; vision: ${vision || 'no model — the next row serves'}.`;
}
