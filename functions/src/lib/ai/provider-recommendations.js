/**
 * provider-recommendations.js — each provider's own best model per modality
 * (ADR 0034 slice 1, #856).
 *
 * Where a `null` model in the global priority list resolves (ADR 0034 §2):
 * "Foundry, whatever it recommends for this kind of answer". Every entry
 * names a model the cost table prices, with the reason and the day the
 * claim was made; provider-recommendations.test.js refuses an unpriced one.
 * Reviewed like the cost table, in the same pull request as a new rate.
 *
 * This is the table slice 2's adapters carry as `recommendedByModality`; it
 * lives here until the adapters exist. The resolver (select.js) judges a
 * null step on it, and the media call sites read it for a custom step that
 * names a provider and no model (slice 5, #860): the media providers carry
 * their one modality each, and Gemini carries `tts` beside its text ones.
 */

const ASOF = '2026-10-05';

const rec = (model, reason) => Object.freeze({ model, reason, asOf: ASOF });

export const RECOMMENDED_BY_MODALITY = Object.freeze({
  gemini: Object.freeze({
    text: rec('gemini-3.5-flash-lite', 'The cheapest fast Gemini: $0.30 in / $2.50 out per 1M tokens, 0.5 s on the card\'s Test.'),
    json: rec('gemini-3.6-flash', 'Structured output that holds on long inputs; $1.50 / $7.50.'),
    vision: rec('gemini-3.6-flash', 'Reads images; the same model the inspector used for alt text before 2026-10-04.'),
    grounding: rec('gemini-3.6-flash', 'The only model the Interactions API grounds on pages and YouTube (router.js header).'),
    tts: Object.freeze({ model: 'gemini-3.8-flash-tts', asOf: '2026-10-27', reason: 'Google recommends Flash TTS for long-form multi-speaker fidelity. Introductory text/audio rates are $0.50 / $9 per 1M through 2026-12-31, then $1 / $18. Flash-Lite TTS is the lower-cost custom option ($0.50 / $6, then $1 / $12).' }),
  }),
  elevenlabs: Object.freeze({
    tts: rec('eleven_v3', 'The one model the Text to Dialogue endpoint serves; USD 0.10 per 1,000 characters.'),
  }),
  replicate: Object.freeze({
    image: rec('google/imagen-4-fast', 'USD 0.02 per output image on replicate.com (read 2026-10-05), about three seconds an image.'),
  }),
  openai: Object.freeze({
    text: rec('gpt-5-nano', 'The cheapest OpenAI model: $0.05 / $0.40 per 1M tokens (published rates, owner confirmation 2026-10-05).'),
    json: rec('gpt-5-mini', 'Reads whole drafts and returns JSON; $0.25 / $2.00.'),
    vision: rec('gpt-5-mini', 'Supports image inputs for this task.'),
  }),
  anthropic: Object.freeze({
    text: rec('claude-haiku-4-5', 'The fast tier: $1.00 / $5.00 per 1M tokens, 1.9 s on the card\'s Test.'),
    json: rec('claude-sonnet-4-6', 'The card\'s default and the quality tier for structured work; $3.00 / $15.00.'),
    vision: rec('claude-sonnet-4-6', 'Reads images at the same rate.'),
  }),
  nvidia: Object.freeze({
    text: rec('z-ai/glm-5.3', 'The one trial-tier model that answered inside 45 s on 2026-10-04 (2.6 s); free.'),
    json: rec('z-ai/glm-5.3', 'Same model; the JSON rule travels as an instruction on this provider.'),
  }),
  foundry: Object.freeze({
    text: rec('gpt-5-nano', 'The cheapest model on the catalogue: $0.05 / $0.40 per 1M tokens, 2.5 s on the card\'s Test (2026-10-04).'),
    json: rec('gpt-5-mini', 'Reads whole drafts and returns JSON; $0.25 / $2.00, 2–3 s.'),
    vision: rec('gpt-5-mini', 'Supports image inputs for this task.'),
  }),
});

/** The provider's recommendation for a modality, or undefined when it has none. */
export function recommendedModelFor(provider, modality) {
  return RECOMMENDED_BY_MODALITY[provider]?.[modality];
}
