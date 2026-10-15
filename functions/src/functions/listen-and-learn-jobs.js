/**
 * listen-and-learn-jobs.js — episode generation as a platform job.
 *
 * Site-Main exposed this as `generateListenAndLearn`, a 540-second HTTP
 * handler. That shape does not survive the port: an Azure Functions HTTP
 * response is bounded at 230 seconds by the load balancer regardless of the
 * host's `functionTimeout`, and one certification is five model calls, five
 * syntheses and five multi-megabyte uploads. So the admin page enqueues
 * `generate-listen-and-learn` and polls (frontend/src/lib/jobs.js), exactly as
 * the RSS ingest does.
 *
 * The run still saves area by area, so a timeout leaves the finished episodes
 * behind as drafts rather than losing the work and the spend.
 *
 * The same job runs a source-grounded episode (#433): a payload carrying
 * `sources` is one episode built from the owner's pages and videos, parsed by
 * `parseSourceEpisodePayload` and run by `generateSourceEpisode`, and needs no
 * study guide URL. The admin page queues it through
 * `POST cms/listen-and-learn/source-episode` (listen-and-learn/handlers.js), which
 * validates the list before the job exists; the worker validates it again.
 */
import { generateGroundedJsonResponse } from '../lib/ai/router.js';
import {
  generateSourceEpisode,
  parseSourceEpisodePayload,
} from '../lib/listen-and-learn/source-episode.js';
import { readDoc, upsertDoc, patchDoc } from '../lib/cosmos-client.js';
import { uploadBlob } from '../lib/blob-storage.js';
import {
  generateJsonResponse,
  getActiveAiProvider,
  getCostEstimate,
  modelForTask,
} from '../lib/ai/router.js';
import { recordAiUsageBatch, totalCostUsd } from '../lib/ai/usage.js';
import { registerJobType } from '../lib/jobs.js';
import {
  generateEpisodes,
  isSupportedPlatform,
  renderAudio,
  SUPPORTED_PLATFORMS,
} from '../lib/listen-and-learn/generate.js';
import { SPEAK_CHAPTER_JOB_TYPE } from '../lib/listen-and-learn/handlers.js';
import {
  EPISODE_CONTAINER,
  EPISODE_KIND,
  SET_CONTAINER,
  STATUS,
  mergeRegeneration,
  saveEpisodeFailure,
  setId,
  uploadEpisodeAudio,
} from '../lib/listen-and-learn/publish.js';
import { MAX_SCRIPT_BYTES } from '../lib/listen-and-learn/script.js';
import {
  estimateGeminiCostUsd,
  estimateSpeechCostUsd,
  resolveSpeechProvider,
  speechUsageRows,
  synthesizeDialogue,
} from '../lib/listen-and-learn/speech/index.js';
import {
  LISTEN_AND_LEARN_GEMINI_MODELS,
  NARRATOR_SPEAKER,
  voiceSettingsOf,
} from '../lib/listen-and-learn/speech-settings.js';

/** Every synthesis and estimate here is for this product, never the podcast's. */
const PRODUCT = 'listenAndLearn';

/**
 * A USD figure to six decimals that never sits below the exact value. The
 * run total is a ceiling, and `toFixed` rounds to nearest, so the trimmed
 * figure is nudged up by one micro-dollar whenever trimming lowered it.
 */
export function roundUpUsd(usd) {
  const trimmed = parseFloat(usd.toFixed(6));
  return trimmed < usd ? parseFloat((trimmed + 1e-6).toFixed(6)) : trimmed;
}

/**
 * Bound so a single run cannot spend an unbounded amount: the largest real
 * guide is 6 areas, and a request asking for more is a bug or abuse.
 */
export const MAX_AREAS_PER_RUN = 8;

