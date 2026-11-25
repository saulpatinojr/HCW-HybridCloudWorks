/**
 * router-chain.js — which providers a call may use, in order (router.js):
 * the keyed and enabled providers, the resolver's chain for the task, the
 * CONTENTFORGE_AI_PROVIDER pin, and the sentence an empty chain earns.
 */
import { isFeatureEnabled, resolveProviderOrder } from './ai-config.js';
import { MEDIA_PROVIDERS } from './provider-order.js';
import { UNDECLARED_TASK, selectChain } from './select.js';
import { defaultSelection } from './migrate-selection.js';
import { taskFor } from './tasks.js';
import { KEY_ENV, MEDIA_KEY_ENV, PROVIDERS } from './router-base.js';
import { AiFeatureDisabledError, AiNotConfiguredError, readKey } from './router-base.js';

export const keyedProviders = (ctx) => PROVIDERS.filter((p) => readKey(ctx.env, KEY_ENV[p]));

/** The media providers holding a key: enabled by that alone (header: THE AUDIO AND IMAGE TASKS). */
export const keyedMediaProviders = (ctx) =>
  MEDIA_PROVIDERS.filter((p) => readKey(ctx.env, MEDIA_KEY_ENV[p]));

/**
 * What the resolver may choose from: the chat providers holding a key and
 * those switched on, each list joined by the keyed media providers, which
 * have no switch.
 */
export function availabilityOf(ctx, docs) {
  const keyed = keyedProviders(ctx);
  const { order: enabled, disabled } = resolveProviderOrder(docs, keyed);
  const media = keyedMediaProviders(ctx);
  return { keyed: [...keyed, ...media], enabled: [...enabled, ...media], disabled };
}

const pinnedProvider = (ctx) =>
  String(ctx.env.CONTENTFORGE_AI_PROVIDER || '')
    .toLowerCase()
    .trim();

/**
 * The provider chosen from KEYS ALONE, ignoring anything stored in the portal.
 *
 * Kept synchronous and kept env-only on purpose: callers use it to label and
 * to log, and an await there would ripple through four modules for no gain.
 * It is NOT the provider a call will use once an administrator has reordered
 * or disabled something — for that, read `usageOut` after the call, which
 * records what actually ran. `firstProvider` is the real selection.
 */
export function activeProvider(ctx) {
  const available = keyedProviders(ctx);
  const pinned = pinnedProvider(ctx);
  if (pinned) {
    if (available.includes(pinned)) return pinned;
    ctx.log.warn?.(
      `[ai-router] CONTENTFORGE_AI_PROVIDER=${pinned} but its key is not present; falling back to ${available[0] || 'none'}`
    );
  }
  return available[0] || null;
}

/**
 * The ordered list of providers a call may use, best first.
 *
 * Returns every eligible provider rather than only the winner, because
 * "order of preference" has to mean preference — see `callWithFailover`.
 *
 * @param {string|null} feature A key of AI_FEATURES, or null to skip the gate.
 * @returns {Promise<Array<{provider: string, model: string|null}>>}
 */
export async function providerChain(ctx, feature = null) {
  return chainOrThrow(await chainDetails(ctx, feature), feature);
}

/** The chain of a resolved `chainDetails`, or the AiNotConfiguredError sentence an empty one earns. */
export function chainOrThrow(details, feature) {
  if (details.chain.length > 0) return details.chain;
  const name = feature ? `'${feature}'` : 'this call';
  throw new AiNotConfiguredError(emptyChainSentence(details, feature, name));
}

/**
 * Why the chain came back empty, most specific first. Each reason below holds
 * only while no provider is disabled; with one disabled, that is the answer.
 */
function emptyChainSentence(details, feature, name) {
  const { disabled } = details;
  const specific =
    disabled.length === 0
      ? EMPTY_CHAIN_REASONS.map((reason) => reason(details, feature, name)).find(Boolean)
      : null;
  if (specific) return specific;
  return disabled.length > 0
    ? `Every configured AI provider is disabled in the admin portal (${disabled.join(', ')}). Re-enable one under AI Engine → AI Services.`
    : 'No AI provider is configured. Seed GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in Key Vault (Required-Inputs §4.6) and the matching provider turns on.';
}

