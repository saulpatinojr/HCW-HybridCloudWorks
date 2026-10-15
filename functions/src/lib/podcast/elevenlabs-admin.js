/**
 * elevenlabs-admin.js: the podcast voice's account, on the Audio tab of the
 * Platform settings page, and the owner's cheap live check (#432; ADR 0029
 * §2a, amended 2026-09-26).
 *
 * Four routes, all `editor`, the level of the routes that generate podcast
 * audio (which spend far more than any of these):
 *
 *   GET  cms/podcast/elevenlabs          the plan, credits used / limit, the
 *                                        reset date, what the last render
 *                                        billed, and the last sample to
 *                                        replay (`lastSample`)
 *   POST cms/podcast/elevenlabs/sample   renders SAMPLE_DIALOGUE, two turns
 *                                        and under 300 characters, through
 *                                        the real provider, in the saved
 *                                        podcast voices
 *   GET  cms/podcast/elevenlabs/voices   the voices this key may list, each
 *                                        marked usable on the current plan or
 *                                        not, and why (#725)
 *   GET  cms/podcast/elevenlabs/voices/{voiceId}/preview
 *                                        that voice's preview MP3, fetched
 *                                        from ElevenLabs's preview host only
 *                                        (#725; the allowlist is in
 *                                        speech/elevenlabs-preview.js)
 *
 * The two voice routes spend no credits: a listing and a preview are reads.
 * The owner picks two voices by ear with them and saves the choice through
 * the Platform settings route (`podcast-voices`); the live check and every
 * episode read that choice (podcast/voice-settings.js).
 *
 * ## Not configured is an answer
 *
 * With no `ELEVENLABS_API_KEY` the status route answers 200 with
 * `configured: false` and the sentence naming the secret. It does not answer
 * with an error: an unseeded key is a state the page shows, the way the
 * Integrations page shows "Not configured". The sample route cannot do its
 * job without the key, so it answers 503 with the same sentence and sends
 * nothing.
 *
 * ## The live check spends about 300 credits, never more
 *
 * The sample is fixed here. The caller sends no text, so the route cannot be
 * used to spend the month. It goes through `synthesizeDialogue` with the
 * `podcast` product, which is the same path an episode takes: the product
 * switch, the pin, the credit pre-flight, the voices, the model and the
 * chunker. So a pass means an episode would reach ElevenLabs the same way.
 * Its MP3 is stored at one fixed path in the `podcast` container, overwritten
 * by the next check. It is served the way every transcript's audio is,
 * anonymously, through the media route. The URL carries a version because
 * that route answers `immutable`. The usage row is its own source,
 * `podcast:sample`, so the check never reads as episode spend.
 *
 * ## Replaying the last sample costs nothing
 *
 * Owner request 2026-09-27: two live checks were spent only to test playback,
 * because the page showed a player only for a check run in the same session.
 * So a stored sample is recorded in `admin_config/podcast_last_sample`: its
 * URL with the version, the two voice ids (and names, when this instance's
 * voice listing is cached; nothing is listed to find them), the characters
 * billed and the time. Only the latest is kept, as the blob is. The status
 * route returns it as `lastSample` after checking the blob still exists (a
 * HEAD on our own storage), and the page plays it from the media route. None
 * of that reaches ElevenLabs. A sample stored before the record existed is
 * still returned (`recorded: false`), from the blob, the newest
 * `podcast:sample` usage row, and the saved voices when they were saved
 * before that row.
 *
 * ## "Credits left" after the check
 *
 * ElevenLabs may update `character_count` a moment after the request that
 * spent it. So the figure reported is the lower of a fresh read and "before,
 * minus what the response said it billed". A lagging read then cannot report
 * the credits as unspent.
 *
 * ## Shape
 *
 * Each route is a module-level function taking the resolved dependencies;
 * `createElevenLabsHandlers` only binds them. Small functions, each doing one
 * step, rather than one closure holding both routes.
 */