/**
 * What the speech for this run is expected to cost, stated in the 202 before
 * the run starts (ADR 0029 §2a).
 *
 * A ceiling, not a forecast: no script exists yet, so each episode is priced
 * at `MAX_SCRIPT_BYTES` — the most UTF-8 BYTES a script may hold, which
 * `estimateSpeechCostUsd` treats as bytes; Gemini's duration is derived from
 * bytes at a deliberately slow speaking rate, so this over-estimates. The
 * episode count is the areas requested or, when the guide has not been parsed
 * to know, the most a run may generate. The run cannot spend more than this
 * figure on speech; it usually spends less.
 *
 * The Listen & Learn product only — Gemini or Azure AI Speech, never
 * ElevenLabs, whatever keys are present (speech/index.js). `provider` is null
 * when no speech provider will run, and `reason` says why, because the two
 * causes call for different actions: `not_configured` (no key at all — the
 * transcript-only state, not an error) or `pin_unavailable`
 * (`LISTEN_AND_LEARN_TTS_PROVIDER` names a provider that is not configured,
 * not known, or not this product's — the run will still go ahead, and its
 * audio step will fail with a sentence naming the pin).
 *
 * The model is the `listenAndLearnSpeech` task's (ADR 0034 slice 5, #860):
 * the worker reads it from the selection document when it runs
 * (`resolveRunModel`), and this hook is synchronous and sees only the
 * payload, so it cannot know which model that is. It does not guess:
 * `model` is null, `modelSource` is `'task'`, `modelNote` says where the
 * choice lives, and the ceiling is priced at the DEARER of the two Gemini
 * TTS models so that it is still a ceiling whichever one the task resolves
 * to (Copilot on #462). A `ttsModel` in the payload is ignored, never
 * echoed back.
 *
 * @param {object} payload the raw enqueue payload
 * @param {object} [env]
 * @returns {{provider: string|null, model: string|null, modelSource: 'task'|null, modelNote?: string, episodes: number, perEpisodeUsd: number|null, estimatedCostUsd: number|null, reason?: 'not_configured'|'pin_unavailable'}}
 */
export function speechEstimateForRun(payload, env = process.env) {
  const areas = Array.isArray(payload?.areas) ? payload.areas.length : 0;
  const episodes = areas > 0 ? Math.min(areas, MAX_AREAS_PER_RUN) : MAX_AREAS_PER_RUN;
  const perEpisode = estimateSpeechCostUsd({
    product: PRODUCT,
    ceilingBytes: MAX_SCRIPT_BYTES,
    model: dearestOfferedModel(),
    env,
  });
  if (!perEpisode) {
    return {
      provider: null,
      model: null,
      modelSource: null,
      episodes,
      perEpisodeUsd: null,
      estimatedCostUsd: null,
      reason: noProviderReason(env),
    };
  }
  const perEpisodeUsd = perEpisode.estimatedCostUsd;
  // Only Gemini has a model to name; Azure's is null with nothing to say.
  const taskChooses = perEpisode.provider === 'gemini';
  return {
    provider: perEpisode.provider,
    model: null,
    modelSource: taskChooses ? 'task' : null,
    ...(taskChooses ? { modelNote: TASK_MODEL_NOTE } : {}),
    episodes,
    perEpisodeUsd,
    estimatedCostUsd:
      typeof perEpisodeUsd === 'number' ? roundUpUsd(perEpisodeUsd * episodes) : null,
  };
}

/** What the 202 says in place of a model it cannot know. */
export const TASK_MODEL_NOTE = 'the model is chosen under AI Engine → Tasks (Listen & Learn speech)';

/**
 * The Gemini TTS model with the highest per-episode ceiling, so an estimate
 * made without knowing the task's choice is never below the one that will
 * run.
 */
function dearestOfferedModel() {
  return LISTEN_AND_LEARN_GEMINI_MODELS.map((m) => ({
    id: m.id,
    perEpisodeUsd: estimateGeminiCostUsd(m.id, MAX_SCRIPT_BYTES),
  })).reduce((dearest, option) =>
    (option.perEpisodeUsd ?? -1) > (dearest.perEpisodeUsd ?? -1) ? option : dearest
  ).id;
}

