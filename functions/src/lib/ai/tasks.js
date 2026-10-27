/**
 * tasks.js — the AI task registry (ADR 0034 slice 1, #856).
 *
 * Every piece of work the site sends to a model is a task here: what it is
 * called, what it does, what an administrator will notice when it is off,
 * what kind of answer it needs (`modality`), the capabilities a model must
 * carry to serve it (`needs`), whether anonymous visitors can trigger it
 * (`public`), and the model the site recommends for it with the reason.
 *
 * `features-catalogue.js` derives AI_FEATURES (label, description, route) from
 * this table, so the feature switches, the call-site test and the portal's
 * toggles keep working unchanged; the ids are the feature names. The
 * catalogue (slice 2), the resolver (slice 3) and the Tasks tab (slice 4)
 * read `modality`, `needs` and `recommended`.
 *
 * RECOMMENDATIONS ARE CLAIMS WITH A DATE. Each names a provider and a model
 * the cost table prices (tasks.test.js refuses an unpriced one), and says
 * why in terms of cost, quality and measured latency, with the day the
 * claim was made. The weekly probe and the usage page are what contradict a
 * stale one; the fix is a new line here with a new date, reviewed like any
 * other code.
 *
 * Owner decisions behind the choices (2026-10-04): Microsoft Foundry is the
 * paid provider for content work, first for the content features and never
 * for the public explain route; GPT-5 mini for anything that reads a whole
 * draft or article, nano for short answers. The public route stays on
 * Gemini Flash-Lite, the cheapest fast model the owner has run there since
 * 2026-08-23. Source grounding is Gemini by construction (router.js header).
 *
 * THE AUDIO AND IMAGE TASKS (ADR 0034 slice 5, #860). Listen & Learn
 * speech, the podcast voice, the cover art and the manual images are tasks
 * here with their own `needs` (`tts`, `image`), and their call sites read
 * the selection document through the router's `modelForTask` instead of a
 * model field of their own; the settings pages that carried those fields
 * lost them. Each recommends the model that was its default the day before
 * — the migration (migrate-selection.js) turns a stored choice that
 * differed into that task's custom chain, so nothing changed for the owner
 * on merge. They default to mode `recommended` (`defaultMode`) because the
 * Priority list is a chat list and a media provider never joins it: a media
 * task in `global` mode would have nothing eligible. Three more tasks —
 * `recordingTranscript` (stt), `pageOcr` (ocr), `embeddings` (embedding) —
 * are registered with no provider carrying their need yet (`planned`): the
 * Tasks tab shows them as "no eligible model" rather than omitting them,
 * they have no feature switch and no call site, and `recommended` is null
 * because a recommendation nobody can serve would be a claim about nothing.
 *
 * `only` IS A PRODUCT RULE IN CODE, and no document lifts it (select.js
 * policy locks): the podcast voice is ElevenLabs and only ElevenLabs,
 * Listen & Learn is read by Gemini and never by ElevenLabs (ADR 0029 §2b;
 * Azure AI Speech is the adapter's own fallback, not a catalogue provider),
 * and the images are made by the one Replicate client. Without it the
 * Priority list's Gemini step, judged on Gemini's TTS recommendation, would
 * read the podcast the day the ElevenLabs recommendation was not yet
 * confirmed by a refresh.
 */

/** The kinds of answer a task asks for, the audio and image ones included (ADR 0034 §2). */
export const MODALITIES = Object.freeze([
  'text',
  'json',
  'vision',
  'tts',
  'image',
  'stt',
  'ocr',
  'embedding',
]);

/** The capabilities a model can carry; a task's `needs` is a subset. */
export const CAPABILITIES = Object.freeze([
  'text',
  'json',
  'vision',
  'grounding',
  'tts',
  'image',
  'stt',
  'ocr',
  'embedding',
]);

const ASOF = '2026-10-05';