import { authoredMessage, errorCode } from '../http/error-response.js';
import { readSetting, synthesizeDialogue } from '../listen-and-learn/speech/index.js';
import {
  API_KEYS_PAGE,
  readSubscription,
} from '../listen-and-learn/speech/elevenlabs-account.js';
import {
  ELEVENLABS_DEFAULT_VOICES,
  INVALID_VOICE,
  VOICES_NOT_CHOSEN,
  characterCount,
  voicesNotChosenMessage,
} from '../listen-and-learn/speech/elevenlabs.js';
import {
  FREE_PLAN_RULE,
  PREVIEW_FAILED,
  PREVIEW_UNAVAILABLE,
  VOICES_UNAVAILABLE,
  VOICE_NOT_LISTED,
  cachedVoiceNames,
  fetchVoicePreview,
  isElevenLabsVoiceId,
  readVoices,
  voicesForPlan,
} from '../listen-and-learn/speech/elevenlabs-voices.js';
import { USAGE_CONTAINER, USAGE_SOURCES, recordAiUsage } from '../ai/usage.js';
import { mediaUrlFor } from '../blob-paths.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { PODCAST_AUDIO_CONTAINER } from './store.js';
import {
  PODCAST_HOSTS,
  PODCAST_VOICES_CONFIG_ID,
  readStoredPodcastVoices,
} from './voice-settings.js';

export const ELEVENLABS_KEY_SETTING = 'ELEVENLABS_API_KEY';

/** Where the owner seeds the key: the Integrations page's Keys tab. */
export const SEED_KEY_PAGE = 'https://hybridcloudworks.com/admin/integrations?tab=keys';

export const NOT_CONFIGURED_REASON =
  `${ELEVENLABS_KEY_SETTING} is not configured. Create a key at ${API_KEYS_PAGE} and seed it ` +
  `as the ELEVENLABS-API-KEY secret at ${SEED_KEY_PAGE}.`;

/** The live check's one blob, overwritten each run. */
export const SAMPLE_AUDIO_PATH = 'sample/elevenlabs-live-check.mp3';

/** The sample's media URL, without the `?v=` version. */
export const SAMPLE_MEDIA_URL = mediaUrlFor(PODCAST_AUDIO_CONTAINER, SAMPLE_AUDIO_PATH);

/** The `admin_config` document recording the latest stored sample, for a free replay. */
export const LAST_SAMPLE_CONFIG_ID = 'podcast_last_sample';

/** The ceiling the owner set for the check; the sample is held under it by a test. */
export const SAMPLE_MAX_CHARACTERS = 300;

/**
 * Two turns, one per host, so the check proves both voices and the dialogue
 * endpoint's turn-taking. Fixed text: the caller cannot send its own.
 */
export const SAMPLE_DIALOGUE = Object.freeze([
  Object.freeze({
    speaker: 'Maya',
    text:
      'Welcome to a short sound check for the HybridCloudWorks podcast. I am Maya, ' +
      'and this sample is read through ElevenLabs so you can hear the voices and see what it cost.',
  }),
  Object.freeze({
    speaker: 'Elena',
    text: 'And I am Elena. If you can hear two different voices, a full episode will sound like this.',
  }),
]);

export const SAMPLE_CHARACTERS = SAMPLE_DIALOGUE.reduce(
  (total, turn) => total + characterCount(turn.text),
  0
);

const SAMPLE_INFO = Object.freeze({ characters: SAMPLE_CHARACTERS, turns: SAMPLE_DIALOGUE.length });

/**
 * The newest ElevenLabs usage row, whatever wrote it: an episode or a live
 * check. `ai_usage` is partitioned on `/id` with every path indexed
 * (infra/cosmos-containers.json), so a single-property ORDER BY needs no
 * composite index. `product` travels beside `source` (ADR 0034 slice 5,
 * #860): an episode row written since then is `source: ai:podcastVoice,
 * product: podcast:audio`, one written before carries only
 * `source: podcast:audio`, and the card keys on `product` with `source` as
 * the historical fallback so both read as "an episode".
 */