/**
 * Why no speech provider will run: the switch returns null for "nothing is
 * configured" and throws for "the pin is unusable", and only the first of
 * those is the normal transcript-only state.
 */
function noProviderReason(env) {
  try {
    return resolveSpeechProvider(env, { product: PRODUCT }) ? null : 'not_configured';
  } catch (err) {
    if (err?.name === 'SpeechNotConfiguredError') return 'pin_unavailable';
    throw err;
  }
}

/**
 * Validate a generate payload. Returns `{ value }` or `{ error }` so the rules
 * are testable on their own and the job worker stays a thin adapter.
 *
 * A `ttsModel` in the payload is ignored for both kinds of run (ADR 0034
 * slice 5, #860): the model is the task's, read by the worker when it runs,
 * and a client written before this slice still gets its 202.
 */
export function parseGeneratePayload(payload) {
  // A source list makes this a source-grounded episode, whatever else the
  // payload carries: the presence of the field is the switch, not its
  // length, so an empty list is refused by the source rules ("needs at least
  // one source") rather than silently becoming a guide run.
  if (payload && typeof payload === 'object' && payload.sources !== undefined) {
    return parseSourceEpisodePayload(payload);
  }

  const platform = String(payload?.platform || '').toLowerCase();
  const examCode = String(payload?.examCode || '').trim();
  const studyGuideUrl = String(payload?.studyGuideUrl || '').trim();
  const areas = Array.isArray(payload?.areas) ? payload.areas.map(String) : null;

  if (!isSupportedPlatform(platform)) {
    return {
      error: `Listen & Learn is not available for "${platform}". Supported platforms: ${Object.keys(SUPPORTED_PLATFORMS).join(', ')}.`,
    };
  }
  if (!examCode) return { error: 'examCode is required' };
  // https only: the URL is fetched server-side, so a plain-http, file or
  // localhost URL here would be an SSRF foothold rather than a typo.
  if (!/^https:\/\//.test(studyGuideUrl)) {
    return { error: 'studyGuideUrl must be an https URL' };
  }
  if (areas && areas.length > MAX_AREAS_PER_RUN) {
    return { error: `At most ${MAX_AREAS_PER_RUN} areas can be generated per request` };
  }

  return {
    value: {
      platform,
      examCode,
      studyGuideUrl,
      areas,
      cert: {
        title: String(payload?.certTitle || '').trim() || null,
        slug: String(payload?.certSlug || '').trim() || null,
      },
    },
  };
}

/**
 * The model this run reads with: the `listenAndLearnSpeech` task's, from the
 * selection document through the router (ADR 0034 slice 5, #860), read once
 * per run before anything is spent. The resolver names the Gemini model;
 * Azure AI Speech stays the adapter's own fallback (speech/index.js), so a
 * task with nothing eligible — Gemini holds no key — answers null and lets
 * the switch decide between Azure and "not configured", as it did before
 * the resolver. A task switched off in the portal fails the run before the
 * voice is called, as the registry's route text says.
 *
 * @param {{ modelForTask: Function }} ai the router
 * @returns {Promise<string|null>}
 */
export async function resolveRunModel(ai) {
  try {
    const chosen = await ai.modelForTask({ task: 'listenAndLearnSpeech' });
    return chosen?.model || null;
  } catch (err) {
    if (err?.code === 'AI_NOT_CONFIGURED') return null;
    throw err;
  }
}

