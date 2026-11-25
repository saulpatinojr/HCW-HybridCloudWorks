/**
 * select-verdicts.js — how one step of a task's chain is judged (select.js):
 * whether its provider can serve the task, and which model it would use,
 * explicit or recommended. select.js walks the chain with these verdicts.
 */
import { DEFAULT_PROVIDER_ORDER, KNOWN_PROVIDERS, PROVIDER_CAPABILITIES } from './provider-order.js';
import {
  MEDIA_MODALITIES,
  defaultModeFor,
  isMediaTask,
  taskFor,
} from './tasks.js';
import { recommendedModelFor } from './provider-recommendations.js';
import { enrichmentFor } from './model-enrichment.js';

/** Providers on a trial tier: free, rate-limited, under trial terms (router.js header, #701). */
export const TRIAL_TIER_PROVIDERS = Object.freeze(['nvidia']);
/** The providers that can ground a generation on pages and YouTube (#433). */
export const GROUNDING_PROVIDERS = Object.freeze(['gemini']);

/** How a chain entry was chosen; the usage row carries it. */
export const SELECTION_SOURCES = Object.freeze(['explicit', 'recommended', 'custom', 'global']);

/**
 * What a call that names no task (or an unknown one) is judged as: a text
 * call, and public — the trial tier never serves it, as `placementFor`
 * answered 'off' for a call with no feature.
 */
export const UNDECLARED_TASK = Object.freeze({
  id: null,
  label: 'a call that names no task',
  modality: 'text',
  needs: Object.freeze(['text']),
  public: true,
  recommended: null,
});

/** The Priority list a document with none reads as: the default order, provider defaults. */
export const DEFAULT_PRIORITY = Object.freeze(
  DEFAULT_PROVIDER_ORDER.map((provider) => Object.freeze({ provider, model: null }))
);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The task definition for an id: the registry's, or UNDECLARED_TASK. */
export function definitionOf(task) {
  if (isPlainObject(task) && Array.isArray(task.needs)) return task;
  const found = typeof task === 'string' ? taskFor(task) : undefined;
  return found ? { id: task, ...found } : UNDECLARED_TASK;
}

/**
 * The task's entry in the document: `{ mode, chain?, thenGlobal?, exclude? }`,
 * or the task's own default mode when absent — `global` for a chat task,
 * `recommended` for a media one (tasks.js defaultMode, header).
 */
export function entryOf(selection, def) {
  const entry = def.id ? selection?.tasks?.[def.id] : null;
  return isPlainObject(entry) ? entry : { mode: defaultModeFor(def) };
}

/**
 * What the catalogue says about one model, or what the code says when the
 * catalogue does not list it: `listed` false, status `unknown`, the
 * enrichment table's capabilities, pricing unknown.
 */
function catalogEntry(catalog, provider, model) {
  const providerEntry = catalog?.providers?.[provider];
  const stored = providerEntry?.models?.[model];
  if (isPlainObject(stored)) {
    return {
      listed: true,
      status: stored.status || 'unknown',
      capabilities: Array.isArray(stored.capabilities) ? stored.capabilities : [],
      unpriced: stored.unpriced === true,
      stale: providerEntry.stale === true,
    };
  }
  return {
    listed: false,
    status: 'unknown',
    capabilities: enrichmentFor(model).capabilities,
    unpriced: null,
    stale: providerEntry?.stale === true,
  };
}

/** A turned-away candidate: where it came from (`selection`), the code a caller can key on, the sentence a page shows. */
const reject = (step, code, why) => ({
  provider: step.provider,
  model: step.model,
  selection: step.selection,
  code,
  why,
});

/**
 * Rule 5's provider half: keyed, enabled, not excluded, and the locks. A
 * rejection, or null when the provider may serve this task.
 */
function providerRejection(step, { def, availability, exclude }) {
  const facts = { provider: step.provider, def, availability, exclude };
  const failed = PROVIDER_CHECKS.find((check) => check.fails(facts));
  if (!failed) return null;
  // `providerLevel` marks a rejection that holds whatever model a later
  // step names, so the walk settles the provider on it (PROVIDER_LEVEL).
  return { ...reject(step, failed.code, failed.why(facts)), ...failed.extra?.(facts), providerLevel: true };
}