const foundryMini = (why) =>
  Object.freeze({
    provider: 'foundry',
    model: 'gpt-5-mini',
    reason: `${why} GPT-5 mini on Foundry: $0.25 in / $2.00 out per 1M tokens, 2–3 s on the card's Test (2026-10-04), billed to the app subscription under its own budget.`,
    asOf: ASOF,
  });

const foundryNano = (why) =>
  Object.freeze({
    provider: 'foundry',
    model: 'gpt-5-nano',
    reason: `${why} GPT-5 nano on Foundry: $0.05 in / $0.40 out per 1M tokens, the cheapest model on the catalogue, 2.5 s on the card's Test (2026-10-04).`,
    asOf: ASOF,
  });

const geminiLite = (why) =>
  Object.freeze({
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    reason: `${why} Gemini 3.5 Flash-Lite: $0.30 in / $2.50 out per 1M tokens, 0.5 s on the card's Test, and the owner keeps the paid Foundry provider off the public route (2026-10-04).`,
    asOf: ASOF,
  });

const task = (fields) => Object.freeze(fields);

export const AI_TASKS = Object.freeze({
  brainAssistant: task({
    label: 'Second Brain assistant',
    description: 'Answers owner-requested questions from private creator notes with source citations.',
    route: 'Second Brain → Ask. Off leaves search and notes available.',
    modality: 'json', needs: ['text', 'json'], public: false,
    only: ['foundry'], defaultMode: 'recommended',
    recommended: foundryMini('Reads bounded private excerpts and returns cited claims. Private workspace material stays on the existing Foundry content provider.'),
  }),
  inspector: task({
    label: 'Content Inspector',
    description: 'Generates title, summary and tags for an ingested article.',
    route: 'Article ingest (change feed) and the Inspect action in the portal.',
    modality: 'json',
    needs: ['text', 'json'],
    public: false,
    recommended: foundryMini('Reads a whole article and returns structured fields.'),
  }),
  altText: task({
    label: 'Image alt text',
    description: 'Writes alt text for images found on an inspected page.',
    route: 'Runs with the inspector; accessibility text on article images.',
    modality: 'vision',
    needs: ['text', 'vision'],
    public: false,
    recommended: foundryMini('Looks at the image itself; mini supports image inputs.'),
  }),
  critique: task({
    label: 'Inspector critique',
    description: 'Second pass that judges and improves the inspector output.',
    route: 'Article ingest. Turning it off keeps the inspector, drops the review.',
    modality: 'json',
    needs: ['text', 'json'],
    public: false,
    recommended: foundryMini('Judges the inspector against the article; a quality pass.'),
  }),
  forgeDrafting: task({
    label: 'Forge drafting',
    description: 'Writes the draft body for a Content Forge job.',
    route: 'Forge jobs and the nightly Auto-Forge timer. This is the writing.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryMini('The longest output on the site; the mini tier writes it at a fifth of GPT-5’s price.'),
  }),
  forgeGrading: task({
    label: 'Forge grading',
    description: 'Scores a forged draft before it is offered for publication.',
    route: 'Forge jobs. Off means drafts arrive ungraded, not that they stop.',
    modality: 'json',
    needs: ['text', 'json'],
    public: false,
    recommended: foundryMini('Reads a whole draft and scores it.'),
  }),
  telegram: task({
    label: 'Telegram assistant',
    description: 'Free-form replies to messages sent to the Telegram bot.',
    route: 'The bot answers commands either way; only AI replies stop.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryNano('Short owner-only replies where speed matters more than depth.'),
  }),
  voiceCalibration: task({
    label: 'Voice calibration',
    description: 'Suggests voice-profile additions from recent published posts.',
    route: 'The Calibrate button in Forge Studio. Suggestions only, never auto-applied.',
    modality: 'json',
    needs: ['text', 'json'],
    public: false,
    recommended: foundryMini('Reads several published posts at once and returns structured suggestions.'),
  }),
  socialCaption: task({
    label: 'Social captions',
    description: 'Writes a social-media caption for a published article.',
    route: 'The Social Hub Generate button and the on-publish auto-queue to Publer.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryNano('A caption is a sentence or two.'),
  }),
  listenAndLearn: task({
    label: 'Listen & Learn scripts',
    description: 'Scripts a two-host study episode for one skill area of a certification guide.',
    route:
      'The Generate button on the Listen & Learn page, and Regenerate on one area. Off means the run fails before the model is called; existing episodes stay.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryMini('A long two-voice script from a study guide.'),
  }),
  sourceGrounding: task({
    label: 'Source grounding',
    description: 'Reads owner-supplied web pages and YouTube videos to ground a generation.',
    route: 'Listen & Learn source-grounded episodes (#433).',
    modality: 'json',
    needs: ['text', 'json', 'grounding'],
    public: false,
    recommended: Object.freeze({
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      reason:
        'The only provider that reads pages and YouTube videos, through the Interactions API (router.js header); Gemini 3.6 Flash: $1.50 in / $7.50 out per 1M tokens including the fetched pages.',
      asOf: ASOF,
    }),
  }),
  podcastScript: task({
    label: 'Podcast transcripts',
    description: 'Scripts a two-host podcast episode from a published article.',
    route:
      'The Podcast transcript action on the Publish page. Off means the job fails before the model is called; existing transcripts stay.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryMini('A long two-voice script from an article.'),
  }),
  pricingExplain: task({
    label: 'Pricing explanations',
    description:
      'Explains a priced scenario on the public cloud pricing comparison: which provider is cheapest and what could flip it.',
    route:
      'The "Explain this number" button on /tools/comparison — the one anonymous AI call. Off answers "Explanations are not available" before any quota is counted; cached explanations still serve (#613).',
    modality: 'text',
    needs: ['text'],
    public: true,
    recommended: geminiLite('Anonymous traffic, short answers, cached.'),
  }),
  forgeAssist: task({
    label: 'Forge Studio assist',
    description:
      'Outlines, expands, condenses, rewrites, retitles or fact-checks a draft from an action in Forge Studio.',
    route:
      'The AI actions on the Draft tab in Forge Studio (ADR 0033). Off means each button answers that the feature is switched off; the draft text is untouched.',
    modality: 'text',
    needs: ['text'],
    public: false,
    recommended: foundryMini('Rewrites and expands whole drafts while the owner waits.'),
  }),
  landingZoneExplain: task({
    label: 'Landing zone explanations',
    description:
      'Explains one Landing Zone Builder component for the learner’s selection and options: why it matters, and what changes without it.',
    route:
      'The "Explain this component" button on /tools/landing-zone — the same anonymous explain route, cache and quota as pricing explanations, as kind landing-zone. Off answers "Explanations are not available" before any quota is counted; cached explanations still serve (#669).',
    modality: 'text',
    needs: ['text'],
    public: true,
    recommended: geminiLite('Anonymous traffic, short answers, cached.'),
  }),
  // ── audio and image (ADR 0034 slice 5, #860) ──────────────────────────────
  listenAndLearnSpeech: task({
    label: 'Listen & Learn speech',
    description: 'Reads a Listen & Learn episode or chapter aloud.',
    route:
      'Every Listen & Learn run that makes audio. Off means the run fails before the voice is called; existing audio stays. Azure AI Speech stays the adapter’s own fallback (listen-and-learn/speech/index.js).',
    modality: 'tts',
    needs: ['tts'],
    public: false,
    only: ['gemini'],
    defaultMode: 'recommended',
    recommended: Object.freeze({
      provider: 'gemini',
      model: 'gemini-3.8-flash-tts',
      reason:
        'Google recommends 3.8 Flash TTS for long-form multi-speaker fidelity. $0.50 text input / $9 audio output per 1M through 2026-12-31; $1 / $18 thereafter. 3.8 Flash-Lite TTS is the cheaper Custom option ($0.50 / $6 through 2026-12-31, then $1 / $12). Existing explicit model choices are preserved.',
      asOf: '2026-10-27',
    }),
  }),
  podcastVoice: task({
    label: 'Podcast voice',
    description: 'Reads a podcast transcript aloud for Podbean.',
    route:
      'Every podcast render and the Audio tab’s live check. Off means the transcript is saved without audio. ElevenLabs is the only podcast voice (ADR 0029 §2b).',
    modality: 'tts',
    needs: ['tts'],
    public: false,
    only: ['elevenlabs'],
    defaultMode: 'recommended',
    recommended: Object.freeze({
      provider: 'elevenlabs',
      model: 'eleven_v3',
      reason:
        'The one model the Text to Dialogue endpoint serves, USD 0.10 per 1,000 characters on the Starter and Creator plans (read 2026-09-08); the default since the podcast voice landed (#436).',
      asOf: ASOF,
    }),
  }),
  coverArt: task({
    label: 'Cover art',
    description: 'Generates the cover image for a content document.',
    route:
      'The cover trigger on publish (change feed) and Generate cover on the Publish page. Off means the document stages with the default hero instead.',
    modality: 'image',
    needs: ['image'],
    public: false,
    only: ['replicate'],
    defaultMode: 'recommended',
    recommended: Object.freeze({
      provider: 'replicate',
      model: 'google/imagen-4-fast',
      reason:
        'USD 0.02 per output image on replicate.com (read 2026-10-05), about three seconds a cover; the model every cover has been made with since the port.',
      asOf: ASOF,
    }),
  }),
  manualImages: task({
    label: 'Images made by hand',
    description: 'Generates images from the Images pages: previews, curated article images, samples.',
    route:
      'The Generate buttons on the Images pages. Off means each button answers that the feature is switched off; nothing is generated.',
    modality: 'image',
    needs: ['image'],
    public: false,
    only: ['replicate'],
    defaultMode: 'recommended',
    recommended: Object.freeze({
      provider: 'replicate',
      model: 'google/imagen-4-fast',
      reason:
        'The same model and price as the cover art (USD 0.02 per image, read 2026-10-05); one image path, not two.',
      asOf: ASOF,
    }),
  }),
  recordingTranscript: task({
    label: 'Recording transcripts',
    description: 'Transcribes an uploaded recording to text.',
    route: 'No provider carries speech-to-text yet; the task is listed so the gap is visible.',
    modality: 'stt',
    needs: ['stt'],
    public: false,
    planned: true,
    recommended: null,
  }),
  pageOcr: task({
    label: 'Page OCR',
    description: 'Reads the text in a scanned page or screenshot.',
    route: 'No provider carries OCR yet; the task is listed so the gap is visible.',
    modality: 'ocr',
    needs: ['ocr'],
    public: false,
    planned: true,
    recommended: null,
  }),
  embeddings: task({
    label: 'Embeddings',
    description: 'Turns text into vectors for search and similarity.',
    route: 'No provider carries embeddings yet; the task is listed so the gap is visible.',
    modality: 'embedding',
    needs: ['embedding'],
    public: false,
    planned: true,
    recommended: null,
  }),
});

export const TASK_NAMES = Object.freeze(Object.keys(AI_TASKS));

/** The task for an id, or undefined. */
export function taskFor(id) {
  return Object.hasOwn(AI_TASKS, id) ? AI_TASKS[id] : undefined;
}

/** The ids anonymous visitors can trigger: where a trial-tier provider must never serve. */
export const PUBLIC_TASKS = Object.freeze(TASK_NAMES.filter((id) => AI_TASKS[id].public));

/** The modalities whose call sites spend on audio or images, never on tokens (slice 5). */
export const MEDIA_MODALITIES = Object.freeze(['tts', 'image', 'stt', 'ocr', 'embedding']);

/** True for a task that answers with audio, an image, a transcript, OCR text or vectors. */
export const isMediaTask = (task) => Boolean(task) && MEDIA_MODALITIES.includes(task.modality);

/** The tasks registered ahead of any provider that can serve them (header). */
export const PLANNED_TASKS = Object.freeze(TASK_NAMES.filter((id) => AI_TASKS[id].planned === true));

/** The mode a task is in when the selection document says nothing about it. */
export const defaultModeFor = (task) => task?.defaultMode || 'global';