const LAST_RENDER_QUERY =
  'SELECT TOP 1 c.completionTokens, c.estimatedTokens, c.timestamp, c.source, c.product, c.model ' +
  'FROM c WHERE c.provider = @provider ORDER BY c.timestamp DESC';

/** The newest live check's usage row: what a sample stored before its record billed. */
const LAST_SAMPLE_USAGE_QUERY =
  'SELECT TOP 1 c.completionTokens, c.estimatedTokens, c.timestamp, c.model ' +
  'FROM c WHERE c.provider = @provider AND c.source = @source ORDER BY c.timestamp DESC';

/** A voice name as recorded: a bounded string, or null. */
const MAX_VOICE_NAME_LENGTH = 100;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Refusals the owner fixes on this page or in ElevenLabs, not by retrying:
 * credit, a paid-only voice, no voice chosen, a voice that is not an id.
 */
const CONFLICT_CODES = new Set(['quota_exceeded', 'paid_plan_required', VOICES_NOT_CHOSEN, INVALID_VOICE]);

/** The HTTP status for a speech failure on the sample route. */
function statusFor(error) {
  if (error?.name === 'SpeechNotConfiguredError') return 503;
  // The podcastVoice task has nothing eligible, or is switched off (ADR 0034 slice 5).
  if (error?.code === 'AI_NOT_CONFIGURED' || error?.code === 'AI_FEATURE_DISABLED') return 503;
  if (CONFLICT_CODES.has(error?.code)) return 409;
  return 502;
}

/** A usage row as the card shows it: `product` beside `source` (LAST_RENDER_QUERY). */
const presentRender = (row) => ({
  characters: Number(row.completionTokens) || 0,
  estimated: row.estimatedTokens === true,
  at: row.timestamp || null,
  source: row.source || null,
  product: row.product || null,
  model: row.model || null,
});

/** `{ lastRender, lastRenderError }`; a failed read is said, not shown as "none yet". */
async function readLastRender({ store }, context) {
  try {
    const rows = await store.queryDocs(USAGE_CONTAINER, LAST_RENDER_QUERY, [
      { name: '@provider', value: 'elevenlabs' },
    ]);
    return { lastRender: rows?.[0] ? presentRender(rows[0]) : null, lastRenderError: null };
  } catch (error) {
    context.warn?.(`elevenLabsStatus: usage read failed (${error?.code ?? 'unknown'})`);
    return { lastRender: null, lastRenderError: 'The usage table could not be read.' };
  }
}

/** One recorded voice, `{ voiceId, name }`, or null when the id is not one. */
function presentVoice(entry) {
  const voiceId = entry?.voiceId;
  if (!isElevenLabsVoiceId(voiceId)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_VOICE_NAME_LENGTH) : '';
  return { voiceId, name: name || null };
}

/** `{ Maya: { voiceId, name }, Elena: … }`, or null unless every host has an id. */
function presentVoices(voices) {
  const out = {};
  for (const host of PODCAST_HOSTS) {
    const voice = presentVoice(voices?.[host]);
    if (!voice) return null;
    out[host] = voice;
  }
  return out;
}

/** `{ Maya: id, Elena: id }` as recorded, each with the name `names` holds for it. */
const namedVoices = (voices, names) =>
  presentVoices(
    Object.fromEntries(
      PODCAST_HOSTS.map((host) => [
        host,
        { voiceId: voices?.[host], name: names.get(voices?.[host]) ?? null },
      ])
    )
  );

/** Whether a URL is the sample's own media URL with a version. */
function isSampleUrl(url) {
  const prefix = `${SAMPLE_MEDIA_URL}?v=`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) return false;
  return /^[A-Za-z0-9]{1,64}$/.test(url.slice(prefix.length));
}

