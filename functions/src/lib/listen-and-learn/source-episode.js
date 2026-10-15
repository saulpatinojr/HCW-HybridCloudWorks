/**
 * One source-grounded Listen & Learn episode (#433): the payload rules, and
 * the run.
 *
 *   owner's URLs → validated list → dialogue (Gemini reads the sources) → MP3 → draft doc
 *
 * The sibling of `generate.js`, which runs a whole certification from its
 * study guide. This runs ONE episode from pages and videos the owner chose,
 * and it is a separate function rather than a branch of `generateEpisodes`
 * because almost nothing is shared: there is no guide to fetch, no areas to
 * loop over, no "watch next" videos to find, and no partial success to
 * preserve — one episode either lands as a draft or the run fails, and the
 * job carries the sentence saying why. What IS shared is imported from the
 * guide run rather than restated: `renderAudio` (a missing speech key
 * degrades, a broken one fails), `saveEpisode` (drafts only, whole-document
 * replace), `saveEpisodeFailure` (merge, keep the last good transcript).
 *
 * WHAT THE RUN WILL NOT DO. It will not write anything when the router
 * refuses the call — an invalid source list, Gemini absent from the provider
 * chain, the feature disabled in the portal. Those are refusals stated before
 * a byte is sent, and a failure marker for a run that never started would
 * read as a broken episode when the fix is configuration. Every other
 * failure — a source Gemini could not read, a model reply with no dialogue,
 * a rejected speech key — is recorded as a failed episode of kind `source`,
 * so the set shows the gap, and then rethrown so the job fails too.
 *
 * THE PAYLOAD IS VALIDATED TWICE, on purpose. `parseSourceEpisodePayload`
 * runs at the enqueue route (handlers.js `generateSourceEpisode`), so an
 * over-cap list or a YouTube URL given as a page is refused with the
 * sentence at once, as a 400 the form can show — not as a failed job the
 * page would have to poll for. The worker runs it again as the guard for any
 * other caller of the job type, and the router validates a third time before
 * spending. Same sentences each time, because they are the same function.
 */
import { validateGroundingSources } from '../ai/router.js';
import { authoredMessage } from '../http/error-response.js';
import { recordAiUsageBatch, totalCostUsd, USAGE_SOURCES } from '../ai/usage.js';
import { generateEpisodeScript } from './script.js';
import { speechUsageRows, synthesizeDialogue } from './speech/index.js';
import { renderAudio, SUPPORTED_PLATFORMS, isSupportedPlatform } from './generate.js';
import {
  EPISODE_KIND,
  SET_CONTAINER,
  SOURCE_EPISODE_ORDER,
  STATUS,
  ensureSet,
  saveEpisode,
  saveEpisodeFailure,
  setId,
  sourceEpisodeId,
  uploadEpisodeAudio,
} from './publish.js';
import { voiceSettingsOf } from './speech-settings.js';

/**
 * The job that runs both kinds (functions/listen-and-learn-jobs.js). One
 * name, asserted equal to the registration by the job's own test, so the
 * enqueue route and the worker cannot drift.
 */
export const LISTEN_AND_LEARN_JOB_TYPE = 'generate-listen-and-learn';

/** A title is spoken, shown as a card and slugified into an id; a paragraph is none of those. */
export const MAX_SOURCE_TITLE_LENGTH = 120;

/** A per-source title is a label for the review page, not a document. */
const MAX_SOURCE_LABEL_LENGTH = 200;

/**
 * The list as it is stored: the router's validation (http(s) only, YouTube
 * must be `video`, exact-string dedup, the caps refused rather than
 * truncated), with the owner's optional title kept beside each URL. Pages
 * first, then videos, which is the order the router lists them to the model.
 *
 * @param {Array<{ kind: 'page'|'video', url: string, title?: string }>} sources
 * @returns {Array<{ kind: 'page'|'video', url: string, title?: string }>}
 */
