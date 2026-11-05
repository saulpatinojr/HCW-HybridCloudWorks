/**
 * provider-order.js — the providers the router implements, in the order used
 * when configuration says nothing. Split from ai-config.js so the routing
 * table and the feature catalogue can both read it without a cycle; every
 * caller still imports it from ai-config.js or router.js (PROVIDERS).
 *
 * Owner decision, 2026-08-23: Gemini first, then OpenAI, then Claude. NVIDIA
 * (#701) is appended last and is placed per feature — see
 * PER_FEATURE_PROVIDERS in features-catalogue.js. By default it stays last
 * for content features, as their backup (2026-09-29), an administrator can
 * move it to the front for one feature, and for the public ones it is
 * removed.
 *
 * This is a cost ordering, not a quality one. Gemini Flash-Lite is roughly a
 * tenth of Claude Sonnet per token, and the work behind these calls — summarise
 * a page, write alt text, grade a draft — is well inside what the cheap model
 * does correctly. `CONTENTFORGE_AI_PROVIDER` still pins a provider outright,
 * and per-provider `order` in the portal overrides this list.
 *
 * Foundry (#849, 2026-10-04) is appended too and is also placed per feature:
 * 'first' for the content features the owner triggers, 'off' for the public
 * ones. Its global position is last so a stored card that predates it keeps
 * its order; the placement is what moves it to the front where it serves.
 *
 * MEDIA PROVIDERS (ADR 0034 slice 5, #860). ElevenLabs (the podcast voice)
 * and Replicate (image generation) join the catalogue and the resolver as
 * providers, so the audio and image tasks are chosen on the Tasks tab like
 * every other task. They are NOT in DEFAULT_PROVIDER_ORDER: that list is the
 * chat list — the Priority list on the AI Services tab, the chain the text
 * router fails over along, the cards with a switch — and a media provider
 * answers no chat call. They have no card either: a key is what switches
 * them on ("keyed is enabled"), and the catalogue drawer says so.
 * KNOWN_PROVIDERS is the set the selection document and the resolver accept
 * in a task's custom chain; PROVIDER_CAPABILITIES says what each provider
 * can carry at all, which is how a chain for a speech task can name
 * ElevenLabs and a chain for a drafting task cannot.
 */
export const DEFAULT_PROVIDER_ORDER = Object.freeze([
  'gemini',
  'openai',
  'anthropic',
  'nvidia',
  'foundry',
]);

/** The providers that serve audio and images only: keyed is enabled, no card, never in the Priority list. */
export const MEDIA_PROVIDERS = Object.freeze(['elevenlabs', 'replicate']);

/** Every provider a task's chain may name: the chat list, then the media providers. */
export const KNOWN_PROVIDERS = Object.freeze([...DEFAULT_PROVIDER_ORDER, ...MEDIA_PROVIDERS]);

/**
 * The capabilities each provider can carry at all (tasks.js CAPABILITIES),
 * whatever its models say: a chain step naming a provider that cannot carry
 * the task's `needs` is refused on save and turned away by the resolver.
 * Gemini's TTS models read through the Interactions API the speech side
 * already uses (listen-and-learn/speech/gemini.js); ElevenLabs is the
 * podcast voice (ADR 0029 §2b); Replicate makes the cover and manual images
 * (triggers/ai-cover.js). Gemini carries `stt` since ADR 0040 (#1565):
 * the interview transcription reads a recording through its Files API and
 * generateContent (lib/interviews/gemini-files.js). No provider carries
 * `ocr` or `embedding` yet, so those tasks show "no eligible model"
 * rather than being absent.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  gemini: Object.freeze(['text', 'json', 'vision', 'grounding', 'tts', 'stt']),
  openai: Object.freeze(['text', 'json', 'vision']),
  anthropic: Object.freeze(['text', 'json', 'vision']),
  nvidia: Object.freeze(['text', 'json']),
  foundry: Object.freeze(['text', 'json', 'vision']),
  elevenlabs: Object.freeze(['tts']),
  replicate: Object.freeze(['image']),
});

/** True when the provider can carry every capability in `needs`. */
export function providerCarries(provider, needs) {
  const carried = PROVIDER_CAPABILITIES[provider];
  return Array.isArray(carried) && (needs || []).every((need) => carried.includes(need));
}