/** The task's MEDIA needs the provider cannot carry at all (PROVIDER_CAPABILITIES, tasks.js MEDIA_MODALITIES). */
function missingFromProvider(provider, def) {
  const carried = PROVIDER_CAPABILITIES[provider] || [];
  return def.needs.filter((need) => MEDIA_MODALITIES.includes(need) && !carried.includes(need));
}

/**
 * Rule 5's provider checks, in the order they are asked; the first that
 * fails is the rejection. The two last are the policy locks (header).
 */
const PROVIDER_CHECKS = Object.freeze([
  {
    code: 'unknown',
    fails: ({ provider }) => !KNOWN_PROVIDERS.includes(provider),
    why: ({ provider }) => `not available: ${provider} is not a provider the router implements`,
  },
  {
    code: 'no-key',
    fails: ({ provider, availability }) => !availability.keyed.includes(provider),
    why: ({ provider }) => `not available: ${provider} holds no key`,
  },
  {
    code: 'disabled',
    fails: ({ provider, availability }) => !availability.enabled.includes(provider),
    why: ({ provider }) => `not available: ${provider} is switched off in the admin portal`,
  },
  {
    code: 'excluded',
    fails: ({ provider, exclude }) => exclude.includes(provider),
    why: ({ provider }) => `not used: ${provider} is excluded for this task`,
  },
  {
    code: 'policy',
    fails: ({ provider, def }) => TRIAL_TIER_PROVIDERS.includes(provider) && def.public,
    why: () => 'not eligible: trial tier on a public route',
  },
  {
    code: 'policy',
    fails: ({ provider, def }) =>
      def.needs.includes('grounding') && !GROUNDING_PROVIDERS.includes(provider),
    why: () => 'not eligible: grounding is Gemini-only',
  },
  {
    // The media half of rule 5's provider check (header): a provider that
    // cannot carry a media need at all — a chat provider walked from the
    // Priority list for a speech task, any provider for a planned task — is
    // turned away before a model is looked at. The chat needs (text, json,
    // vision, grounding) stay judged per model and by the locks above, as
    // they were. Carries `missing` like the model-level rejection, so the
    // router's sentence names the capability.
    code: 'capability',
    fails: ({ provider, def }) => missingFromProvider(provider, def).length > 0,
    why: ({ provider, def }) =>
      `not eligible: ${provider} cannot carry ${missingFromProvider(provider, def).join(', ')}`,
    extra: ({ provider, def }) => ({ missing: missingFromProvider(provider, def) }),
  },
  {
    // The product rule a media task carries in code (tasks.js `only`): the
    // podcast voice is ElevenLabs-only, Listen & Learn speech Gemini-only,
    // the images Replicate-only (ADR 0029 §2b). No document lifts it. After
    // the capability check, so a provider that could not serve anyway is
    // reported for that, and this names only the one the rule itself turns
    // away (Gemini, which carries tts, from the podcast).
    code: 'policy',
    fails: ({ provider, def }) => Array.isArray(def.only) && !def.only.includes(provider),
    why: ({ def }) => `not eligible: ${def.label} is served by ${def.only.join(' or ')} only`,
  },
]);

/**
 * Rule 5's model half for a named model: not retired, carries `needs`. A
 * rejection, or `{ note }` with the flag a not-yet-listed model earns.
 */
function modelVerdict(step, model, { def, catalog }) {
  const { provider } = step;
  const entry = catalogEntry(catalog, provider, model);
  // A rejection names the model it was judged on — for a null step, the
  // modality recommendation — and a capability rejection carries `missing`,
  // which the router's sentence names.
  const judged = { ...step, model };
  if (entry.status === 'retired') {
    return { rejection: reject(judged, 'retired', `not eligible: ${model} is retired on ${provider}`) };
  }
  const missing = def.needs.filter((need) => !entry.capabilities.includes(need));
  if (missing.length) {
    return {
      rejection: {
        ...reject(
          judged,
          'capability',
          `not eligible: ${model} on ${provider} does not carry ${missing.join(', ')}`
        ),
        missing,
      },
    };
  }
  let note = null;
  if (!entry.listed) note = `${model} on ${provider} is not in the catalogue yet; allowed until a refresh says otherwise`;
  else if (entry.status === 'unknown') note = `${model} on ${provider} has not been confirmed by a catalogue refresh yet`;
  return { entry, note };
}