export function resolveSources(sources) {
  const { pages, videos } = validateGroundingSources(sources);

  // First title wins for a URL given twice; the router deduped by exact
  // string, so the lookup is by the same trimmed string.
  const titles = new Map();
  for (const source of sources) {
    const url = typeof source?.url === 'string' ? source.url.trim() : '';
    const title = typeof source?.title === 'string' ? source.title.trim() : '';
    if (url && title && !titles.has(url)) titles.set(url, title.slice(0, MAX_SOURCE_LABEL_LENGTH));
  }
  const entry = (kind) => (url) => ({
    kind,
    url,
    ...(titles.has(url) ? { title: titles.get(url) } : {}),
  });
  return [...pages.map(entry('page')), ...videos.map(entry('video'))];
}

/**
 * Validate a source-episode payload. Returns `{ value }` or `{ error }`, the
 * same contract as `parseGeneratePayload`, so the route and the worker say
 * the same thing.
 */
export function parseSourceEpisodePayload(payload) {
  const platform = String(payload?.platform || '').toLowerCase();
  const examCode = String(payload?.examCode || '').trim();
  const title = String(payload?.title || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!isSupportedPlatform(platform)) {
    return {
      error: `Listen & Learn is not available for "${platform}". Supported platforms: ${Object.keys(SUPPORTED_PLATFORMS).join(', ')}.`,
    };
  }
  if (!examCode) return { error: 'examCode is required' };
  if (!title) return { error: 'title is required for a source-grounded episode' };
  if (title.length > MAX_SOURCE_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_SOURCE_TITLE_LENGTH} characters` };
  }

  let areaSlug;
  try {
    areaSlug = sourceEpisodeId(title);
  } catch (err) {
    return { error: authoredMessage(err, 'The episode title cannot be made into an id.') };
  }

  let sources;
  try {
    sources = resolveSources(payload?.sources);
  } catch (err) {
    // The router's refusals are sentences written for the person typing the
    // URLs; anything else is a fault and stays one.
    if (err?.code === 'AI_INVALID_SOURCES') {
      return { error: authoredMessage(err, 'The sources were refused.') };
    }
    throw err;
  }

  return {
    value: {
      kind: EPISODE_KIND.source,
      platform,
      examCode,
      title,
      areaSlug,
      sources,
      cert: {
        title: String(payload?.certTitle || '').trim() || null,
        slug: String(payload?.certSlug || '').trim() || null,
      },
    },
  };
}

/**
 * A refusal the router states before spending — nothing was attempted, so
 * nothing is recorded as a failed episode. See the header.
 */
function isRefusal(err) {
  return (
    err?.name === 'AiNotConfiguredError' ||
    err?.name === 'AiFeatureDisabledError' ||
    err?.code === 'AI_INVALID_SOURCES'
  );
}

/** Real implementations unless a caller (or a test) supplies its own. */
function resolveDeps(deps = {}) {
  return {
    writeScript: deps.writeScript || generateEpisodeScript,
    synthesize: deps.synthesize || synthesizeDialogue,
    uploadAudio: deps.uploadAudio || uploadEpisodeAudio,
    persistEpisode: deps.persistEpisode || saveEpisode,
    persistFailure: deps.persistFailure || saveEpisodeFailure,
    persistSet: deps.persistSet || ensureSet,
    recordUsage: deps.recordUsage || null,
  };
}

/**
 * Generate one source-grounded episode and save it as a draft.
 *
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.examCode
 * @param {string} params.title the episode's title; its slug is the document id
 * @param {Array<{ kind: 'page'|'video', url: string, title?: string }>} params.sources
 * @param {{ title?: string|null, slug?: string|null }} [params.cert]
 * @param {object} params.store Cosmos: readDoc, upsertDoc
 * @param {object} params.storage Blob: uploadBlob
 * @param {{ generateGroundedJsonResponse: Function, getCostEstimate: Function }} params.ai the router
 * @param {object} [params.env]
 * @param {string|null} [params.ttsModel] the model the job resolved for the listenAndLearnSpeech task, or null (listen-and-learn-jobs.js)
 * @param {string|null} [params.actorId]
 * @param {string} [params.now]
 * @param {object} [params.deps] test seams; see resolveDeps
 */
export async function generateSourceEpisode({
  platform: rawPlatform,
  examCode: rawExamCode,
  title: rawTitle,
  sources: rawSources,
  cert: rawCert = {},
  store,
  storage,
  ai,
  env = process.env,
  ttsModel = null,
  actorId = null,
  now = new Date().toISOString(),
  deps = {},
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseSourceEpisodePayload({
    platform: rawPlatform,
    examCode: rawExamCode,
    title: rawTitle,
    sources: rawSources,
    certTitle: rawCert?.title,
    certSlug: rawCert?.slug,
  });
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.code = 'AI_INVALID_SOURCES';
    throw err;
  }
  // From here on only the validated, normalised values exist: the raw
  // arguments are named `raw*` above precisely so nothing below can reach
  // one. A padded exam code (`' AZ-104 '`) validates, and the set id, the
  // document id and the blob path must come from the trimmed value the route
  // and the worker computed — not from the padding.
  const { platform, examCode, title, areaSlug, sources: resolved, cert } = parsed.value;

  const {
    writeScript,
    synthesize,
    uploadAudio,
    persistEpisode,
    persistFailure,
    persistSet,
    recordUsage: injectedRecordUsage,
  } = resolveDeps(deps);

  const recordUsage =
    injectedRecordUsage ||
    ((records) =>
      recordAiUsageBatch({ store, ai: { getCostEstimate: ai.getCostEstimate } }, records));

  // The "area" a source episode stands in for: its slug is the document id
  // and the blob path segment, its name is the title. No weighting — the
  // official guide gives none, and inventing one would be the claim to exam
  // authority the prompt forbids.
  const area = { slug: areaSlug, name: title, weightLabel: '', objectives: [] };
  const certForScript = { examCode, title: cert.title || examCode };

  const scriptUsage = [];
  let script;
  let audio;
  try {
    script = await writeScript({
      cert: certForScript,
      area,
      usageOut: scriptUsage,
      grounding: { sources: resolved, ai, generatedAt: now },
    });

    // The book's voice, when the set already exists (ADR 0033 §4); a store
    // without `readDoc` — an older test double — reads as the defaults.
    const existingSet =
      typeof store?.readDoc === 'function'
        ? await store.readDoc(SET_CONTAINER, setId(platform, examCode), setId(platform, examCode))
        : null;

    audio = await renderAudio({
      script,
      platform: platform,
      examCode,
      areaSlug,
      storage,
      env,
      model: ttsModel,
      voice: voiceSettingsOf(existingSet),
      now,
      synthesize,
      uploadAudio,
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') {
      throw err;
    }
    if (!isRefusal(err)) {
      await persistFailure(store, {
        provider: platform,
        examCode,
        area,
        error: err.message,
        order: SOURCE_EPISODE_ORDER,
        now,
        kind: EPISODE_KIND.source,
      });
    }
    throw err;
  }

  // The set after the script, not before: a refused run leaves no trace, and
  // a set that exists is left exactly as it is (publish.js `ensureSet`).
  await persistSet(store, { provider: platform, examCode, cert, now, actorId });

  await persistEpisode(store, {
    provider: platform,
    examCode,
    area,
    script,
    audio,
    videos: [],
    order: SOURCE_EPISODE_ORDER,
    now,
    kind: EPISODE_KIND.source,
    sources: resolved,
    actorId,
  });

  // After the save, never before, for the reason generate.js gives: a usage
  // row for work that was then lost would overstate spend.
  const usage = await recordUsage([
    ...scriptUsage.map((u) => ({ ...u, source: USAGE_SOURCES.listenAndLearnSourceScript })),
    ...speechUsageRows('listenAndLearn', audio),
  ]);

  return {
    kind: EPISODE_KIND.source,
    examCode,
    platform: platform,
    areaSlug,
    title: script.title,
    status: STATUS.draft,
    sourceCount: resolved.length,
    audioBytes: audio.bytes || 0,
    audioError: audio.error || null,
    transcriptBytes: script.byteLength,
    trimmedTurns: script.trimmedTurns,
    // The shape the admin page already reads from a guide run's report.
    generated: 1,
    failed: 0,
    withoutAudio: audio.error ? 1 : 0,
    costUsd: totalCostUsd(usage),
  };
}