/** One generation run against production dependencies. */
export async function runListenAndLearnGeneration(payload, { context, job, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseGeneratePayload(payload);
  if (parsed.error) throw new Error(parsed.error);

  const store = { readDoc, upsertDoc, patchDoc };
  const ttsModel = await resolveRunModel({ modelForTask });

  if (parsed.value.kind === 'source') {
    const source = parsed.value;
    const report = await generateSourceEpisode({
      platform: source.platform,
      examCode: source.examCode,
      title: source.title,
      sources: source.sources,
      cert: source.cert,
      store,
      storage: { uploadBlob },
      ai: { generateGroundedJsonResponse, getCostEstimate },
      ttsModel,
      actorId: job?.requestedBy?.oid || null,
      signal,
    });
    // Exam code and counts only: the episode id is derived from the owner's
    // title, which is content, and the log line is not the place for it.
    context?.log?.(
      `generate-listen-and-learn: ${report.examCode} — source-grounded episode drafted from ${report.sourceCount} sources${report.audioError ? ', without audio' : ''}, $${report.costUsd} spent`
    );
    return report;
  }

  const { platform, examCode, studyGuideUrl, areas, cert } = parsed.value;

  const report = await generateEpisodes({
    platform,
    examCode,
    studyGuideUrl,
    cert,
    store,
    storage: { uploadBlob },
    ai: { generateJsonResponse, getActiveAiProvider, getCostEstimate },
    ttsModel,
    youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
    actorId: job?.requestedBy?.oid || null,
    onlyAreas: areas,
    signal,
  });

  // The model id is a setting, not content; naming it is what answers "why
  // does this run sound different" from the log alone.
  context?.log?.(
    `generate-listen-and-learn: ${report.examCode} — ${report.generated} drafted, ${report.failed} failed, ${report.withoutAudio} without audio, $${report.costUsd} spent (speech model ${ttsModel || 'default'})`
  );

  return report;
}

/**
 * Validate a speak-chapter payload (ADR 0033 §4): the set and the chapter
 * id; a `ttsModel` is ignored (the model is the task's). `{ value }` or
 * `{ error }`, like the guide payload.
 */
export function parseSpeakChapterPayload(payload) {
  const platform = String(payload?.platform || '')
    .trim()
    .toLowerCase();
  const examCode = String(payload?.examCode || '').trim();
  const chapterId = String(payload?.chapterId || '').trim();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(platform)) return { error: 'platform is required' };
  if (!examCode) return { error: 'examCode is required' };
  if (!/^[a-z0-9][a-z0-9_-]{0,120}$/.test(chapterId)) return { error: 'chapterId is required' };
  return { value: { platform, examCode, chapterId } };
}

/**
 * Speak one hand-made chapter's text as a new audio version (ADR 0033 §4).
 *
 * One narrator, the book's voice settings, the text chunked by the provider.
 * On success the take is appended to `versions[]` and made active, the
 * top-level audio fields mirror it, and the chapter's status is KEPT — a
 * published chapter stays published in its new voice. On a synthesis
 * failure the chapter keeps its current take and status and records
 * `lastError`, so the card can offer Retry and Keep current; a chapter that
 * had no take is marked failed. A missing speech provider is the
 * transcript-only state, not a failure: `audioError` says which setting is
 * missing and nothing else changes.
 */