/**
 * The recorded document as `lastSample`, or null when it is not one. The URL
 * must be the sample's own media URL, so a hand-edited document cannot point
 * the page's player anywhere else.
 */
function presentLastSample(doc) {
  if (!isSampleUrl(doc?.audioUrl)) return null;
  return {
    audioUrl: doc.audioUrl,
    renderedAt: typeof doc.renderedAt === 'string' ? doc.renderedAt : null,
    voices: presentVoices(doc.voices),
    charactersBilled: Number.isFinite(doc.charactersBilled) ? doc.charactersBilled : null,
    billedEstimated: doc.billedEstimated === true,
    model: typeof doc.model === 'string' ? doc.model : null,
    recorded: true,
  };
}

/**
 * The sample blob's state: `present` (with its etag), `missing`, or
 * `unknown` when the HEAD failed. A HEAD on our own storage, never
 * ElevenLabs.
 */
async function sampleBlob({ storage }, context) {
  try {
    const head = await storage.headBlobForDelivery(PODCAST_AUDIO_CONTAINER, SAMPLE_AUDIO_PATH);
    return head ? { state: 'present', etag: head.etag || '' } : { state: 'missing' };
  } catch (error) {
    context.warn?.(`elevenLabsStatus: sample blob check failed (${error?.code ?? 'unknown'})`);
    return { state: 'unknown' };
  }
}

/** The version an unrecorded sample plays at: its etag, else its usage row's time. */
function unrecordedVersion(etag, renderedAt) {
  const token = String(etag || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 64);
  if (token) return token;
  const ms = Date.parse(renderedAt);
  return Number.isFinite(ms) ? String(ms) : '0';
}

/**
 * The saved voices, when they were saved before `renderedAt`. A live check
 * reads the saved pair as it runs, so a pair saved earlier is the pair it
 * used. One saved later, or at an unknown time, is not claimed.
 */
async function voicesSavedBefore(doc, renderedAt) {
  const voices = await readStoredPodcastVoices(async () => doc);
  const savedAt = Date.parse(doc?.updatedAt);
  if (!voices || !(savedAt <= Date.parse(renderedAt))) return null;
  return namedVoices(voices, new Map());
}

/**
 * A sample stored before its record existed (the owner's checks of
 * 2026-09-27): the blob, the newest `podcast:sample` usage row's time and
 * billing, and the voices only where they can be shown to be the ones used.
 */
async function unrecordedSample({ store }, etag) {
  const [rows, voicesDoc] = await Promise.all([
    store.queryDocs(USAGE_CONTAINER, LAST_SAMPLE_USAGE_QUERY, [
      { name: '@provider', value: 'elevenlabs' },
      { name: '@source', value: USAGE_SOURCES.podcastSample },
    ]),
    store.readDoc('admin_config', PODCAST_VOICES_CONFIG_ID, ADMIN_CONFIG_PARTITION),
  ]);
  const row = rows?.[0] ?? null;
  const renderedAt = typeof row?.timestamp === 'string' ? row.timestamp : null;
  return {
    audioUrl: `${SAMPLE_MEDIA_URL}?v=${unrecordedVersion(etag, renderedAt)}`,
    renderedAt,
    voices: await voicesSavedBefore(voicesDoc, renderedAt),
    charactersBilled: row ? Number(row.completionTokens) || 0 : null,
    billedEstimated: row?.estimatedTokens === true,
    model: row?.model || null,
    recorded: false,
  };
}

/**
 * `{ lastSample, lastSampleError }`: the sample a replay plays, for nothing.
 * A sample whose blob is gone is not offered; one whose blob could not be
 * checked is returned as recorded. A failed read is said, not shown as "no
 * sample yet".
 */