/**
 * Rule 2's stricter model half: the recommendation must be `live` (a stale
 * provider's live model still counts, with a note) and priced.
 */
function recommendedVerdict(step, { def, catalog }) {
  const verdict = modelVerdict(step, step.model, { def, catalog });
  if (verdict.rejection) return verdict;
  const { entry } = verdict;
  // A media task has no Priority list behind it (header: THE MEDIA TASKS),
  // so its recommendation stands while the catalogue has not confirmed it
  // — the week between a deploy and the next refresh is the difference
  // between a voice and silence — with the not-yet-listed note; only a
  // retired, unable or unpriced one falls. A chat task keeps the strict
  // reading: the list serves until the refresh says live.
  if (entry.status !== 'live' && !(isMediaTask(def) && entry.status === 'unknown')) {
    return {
      rejection: reject(
        step,
        entry.listed ? 'not-live' : 'not-listed',
        `not recommended: ${step.model} on ${step.provider} is ${entry.listed ? entry.status : 'not'} in the catalogue`
      ),
    };
  }
  if (entry.unpriced) {
    return {
      rejection: reject(step, 'unpriced', `not recommended: ${step.model} on ${step.provider} is unpriced`),
    };
  }
  return { entry, note: entry.stale ? `${step.provider}'s catalogue list is stale` : null };
}

/**
 * One candidate judged: `{ accepted }` or `{ rejection }`. The accepted
 * entry carries `model` (null for a provider default — header), the
 * `modalityModel` a null was judged on, `selection` and `why`.
 */
export function judge(step, where, deps) {
  const rejection = providerRejection(step, deps);
  let verdict;
  if (rejection) verdict = { rejection };
  else if (deps.explicitModel) verdict = acceptExplicit(step, where, deps);
  else if (step.selection === 'recommended') verdict = judgeRecommended(step, deps);
  else verdict = judgeStep(step, where, deps);
  return verdict;
}

/**
 * Rule 1: the call site's model, on whatever provider the step names — and
 * rule 5 still: a retired model or one that does not carry the task's
 * needs is turned away like any other candidate; an unpriced one, or one
 * the catalogue has not listed, is allowed with the note.
 */
function acceptExplicit(step, where, { explicitModel, def, catalog }) {
  const named = { ...step, model: explicitModel };
  const verdict = modelVerdict(named, explicitModel, { def, catalog });
  if (verdict.rejection) return verdict;
  return {
    accepted: {
      provider: step.provider,
      model: explicitModel,
      modalityModel: null,
      selection: 'explicit',
      why: [`explicit model from the call site; ${where}`, verdict.note].filter(Boolean).join(' · '),
    },
  };
}

/** Rule 2: the task's recommendation, under the stricter verdict. */
function judgeRecommended(step, deps) {
  const verdict = recommendedVerdict(step, deps);
  if (verdict.rejection) return verdict;
  return {
    accepted: {
      provider: step.provider,
      model: step.model,
      modalityModel: step.model,
      selection: 'recommended',
      why: [`recommended for this task: ${deps.def.recommended?.reason || ''}`.trim(), verdict.note]
        .filter(Boolean)
        .join(' · '),
    },
  };
}

/**
 * Rules 3 and 4: a chain or list step, with its named model or — for a
 * null — the provider's modality recommendation to judge it on.
 */
function judgeStep(step, where, { def, catalog }) {
  const named = step.model;
  const modality = named ? null : recommendedModelFor(step.provider, def.modality);
  if (!named && !modality) {
    return {
      rejection: reject(
        step,
        'no-model',
        `no model: ${step.provider} has no recommended model for ${def.modality}`
      ),
    };
  }
  const judged = named || modality.model;
  const verdict = modelVerdict(step, judged, { def, catalog });
  if (verdict.rejection) return verdict;
  return {
    accepted: {
      provider: step.provider,
      // NULL MODEL (header): `judged` here would make a null step the
      // modality recommendation; the 2026-10-05 amendment keeps it null.
      model: named,
      modalityModel: judged,
      selection: step.selection,
      why: [
        where,
        named ? `model ${named}` : `model: the provider's default for the call's purpose (${judged} for ${def.modality})`,
        verdict.note,
      ]
        .filter(Boolean)
        .join(' · '),
    },
  };
}
