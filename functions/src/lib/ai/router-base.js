/**
 * router-base.js — what every part of the AI router (router.js) shares: the
 * providers and the setting each reads its key from, the key reader, the
 * errors a call can end in, the cost estimate, and the JSON reply readers.
 * router.js re-exports every public name, so callers import from router.js
 * as they always did.
 */
import { AuthoredError } from '../http/error-response.js';
import { DEFAULT_PROVIDER_ORDER } from './ai-config.js';
import { COST_TABLE, isPriced, modelRatesFor } from './model-tables.js';

/**
 * The providers this platform implements, in default preference order.
 *
 * Set and order are deliberately the same list: there is no implemented
 * provider without a place in the order, and no place in the order for a
 * provider that is not implemented. Keeping them as one constant is what stops
 * the two drifting — `ai-config.test.js` asserts the members match.
 *
 * The order changed on 2026-08-23 (owner decision) from Anthropic-first to
 * Gemini-first; the reasoning is on DEFAULT_PROVIDER_ORDER.
 */
export const PROVIDERS = DEFAULT_PROVIDER_ORDER;

export const KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  // Not a key (header: MICROSOFT FOUNDRY): the endpoint Terraform sets. Its
  // presence is what makes the provider available; the token is fetched.
  foundry: 'FOUNDRY_ENDPOINT',
});

/**
 * Providers with no secret behind them. A 401/403 from one of these is a
 * missing role, not a bad key, so the router reports no key verdict for it:
 * there is no API-keys row to turn red, and the secret catalogue (which the
 * Terraform cross-check holds to the vault references exactly) carries no
 * entry for it. secret-catalog.test.js pins the probed set to the rest.
 */
export const KEYLESS_PROVIDERS = Object.freeze(['foundry']);

/**
 * The media providers' keys (header: THE AUDIO AND IMAGE TASKS). Kept apart
 * from KEY_ENV on purpose: KEY_ENV is the chat providers', read by
 * `availableProviders`, the weekly probe's Test and the API-keys page, and
 * none of those can call a voice or an image model. `availableMediaProviders`
 * reads this one; the resolver's `availability` is the union.
 */
export const MEDIA_KEY_ENV = Object.freeze({
  elevenlabs: 'ELEVENLABS_API_KEY',
  replicate: 'REPLICATE_API_KEY',
});

// The purpose → model table and the cost table live in model-tables.js
// (#858, so the catalogue can read them without this module); every caller
// keeps importing them from here.

export function getCostEstimate(provider, model, promptTokens = 0, completionTokens = 0, at = Date.now()) {
  const rates = COST_TABLE[provider] || {};
  if (!isPriced(provider, model)) return 0;
  // Image costs are supplied by the image caller, never inferred from token counts.
  const [inRate, outRate] = modelRatesFor(provider, model, at) || (provider === 'nvidia' ? rates.default : null) || [0, 0];
  return parseFloat(
    ((promptTokens / 1_000_000) * inRate + (completionTokens / 1_000_000) * outRate).toFixed(8)
  );
}

/**
 * No provider can run this call as configured. Every message is written in
 * this module and names the setting to fix, so an admin route may show it
 * (`authoredMessage`, #945); a public route keeps its own sentence.
 */
export class AiNotConfiguredError extends AuthoredError {
  /** @param {string} message - the sentence naming what is missing */
  constructor(message) {
    super(message);
    this.name = 'AiNotConfiguredError';
    this.code = 'AI_NOT_CONFIGURED';
  }
}

/**
 * An administrator switched this feature off in the portal. Distinct from
 * AiNotConfiguredError because it is a decision, not a fault: callers that
 * degrade gracefully (skip alt text, publish an ungraded draft) should catch
 * this and carry on, and nothing should page anyone about it.
 */
export class AiFeatureDisabledError extends AuthoredError {
  /** @param {string} feature - the feature switched off (authored sentence, #945) */
  constructor(feature) {
    super(`The '${feature}' AI feature is turned off in the admin portal.`);
    this.name = 'AiFeatureDisabledError';
    this.code = 'AI_FEATURE_DISABLED';
    this.feature = feature;
  }
}

/** An env value that is a real key: non-empty and not an unresolved Key Vault reference. */
export function readKey(env, name) {
  const raw = env?.[name];
  if (typeof raw !== 'string') return '';
  const value = raw.replace(/^\uFEFF/, '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

export function sanitizeJsonText(text = '') {
  return String(text)
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

export function parseJsonWithFallbacks(rawText = '') {
  const cleaned = sanitizeJsonText(rawText);
  try {
    return JSON.parse(cleaned || '{}');
  } catch {
    // fall through to object extraction
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    // Control characters a model leaked into a string value break JSON.parse.
    return JSON.parse(cleaned.slice(start, end + 1).replace(/[\u0000-\u0019]/g, ' '));
  }
  throw new Error('Model response did not contain parseable JSON');
}

export function isRetryableError(error) {
  const status = error?.status;
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  return /429|503|timeout|temporarily unavailable|rate/i.test(String(error?.message || ''));
}

export const JSON_ONLY =
  'Return only valid JSON. Do not include markdown code fences, prose, or extra commentary.';