async function readLastSample(deps, context) {
  try {
    const [doc, blob] = await Promise.all([
      deps.store.readDoc('admin_config', LAST_SAMPLE_CONFIG_ID, ADMIN_CONFIG_PARTITION),
      sampleBlob(deps, context),
    ]);
    if (blob.state === 'missing') return { lastSample: null, lastSampleError: null };
    const recorded = presentLastSample(doc);
    if (recorded || blob.state !== 'present') {
      return { lastSample: recorded, lastSampleError: null };
    }
    return { lastSample: await unrecordedSample(deps, blob.etag), lastSampleError: null };
  } catch (error) {
    context.warn?.(`elevenLabsStatus: last sample read failed (${error?.code ?? 'unknown'})`);
    return { lastSample: null, lastSampleError: 'The last sample could not be read.' };
  }
}

/**
 * `{ subscription, subscriptionError }`. The error sentence names the cause
 * and the fix (a permission, a key); it never carries the key.
 */
async function readAccountState({ readAccount, fetchImpl }, key) {
  try {
    return { subscription: await readAccount({ key, fetchImpl }), subscriptionError: null };
  } catch (error) {
    // ElevenLabsSpeechError sentences are authored; anything else is not
    // shown (#945).
    return {
      subscription: null,
      subscriptionError: authoredMessage(error, 'The ElevenLabs subscription could not be read.'),
    };
  }
}

/** GET /api/cms/podcast/elevenlabs */
async function getStatus(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const [usage, replay] = await Promise.all([
      readLastRender(deps, context),
      readLastSample(deps, context),
    ]);
    const key = readSetting(deps.env, ELEVENLABS_KEY_SETTING);
    const account = key
      ? await readAccountState(deps, key)
      : { subscription: null, subscriptionError: null };
    return json(200, {
      success: true,
      configured: Boolean(key),
      reason: key ? null : NOT_CONFIGURED_REASON,
      ...account,
      ...usage,
      ...replay,
      sample: SAMPLE_INFO,
    });
  } catch (error) {
    context.error('elevenLabsStatus failed:', error);
    return json(500, { error: 'Failed to read the ElevenLabs status' });
  }
}

/** Store the sample's MP3; `{ audioUrl, audioError }`, never a throw. */
async function storeSample({ storage }, rendered, at) {
  try {
    await storage.uploadBlob(
      PODCAST_AUDIO_CONTAINER,
      SAMPLE_AUDIO_PATH,
      rendered.audio,
      rendered.contentType,
      { sourceKind: 'sample' }
    );
    return { audioUrl: `${SAMPLE_MEDIA_URL}?v=${at.getTime()}`, audioError: null };
  } catch (error) {
    // The store's own words stay out of the answer (#945); its code says which failure.
    return {
      audioUrl: null,
      audioError: `The sample was rendered and billed but not stored (${errorCode(error)}).`,
    };
  }
}

/**
 * The account after the check: `{ account, creditsLeft }`, where creditsLeft
 * is the lower of a fresh read and "before minus billed" (see the header).
 */
async function creditsAfter({ readAccount, fetchImpl }, key, before, billed) {
  const after = await readAccount({ key, fetchImpl, useCache: false }).catch(() => null);
  const computed = before ? Math.max(0, before.creditsLeft - billed) : null;
  const fresh = after ? after.creditsLeft : null;
  const known = [computed, fresh].filter((n) => typeof n === 'number');
  return { account: after || before, creditsLeft: known.length ? Math.min(...known) : null };
}

/** The live check's answer, from what was rendered, stored and read. */
function sampleReport(rendered, stored, { account, creditsLeft }, before, billed) {
  return {
    ok: true,
    ...stored,
    contentType: rendered.contentType,
    bytes: rendered.bytes ?? rendered.audio?.length ?? 0,
    durationSeconds: rendered.estimatedSeconds ?? null,
    requests: rendered.requests ?? null,
    model: rendered.model ?? null,
    characters: rendered.characters ?? SAMPLE_CHARACTERS,
    charactersBilled: billed,
    billedEstimated: rendered.estimatedTokens === true,
    creditsLeftBefore: before?.creditsLeft ?? null,
    creditsLeft,
    creditLimit: account?.creditLimit ?? null,
    tier: account?.tier ?? null,
    freePlan: account?.freePlan ?? null,
    resetAt: account?.resetAt ?? null,
  };
}

