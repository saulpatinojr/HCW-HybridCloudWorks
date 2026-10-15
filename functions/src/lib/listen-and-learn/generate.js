/**
 * Orchestrates one Listen & Learn generation run.
 *
 *   study guide → skill areas → videos per area → dialogue → MP3 → draft doc
 *
 * Every stage is injected so the whole pipeline is testable without touching
 * a speech provider, YouTube or Cosmos. The run is deliberately area-by-area and
 * saves as it goes: a worker that times out on area 4 must leave areas 1-3
 * saved as drafts rather than losing the work and the spend.
 *
 * Ported from Site-Main `functions/listen-and-learn/generate.js` (088f458),
 * with one behavioural change worth stating plainly:
 *
 *   **A missing speech key degrades; a broken one fails.** Upstream treated
 *   any synthesis failure as a failed area. Here, `SpeechNotConfiguredError`
 *   — no speech provider configured yet — still saves the episode with its transcript,
 *   takeaways and videos, and records `audioError` so the admin page can say
 *   why there is no player. Every other synthesis failure (a rejected key, a
 *   400 on the request, a 5xx) still fails the area, because those are faults to
 *   fix rather than a state to ship in. The feature is therefore useful the
 *   day it deploys and gains audio the day the key lands, without a code
 *   change or a regeneration of anything but the audio.
 */
import { fetchStudyGuide } from './studyguide.js';
import { authoredMessage } from '../http/error-response.js';
import { findVideosForAreas } from './videos.js';
import { generateEpisodeScript } from './script.js';
import { speechUsageRows, synthesizeDialogue, SpeechNotConfiguredError } from './speech/index.js';
import {
  saveEpisode,
  saveEpisodeFailure,
  saveSet,
  uploadEpisodeAudio,
  versionStamp,
  STATUS,
} from './publish.js';
import { speechArgsFor, voiceSettingsOf } from './speech-settings.js';
import { recordAiUsageBatch, totalCostUsd, USAGE_SOURCES } from '../ai/usage.js';

/**
 * Site platform → study-guide provider.
 *
 * Only platforms with a working adapter appear here; the certification pages
 * read the same list to decide between rendering episodes and rendering a
 * "coming soon" banner, so the two can never drift apart. GitHub exams are
 * hosted on Microsoft Learn and parse with the same adapter.
 */
export const SUPPORTED_PLATFORMS = {
  azure: 'microsoft',
  github: 'microsoft',
  aws: 'aws',
};

export function isSupportedPlatform(platform) {
  return Object.hasOwn(SUPPORTED_PLATFORMS, String(platform || '').toLowerCase());
}

export class GenerateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenerateError';
  }
}

/** Real implementations unless a caller (or a test) supplies its own. */
function resolveDeps(deps = {}) {
  return {
    fetchGuide: deps.fetchGuide || fetchStudyGuide,
    findVideos: deps.findVideos || findVideosForAreas,
    writeScript: deps.writeScript || generateEpisodeScript,
    synthesize: deps.synthesize || synthesizeDialogue,
    uploadAudio: deps.uploadAudio || uploadEpisodeAudio,
    persistEpisode: deps.persistEpisode || saveEpisode,
    persistFailure: deps.persistFailure || saveEpisodeFailure,
    persistSet: deps.persistSet || saveSet,
    recordUsage: deps.recordUsage || null,
  };
}

/**
 * Synthesise and upload, or explain why there is no audio.
 *
 * Returns `{ error }` only for the not-configured case; everything else
 * throws, which fails the area. See the module header for why the two are
 * treated differently.
 *
 * Exported for the source-grounded run (source-episode.js, #433), which
 * renders one episode's audio under exactly this policy.
 *
 * Always the `listenAndLearn` product: Gemini TTS, with Azure AI Speech as
 * the fallback, never ElevenLabs (speech/index.js). `model` is the model the
 * job resolved for the `listenAndLearnSpeech` task (ADR 0034 slice 5,
 * router.js modelForTask), or null for the setting and module default.
 * `voice` is the book's own voice settings (speech-settings.js
 * `voiceSettingsOf`, ADR 0033 §4): the hosts' voices, a narrator for a
 * single-voice chapter, the language, the rate, and an explicit provider,
 * each of which outranks the defaults for this book only. `now` stamps the blob path so this take has a path of
 * its own and never overwrites the one before it.
 */