export async function runSpeakChapter(payload, { context, job, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseSpeakChapterPayload(payload);
  if (parsed.error) throw new Error(parsed.error);
  const { platform, examCode, chapterId } = parsed.value;

  const store = { readDoc, upsertDoc, patchDoc };
  const id = setId(platform, examCode);
  const [set, chapter] = await Promise.all([
    readDoc(SET_CONTAINER, id, id),
    readDoc(EPISODE_CONTAINER, chapterId, id),
  ]);
  if (!chapter || chapter.softDeletedAt) throw new Error(`No chapter ${chapterId} in ${id}`);
  const text = typeof chapter.sourceText === 'string' ? chapter.sourceText.trim() : '';
  if (!text) throw new Error(`Chapter ${chapterId} has no text to speak`);

  const now = new Date().toISOString();
  const actorId = job?.requestedBy?.oid || null;
  const ttsModel = await resolveRunModel({ modelForTask });
  const voice = voiceSettingsOf(set);

  let audio;
  try {
    audio = await renderAudio({
      script: { dialogue: [{ speaker: NARRATOR_SPEAKER, text }] },
      platform,
      examCode,
      areaSlug: chapterId,
      storage: { uploadBlob },
      env: process.env,
      model: ttsModel,
      voice,
      narrator: true,
      now,
      synthesize: synthesizeDialogue,
      uploadAudio: uploadEpisodeAudio,
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') throw err;
    await saveEpisodeFailure(store, {
      provider: platform,
      examCode,
      area: { slug: chapterId, name: chapter.title || chapter.areaName || chapterId },
      error: err.message,
      order: chapter.order,
      now,
      kind: EPISODE_KIND.manual,
    });
    throw err;
  }

  if (audio.error) {
    // No provider: nothing to version. Say why on the chapter and stop.
    await patchDoc(
      EPISODE_CONTAINER,
      chapterId,
      { audioError: audio.error, updatedAt: now },
      {
        partitionKey: id,
      }
    );
    context?.log?.(`speak-listen-and-learn-chapter: ${id}/${chapterId} — no speech provider`);
    return {
      chapterId,
      status: chapter.status,
      generated: 1,
      failed: 0,
      withoutAudio: 1,
      costUsd: 0,
    };
  }

  const usage = await recordAiUsageBatch(
    { store, ai: { getCostEstimate } },
    speechUsageRows('listenAndLearn', audio)
  );
  const costUsd = totalCostUsd(usage);

  const fresh = {
    ...chapter,
    kind: EPISODE_KIND.manual,
    audioUrl: audio.url,
    audioPath: audio.path,
    audioBytes: audio.bytes,
    durationSeconds: audio.durationSeconds ?? null,
    speechProvider: audio.speechProvider,
    speechModel: audio.speechModel,
    voice: audio.voice,
    audioError: null,
    generatedAt: now,
  };
  const merged = mergeRegeneration(chapter, fresh, { now, actorId, costUsd });
  await upsertDoc(EPISODE_CONTAINER, merged);

  context?.log?.(
    `speak-listen-and-learn-chapter: ${id}/${chapterId} — ${audio.bytes} bytes, $${costUsd} spent (${audio.speechProvider} ${audio.speechModel || ''})`
  );
  return {
    chapterId,
    status: merged.status === STATUS.archived ? STATUS.archived : merged.status,
    audioBytes: audio.bytes,
    durationSeconds: audio.durationSeconds ?? null,
    generated: 1,
    failed: 0,
    withoutAudio: 0,
    costUsd,
  };
}

registerJobType(SPEAK_CHAPTER_JOB_TYPE, {
  // Speaks and stores a take; publishing it is a separate action.
  role: 'editor',
  description:
    'Read one hand-made Audio Library chapter aloud from its stored text and save the take as a new version.',
  maxPayloadBytes: 1024,
  // A 60,000-character chapter is about fourteen Gemini requests at a few
  // seconds each, plus one upload.
  timeoutMs: 10 * 60 * 1000,
  worker: runSpeakChapter,
});

registerJobType('generate-listen-and-learn', {
  // Generates and stores an episode; publishing it is a separate action.
  role: 'editor',
  description:
    'Parse a certification study guide, script one episode per skill area, synthesise the audio and save every episode as a draft for review.',
  // Enough for the URL, the exam code and up to eight area slugs — or, for a
  // source-grounded episode, twenty page URLs and ten video URLs with a title
  // each (#433): the router's caps, which the route refuses over rather than
  // this limit truncating.
  maxPayloadBytes: 16384,
  // Five areas at roughly two minutes each — one model call plus one or two
  // synthesis requests plus an upload — with headroom for a slow guide fetch.
  timeoutMs: 25 * 60 * 1000,
  // The expected speech spend, in the 202, so the admin page can show it at
  // the moment the run is requested rather than after the usage rows land.
  acceptedDetails: (payload) => ({ speech: speechEstimateForRun(payload) }),
  worker: runListenAndLearnGeneration,
});