/**
 * Record a stored sample for a free replay (see the header), and return it as
 * `lastSample`. Best effort: the audio is stored and billed either way, so a
 * failed write is logged rather than reported as a failed check.
 */
async function recordLastSample(deps, run, rendered, { audioUrl, at, billed }, context) {
  const doc = {
    id: LAST_SAMPLE_CONFIG_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    audioUrl,
    voices: namedVoices(run.voices, deps.voiceNames(run.key)),
    charactersBilled: billed,
    billedEstimated: rendered.estimatedTokens === true,
    model: rendered.model ?? null,
    renderedAt: at.toISOString(),
  };
  try {
    await deps.store.upsertDoc('admin_config', doc);
  } catch (error) {
    context.warn?.(`elevenLabsSample: stored but not recorded for replay (${error?.code ?? 'unknown'})`);
  }
  return presentLastSample(doc);
}

/**
 * Everything after a successful render: store the MP3 and record it for
 * replay, record the usage row (credits were spent whether or not the upload
 * worked), read the account again, and report.
 */
async function reportSample(deps, run, rendered, context) {
  const billed = Number(rendered.completionTokens) || 0;
  const before = rendered.subscription || null;
  const at = deps.now();
  const stored = await storeSample(deps, rendered, at);
  const lastSample = stored.audioUrl
    ? await recordLastSample(deps, run, rendered, { audioUrl: stored.audioUrl, at, billed }, context)
    : null;
  await recordAiUsage(
    { store: deps.store, ai: deps.ai },
    {
      provider: rendered.provider,
      model: rendered.model,
      promptTokens: 0,
      completionTokens: billed,
      estimatedTokens: rendered.estimatedTokens === true,
      source: USAGE_SOURCES.podcastSample,
    }
  );
  const credits = await creditsAfter(deps, run.key, before, billed);
  return { ...sampleReport(rendered, stored, credits, before, billed), lastSample };
}

/**
 * What the check needs before it may spend anything, or the refusal to
 * answer with: the key (503 without it), then the voices. The saved choice
 * wins over the code's defaults (which are empty); a host still without a
 * voice is a 409 that sends nothing, so the check never reaches ElevenLabs
 * to learn what this page already knows.
 *
 * @returns {Promise<{ key: string, voices: Record<string,string> } | { refusal: object }>}
 */
async function samplePreconditions(deps, context) {
  const key = readSetting(deps.env, ELEVENLABS_KEY_SETTING);
  if (!key) return { refusal: json(503, { error: NOT_CONFIGURED_REASON, code: 'NOT_CONFIGURED' }) };
  let stored;
  try {
    stored = await deps.readVoices(deps.store);
  } catch (error) {
    context.warn?.(`elevenLabsSample: podcast voices read failed (${error?.code ?? 'unknown'})`);
    return {
      refusal: json(502, {
        error: 'The saved podcast voices could not be read.',
        code: 'VOICES_UNREADABLE',
      }),
    };
  }
  const voices = { ...ELEVENLABS_DEFAULT_VOICES, ...(stored || {}) };
  const unchosen = PODCAST_HOSTS.filter((host) => !isElevenLabsVoiceId(voices[host]));
  if (unchosen.length > 0) {
    return {
      refusal: json(409, { error: voicesNotChosenMessage(unchosen), code: VOICES_NOT_CHOSEN }),
    };
  }
  return { key, voices };
}