export async function renderAudio({
  script,
  platform,
  examCode,
  areaSlug,
  storage,
  env,
  model = null,
  voice = null,
  narrator = false,
  now = new Date().toISOString(),
  synthesize,
  uploadAudio,
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const speech = speechArgsFor(voice || voiceSettingsOf(null), { narrator });
  let rendered;
  try {
    rendered = await synthesize({
      product: 'listenAndLearn',
      dialogue: script.dialogue,
      model,
      voices: speech.voices,
      provider: speech.provider,
      lang: speech.lang,
      speakingRate: speech.speakingRate,
      env,
      signal,
    });
  } catch (err) {
    if (err instanceof SpeechNotConfiguredError || err?.name === 'SpeechNotConfiguredError') {
      return { error: authoredMessage(err, 'No speech provider is configured.') };
    }
    throw err;
  }

  const uploaded = await uploadAudio({
    storage,
    provider: platform,
    examCode,
    areaSlug,
    audio: rendered.audio,
    contentType: rendered.contentType,
    stamp: versionStamp(now),
  });

  // Which voice read it, kept for the same reason the approver is kept: for
  // AI-generated study content the provenance is the point. It also answers
  // "why does this episode sound different from that one" after a provider or
  // model change, which is otherwise unanswerable once the audio is a blob.
  return {
    ...uploaded,
    speechProvider: rendered.provider || null,
    speechModel: rendered.model || null,
    voice: speech.voices,
    // Gemini measures this from the PCM it decoded, so for that provider it
    // is the real length; Azure derives it from the text at a pessimistic
    // speaking rate, so there it is an over-estimate. The field name is the
    // document's, which the players read as the duration either way.
    durationSeconds: rendered.estimatedSeconds ?? null,
    // What the synthesis is billed on. TTS prices audio output an order of
    // magnitude above text, so this is the number that decides an episode's
    // cost — see the COST_TABLE note in ai/router.js.
    promptTokens: rendered.promptTokens ?? 0,
    completionTokens: rendered.completionTokens ?? 0,
    estimatedTokens: rendered.estimatedTokens === true,
  };
}

/**
 * Script → synthesize → upload → save, for a single skill area.
 *
 * Throws on any failure so the caller owns the decision to record a gap and
 * carry on; keeping that policy in one place is what makes a partial run
 * predictable.
 */
async function generateOneArea({
  area,
  order,
  cert,
  platform,
  examCode,
  videos,
  store,
  storage,
  env,
  ttsModel,
  voice,
  actorId,
  now,
  ai,
  writeScript,
  synthesize,
  uploadAudio,
  persistEpisode,
  recordUsage,
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  // The product declares the feature, not the generator — the same shape as
  // lib/podcast/generate.js. A literal call site, because ai-call-sites.test.js
  // reads the source: `listenAndLearn` was declared inside script.js behind
  // the injected `generate`, where the scan could not see it, and so was
  // listed in no catalogue and gated by no portal toggle.
  //
  // Wrapped only when there is something to wrap. A router with no
  // `generateJsonResponse` hands the script writer `undefined`, so its own
  // "generate is required" guard names the problem, rather than a TypeError
  // from inside this closure on the first call. A plain call, not `.call(ai)`:
  // the router's methods are closures with no `this`, and the scan matches the
  // method name followed directly by its open paren — `.call` in between would
  // hide this site from it.
  const generate =
    typeof ai?.generateJsonResponse === 'function'
      ? (params) => ai.generateJsonResponse({ ...params, feature: 'listenAndLearn' })
      : undefined;

  const scriptUsage = [];
  const script = await writeScript({
    cert,
    area,
    generate,
    usageOut: scriptUsage,
  });

  const audio = await renderAudio({
    script,
    platform,
    examCode,
    areaSlug: area.slug,
    storage,
    env,
    model: ttsModel,
    voice,
    now,
    synthesize,
    uploadAudio,
    signal,
  });

  const saved = await persistEpisode(store, {
    provider: platform,
    examCode,
    area,
    script,
    audio,
    videos,
    order,
    now,
    actorId,
  });

  // Recorded after the episode is saved, never before: a usage row for work
  // that was then lost would overstate spend, and the write is deliberately
  // best-effort (ai/usage.js) so it cannot fail an episode that succeeded.
  const usage = await recordUsage([
    ...scriptUsage.map((u) => ({ ...u, source: USAGE_SOURCES.listenAndLearnScript })),
    ...speechUsageRows('listenAndLearn', audio),
  ]);

  return {
    areaSlug: area.slug,
    areaName: area.name,
    status: STATUS.draft,
    audioBytes: audio.bytes || 0,
    audioError: audio.error || null,
    transcriptBytes: script.byteLength,
    trimmedTurns: script.trimmedTurns,
    videoCount: saved.videos.length,
    costUsd: totalCostUsd(usage),
  };
}

/**
 * Generate every episode for one certification.
 *
 * Returns a per-area report rather than throwing on the first failure —
 * partial success is the normal outcome when a quota runs out mid-run, and
 * the admin page needs to show which areas are missing and why.
 *
 * `ttsModel` is the model the job resolved for the `listenAndLearnSpeech`
 * task (listen-and-learn-jobs.js resolveRunModel, ADR 0034 slice 5), or null
 * to let the setting and the module default decide.
 */
export async function generateEpisodes({
  platform,
  examCode,
  studyGuideUrl,
  cert = {},
  store,
  storage,
  ai,
  env = process.env,
  ttsModel = null,
  youtubeApiKey,
  actorId = null,
  onlyAreas = null,
  now = new Date().toISOString(),
  deps = {},
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const provider = SUPPORTED_PLATFORMS[String(platform || '').toLowerCase()];
  if (!provider) {
    const supported = Object.keys(SUPPORTED_PLATFORMS).join(', ');
    throw new GenerateError(
      `Listen & Learn is not available for "${platform}". Supported platforms: ${supported}.`
    );
  }
  if (!examCode) throw new GenerateError('examCode is required');
  if (!studyGuideUrl) throw new GenerateError(`No study guide URL for ${examCode}`);

  const {
    fetchGuide,
    findVideos,
    writeScript,
    synthesize,
    uploadAudio,
    persistEpisode,
    persistFailure,
    persistSet,
    recordUsage: injectedRecordUsage,
  } = resolveDeps(deps);

  // Spend is recorded against the same container the portal's Usage tab reads,
  // so a Listen & Learn run appears next to every other model call rather than
  // in a second place nobody looks. Needs the cost table, hence `ai`.
  const recordUsage =
    injectedRecordUsage ||
    ((records) =>
      recordAiUsageBatch({ store, ai: { getCostEstimate: ai.getCostEstimate } }, records));

  const guide = await fetchGuide({ provider, examCode, sourceUrl: studyGuideUrl });

  // Filtered after parsing, not before: regenerating one area must still be
  // checked against the current guide, which is how a re-scoped exam gets
  // noticed instead of quietly regenerating a stale area.
  const areas = onlyAreas?.length
    ? guide.areas.filter((a) => onlyAreas.includes(a.slug))
    : guide.areas;

  if (areas.length === 0) {
    throw new GenerateError(
      `None of the requested areas (${onlyAreas?.join(', ')}) exist in the current ${examCode} study guide`
    );
  }

  // The merged set is what carries the book's voice settings (ADR 0033 §4);
  // a test double that returns nothing reads as the defaults.
  const set = await persistSet(store, { provider: platform, examCode, guide, cert, now, actorId });
  const voice = voiceSettingsOf(set);

  // Videos are gathered for all areas up front so cross-area deduping works;
  // a total failure here is survivable, the episodes just ship without links.
  let videosByArea = new Map();
  let videoError = null;
  try {
    const found = await findVideos(areas, { examCode, apiKey: youtubeApiKey });
    videosByArea = new Map(found.map((r) => [r.areaSlug, r]));
  } catch (err) {
    videoError = err.message;
  }

  const results = [];
  const certForScript = { examCode: guide.examCode, title: cert.title || guide.title };

  for (const [order, area] of areas.entries()) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    try {
      results.push(
        await generateOneArea({
          area,
          order,
          cert: certForScript,
          platform,
          examCode,
          videos: videosByArea.get(area.slug)?.videos || [],
          store,
          storage,
          env,
          ttsModel,
          voice,
          actorId,
          now,
          ai,
          writeScript,
          synthesize,
          uploadAudio,
          persistEpisode,
          recordUsage,
          signal,
        })
      );
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') throw err;
      // One area failing must not abandon the rest — the spend on the areas
      // that already succeeded is real, and a gap is more useful than nothing.
      await persistFailure(store, {
        provider: platform,
        examCode,
        area,
        error: err.message,
        order,
        now,
      });
      results.push({
        areaSlug: area.slug,
        areaName: area.name,
        status: STATUS.failed,
        error: err.message,
      });
    }
  }

  const generated = results.filter((r) => r.status === STATUS.draft);

  return {
    examCode: guide.examCode,
    platform,
    provider,
    studyGuideUrl: guide.sourceUrl,
    areaCount: areas.length,
    generated: generated.length,
    failed: results.filter((r) => r.status === STATUS.failed).length,
    // Reported once at the top rather than only per area, because "no speech
    // key" is one configuration fact about the whole run, not five failures.
    withoutAudio: generated.filter((r) => r.audioError).length,
    // What the run cost, summed from the rows actually written. The admin page
    // shows it when the job finishes, which is the moment it is worth knowing.
    costUsd: parseFloat(results.reduce((sum, r) => sum + (r.costUsd || 0), 0).toFixed(6)),
    videoError,
    results,
  };
}