/**
 * A media task with a product rule (tasks.js `only`): the sentence names
 * the providers that may serve it and the key each needs, not the chat
 * keys and a placement that no longer exists (ADR 0034 slice 5).
 */
function onlyProvidersReason({ uncapable, retired }, feature, name) {
  const only = feature ? taskFor(feature)?.only : null;
  if (!Array.isArray(only)) return null;
  const keys = only.map((p) => MEDIA_KEY_ENV[p] || KEY_ENV[p]).filter(Boolean);
  return `${name} is served by ${only.join(' or ')} only, and ${only.length === 1 ? 'it holds' : 'none of them holds'} a usable key or model. Seed ${keys.join(' or ')} in Key Vault (Required-Inputs §4.6), or pick a model under AI Engine → Tasks${uncapable.length || retired.length ? ` (${[...uncapable, ...retired].map((r) => `${r.provider}: ${r.why}`).join('; ')})` : ''}.`;
}

function excludedReason({ excluded }, feature) {
  if (excluded.length === 0) return null;
  return `The only configured AI provider (${excluded.join(', ')}) is not used for ${feature ? `'${feature}'` : 'calls that name no feature'}. Seed GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY (Required-Inputs §4.6), or change its placement under AI Engine → Where AI is used where that is allowed.`;
}

// ADR 0034 §6: a task no configured provider can serve fails naming why
// — the capability no model carries, a retired model, no model for the
// modality — not with a 500 or "not configured".
function uncapableReason({ uncapable }, feature, name) {
  if (uncapable.length === 0) return null;
  const capabilities = [...new Set(uncapable.flatMap((r) => r.missing))];
  return `No eligible model carries ${capabilities.map((c) => `'${c}'`).join(', ')} for ${name}: ${uncapable.map((r) => `${r.provider} (${r.why})`).join('; ')}. Enable a provider whose models carry it under AI Engine → AI Services, or name one in the task's chain.`;
}

function retiredReason({ retired }, feature, name) {
  if (retired.length === 0) return null;
  return `Every eligible model for ${name} is retired in the catalogue (${retired.map((r) => `${r.model} on ${r.provider}`).join(', ')}); pick another under AI Engine → Tasks.`;
}

function noModelReason({ noModel, modality }, feature, name) {
  if (noModel.length === 0) return null;
  return `No provider offers a model for ${name} (${modality}): ${noModel.map((r) => r.provider).join(', ')}. Name one in the task's chain under AI Engine → Tasks, or enable a provider that recommends one.`;
}

/** The empty-chain reasons, in the order they are tried. */
const EMPTY_CHAIN_REASONS = Object.freeze([
  onlyProvidersReason,
  excludedReason,
  uncapableReason,
  retiredReason,
  noModelReason,
]);

/** Rejections a provider earned for the task's sake, not for want of a key or a switch. */
const NOT_USED_CODES = Object.freeze(['excluded', 'policy']);
/** Rejections for want of a model: no capability, retired, or none for the modality. */
const NO_MODEL_CODES = Object.freeze(['capability', 'retired', 'no-model']);

/**
 * The chain and how it was arrived at — the selection behind
 * `providerChain`, kept separate so the grounded path can apply the SAME
 * selection and then say precisely why Gemini is not in it. The empty chain
 * is left to the callers, who have different sentences for it.
 *
 * The decision is the resolver's (select.js, ADR 0034 §3): the selection
 * document (a v1 routing document is migrated in memory by the loader; no
 * document at all is the code defaults), the catalogue, and what holds a
 * key and is switched on. What stays here is the router's own: the feature
 * switch, the key check, and the `CONTENTFORGE_AI_PROVIDER` pin, which is
 * an instruction rather than a preference — it selects one provider from
 * the resolved chain and does NOT fall through to the others, and it cannot
 * add a provider the resolver turned away.
 *
 * @returns {Promise<{chain: Array<{provider: string, model: string|null, selection: string}>,
 *                    disabled: string[], excluded: string[], uncapable: Array<object>,
 *                    retired: Array<object>, noModel: Array<object>, modality: string,
 *                    rejected: Array<object>, flags: string[], pinned: string}>}
 */