/** The 200 for a rendered sample, or a 500 if reporting it failed after the spend. */
async function respondWithReport(deps, run, rendered, context) {
  try {
    const report = await reportSample(deps, run, rendered, context);
    context.log?.(`elevenLabsSample: rendered, ${report.charactersBilled} characters billed`);
    return json(200, report);
  } catch (error) {
    context.error('elevenLabsSample failed after rendering:', error);
    return json(500, { error: 'The sample was rendered but the result could not be reported' });
  }
}

/** POST /api/cms/podcast/elevenlabs/sample */
async function renderSample(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const { key, voices, refusal } = await samplePreconditions(deps, context);
  if (refusal) return refusal;

  // The sample reads with the podcastVoice task's model (ADR 0034 slice 5),
  // so a check hears the voice an episode will get; a task with nothing
  // eligible or switched off is refused with the resolver's sentence.
  let model = null;
  if (typeof deps.ai?.modelForTask === 'function') {
    try {
      model = (await deps.ai.modelForTask({ task: 'podcastVoice' })).model;
    } catch (error) {
      context.log?.(`elevenLabsSample: refused (${error?.code || error?.name || 'error'})`);
      return json(statusFor(error), {
        error: authoredMessage(error, 'The podcast voice model could not be chosen.'),
        code: error?.code || error?.name || null,
      });
    }
  }

  let rendered;
  try {
    rendered = await deps.synthesize({
      product: 'podcast',
      dialogue: SAMPLE_DIALOGUE,
      voices,
      model,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    context.log?.(`elevenLabsSample: refused (${error?.code || error?.name || 'error'})`);
    return json(statusFor(error), {
      error: authoredMessage(error, 'The sample could not be rendered.'),
      code: error?.code || error?.name || null,
    });
  }

  return respondWithReport(deps, { key, voices }, rendered, context);
}

/**
 * GET /api/cms/podcast/elevenlabs/voices
 *
 * The plan the list is judged against is the cached subscription read the
 * status route shares. A failed read is reported beside the list, and the
 * list is then judged as the free plan would judge it.
 */
async function listVoices(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const key = readSetting(deps.env, ELEVENLABS_KEY_SETTING);
  const base = { success: true, rule: FREE_PLAN_RULE };
  if (!key) {
    return json(200, { ...base, configured: false, reason: NOT_CONFIGURED_REASON, voices: [] });
  }
  try {
    const { subscription, subscriptionError } = await readAccountState(deps, key);
    const plan = subscription ? { tier: subscription.tier, freePlan: subscription.freePlan } : null;
    let listing;
    try {
      listing = await deps.listVoices({ key, fetchImpl: deps.fetchImpl });
    } catch (error) {
      if (error?.code !== VOICES_UNAVAILABLE) throw error;
      // A refused listing (most often a key without Voices → Read) is a state
      // the page shows with the fix, like a refused subscription read.
      return json(200, {
        ...base,
        configured: true,
        plan,
        subscriptionError,
        voices: [],
        truncated: false,
        voicesError: authoredMessage(error, 'The ElevenLabs voices could not be listed.'),
      });
    }
    return json(200, {
      ...base,
      configured: true,
      plan,
      subscriptionError,
      voices: voicesForPlan(listing.voices, subscription),
      truncated: listing.truncated === true,
      voicesError: null,
    });
  } catch (error) {
    context.error('elevenLabsVoices failed:', error?.message || error);
    return json(500, { error: 'Failed to list the ElevenLabs voices' });
  }
}

/**
 * The HTTP status for a preview refusal, from its code alone. An upstream
 * status is never passed through: ElevenLabs's 401 for a key without
 * Voices → Read would read, to the page, as the owner's session expiring.
 */
function previewStatus(error) {
  if (error?.code === VOICE_NOT_LISTED) return error.status === 400 ? 400 : 404;
  if (error?.code === PREVIEW_UNAVAILABLE) return 404;
  return 502;
}

const PREVIEW_REFUSALS = new Set([
  VOICE_NOT_LISTED,
  PREVIEW_UNAVAILABLE,
  PREVIEW_FAILED,
  VOICES_UNAVAILABLE,
]);

/** A failed preview as its answer: its own sentence by code, or a bare 500. */
function previewRefusal(error, context) {
  if (!PREVIEW_REFUSALS.has(error?.code)) {
    context.error('elevenLabsPreview failed:', error?.message || error);
    return json(500, { error: 'Failed to fetch the voice preview' });
  }
  context.log?.(`elevenLabsPreview: refused (${error.code})`);
  return json(previewStatus(error), {
    error: authoredMessage(error, 'The voice preview could not be fetched.'),
    code: error.code,
  });
}

/**
 * The key and the voice id, or the refusal: 503 without the key, 400 for an
 * id that is not one. The id is checked here so a URL, a path or a name never
 * reaches the listing lookup.
 */
function previewPreconditions(deps, request) {
  const key = readSetting(deps.env, ELEVENLABS_KEY_SETTING);
  if (!key) return { refusal: json(503, { error: NOT_CONFIGURED_REASON, code: 'NOT_CONFIGURED' }) };
  const voiceId = String(request.params?.voiceId ?? '');
  if (!isElevenLabsVoiceId(voiceId)) {
    return {
      refusal: json(400, { error: 'That is not an ElevenLabs voice id.', code: VOICE_NOT_LISTED }),
    };
  }
  return { key, voiceId };
}

/** GET /api/cms/podcast/elevenlabs/voices/{voiceId}/preview */
async function previewVoice(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const { key, voiceId, refusal } = previewPreconditions(deps, request);
  if (refusal) return refusal;
  try {
    const { audio, contentType } = await deps.fetchPreview({
      key,
      voiceId,
      fetchImpl: deps.fetchImpl,
      listVoices: deps.listVoices,
    });
    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(audio.length),
        // Per user, for the length of a picking session; the bytes never change.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
      body: audio,
    };
  } catch (error) {
    return previewRefusal(error, context);
  }
}

/**
 * @param {object} options
 * @param {{ requireRole: Function }} options.guard
 * @param {{ queryDocs: Function, upsertDoc: Function, readDoc: Function }} options.store
 * @param {{ uploadBlob: Function, headBlobForDelivery: Function }} options.storage
 * @param {{ getCostEstimate: Function }} options.ai
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.synthesize] `synthesizeDialogue`; injected for tests
 * @param {Function} [options.readAccount] `readSubscription`; injected for tests
 * @param {Function} [options.readVoices] the stored podcast voices; injected for tests
 * @param {Function} [options.listVoices] `readVoices` (the ElevenLabs listing); injected for tests
 * @param {Function} [options.fetchPreview] `fetchVoicePreview`; injected for tests
 * @param {(key: string) => Map<string,string>} [options.voiceNames] `cachedVoiceNames`,
 *   the names the cached listing holds; injected for tests
 * @param {() => Date} [options.now]
 */
export function createElevenLabsHandlers(options) {
  const deps = {
    ...options,
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
    synthesize: options.synthesize ?? synthesizeDialogue,
    readAccount: options.readAccount ?? readSubscription,
    readVoices: options.readVoices ?? ((store) => readStoredPodcastVoices(store.readDoc)),
    listVoices: options.listVoices ?? readVoices,
    fetchPreview: options.fetchPreview ?? fetchVoicePreview,
    voiceNames: options.voiceNames ?? ((key) => cachedVoiceNames(key)),
    now: options.now ?? (() => new Date()),
  };
  return {
    getStatus: (request, context) => getStatus(deps, request, context),
    renderSample: (request, context) => renderSample(deps, request, context),
    listVoices: (request, context) => listVoices(deps, request, context),
    previewVoice: (request, context) => previewVoice(deps, request, context),
  };
}