export async function chainDetails(ctx, feature = null) {
  const { providers: docs, features, selection, catalog } = await ctx.config.load();

  if (feature && !isFeatureEnabled(features, feature)) {
    throw new AiFeatureDisabledError(feature);
  }

  const { keyed, enabled, disabled } = availabilityOf(ctx, docs);
  const selected = selectChain({
    task: feature,
    selection: selection || defaultSelection(),
    catalog,
    availability: { keyed, enabled },
  });
  logSelectionNotes(ctx, feature, selected);
  const { excluded, uncapable, retired, noModel, withoutModel } = rejectionGroups(selected.rejected);

  const pinned = pinnedProvider(ctx);
  const chain = pinnedChain(ctx, selected.chain, { pinned, feature, disabled, excluded, withoutModel });

  return {
    // A null model is the provider's default for the call's purpose
    // (callWith → modelFor), as the select.js header explains; the model it
    // was judged on and the reason travel for `modelForTask` and the page.
    chain: chain.map(({ provider, model, selection: source, modalityModel, why }) => ({
      provider,
      model,
      selection: source,
      modalityModel: modalityModel ?? null,
      why,
    })),
    disabled,
    excluded,
    uncapable,
    retired,
    noModel,
    modality: (feature && taskFor(feature)?.modality) || UNDECLARED_TASK.modality,
    rejected: selected.rejected,
    flags: selected.flags,
    pinned,
  };
}

/** The resolver's flags, and a custom chain step that cannot serve, as warn lines. */
function logSelectionNotes(ctx, feature, selected) {
  for (const flag of selected.flags) {
    ctx.log.warn?.(`[ai-router] '${feature || 'no feature'}': ${flag}`);
  }
  // A custom chain step that cannot serve is logged, as a skipped v1 route
  // was: the administrator named it and should see why it did not answer.
  const skipped = selected.rejected.filter((r) => r.selection === 'custom');
  if (skipped.length) {
    ctx.log.warn?.(
      `[ai-router] '${feature}' routes to ${skipped.map((r) => r.provider).join(', ')} but ${
        skipped.length === 1 ? 'it is' : 'they are'
      } not available (${skipped.map((r) => r.why).join('; ')}); serving from ${
        selected.chain[0]?.provider || 'none'
      }`
    );
  }
}

/** The resolver's rejections, grouped by the sentence each feeds in providerChain. */
function rejectionGroups(rejected) {
  return {
    // Providers that hold a key and are on, but may not serve this task; and
    // those that may but have no model that carries what it needs. Each is
    // the subject of a different sentence in providerChain.
    excluded: rejected.filter((r) => NOT_USED_CODES.includes(r.code)).map((r) => r.provider),
    // The capability sentence is for rejections that name a missing one; a
    // retired model and a provider with no model for the modality each have
    // their own (providerChain).
    uncapable: rejected.filter((r) => r.code === 'capability' && r.missing?.length),
    retired: rejected.filter((r) => r.code === 'retired'),
    noModel: rejected.filter((r) => r.code === 'no-model'),
    withoutModel: rejected.filter((r) => NO_MODEL_CODES.includes(r.code)),
  };
}

/**
 * The chain narrowed to the CONTENTFORGE_AI_PROVIDER pin when the pin is in
 * it; otherwise the chain as resolved, with a warn line saying why the pin
 * could not be used.
 */
function pinnedChain(ctx, chain, { pinned, feature, disabled, excluded, withoutModel }) {
  if (!pinned) return chain;
  if (chain.some((entry) => entry.provider === pinned)) {
    return chain.filter((entry) => entry.provider === pinned);
  }
  let why = 'its key is not present';
  if (disabled.includes(pinned)) why = 'it is disabled in the admin portal';
  else if (excluded.includes(pinned)) why = `it is not used for '${feature || 'no feature'}'`;
  else if (withoutModel.some((r) => r.provider === pinned)) {
    why = `no model of its carries what '${feature || 'no feature'}' needs`;
  }
  ctx.log.warn?.(
    `[ai-router] CONTENTFORGE_AI_PROVIDER=${pinned} but ${why}; falling back to ${chain[0]?.provider || 'none'}`
  );
  return chain;
}
