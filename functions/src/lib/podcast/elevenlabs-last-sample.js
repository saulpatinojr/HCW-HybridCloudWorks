/**
 * elevenlabs-last-sample.js — what the ElevenLabs card on the podcast page
 * shows about earlier renders (elevenlabs-admin.js builds the routes): the
 * newest usage row, and the last live-check sample a replay plays for
 * nothing, recorded or found in storage. Reads only; it never calls
 * ElevenLabs. elevenlabs-admin.js exports the sample's names again.
 */
import { isElevenLabsVoiceId } from '../listen-and-learn/speech/elevenlabs-voices.js';
import { USAGE_CONTAINER, USAGE_SOURCES } from '../ai/usage.js';
import { mediaUrlFor } from '../blob-paths.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { PODCAST_AUDIO_CONTAINER } from './store.js';
import { PODCAST_HOSTS, PODCAST_VOICES_CONFIG_ID, readStoredPodcastVoices } from './voice-settings.js';

/** The live check's one blob, overwritten each run. */
export const SAMPLE_AUDIO_PATH = 'sample/elevenlabs-live-check.mp3';

/** The sample's media URL, without the `?v=` version. */
export const SAMPLE_MEDIA_URL = mediaUrlFor(PODCAST_AUDIO_CONTAINER, SAMPLE_AUDIO_PATH);

/** The `admin_config` document recording the latest stored sample, for a free replay. */
export const LAST_SAMPLE_CONFIG_ID = 'podcast_last_sample';

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
export async function readLastRender({ store }, context) {
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
export function presentVoices(voices) {
  const out = {};
  for (const host of PODCAST_HOSTS) {
    const voice = presentVoice(voices?.[host]);
    if (!voice) return null;
    out[host] = voice;
  }
  return out;
}

/** `{ Maya: id, Elena: id }` as recorded, each with the name `names` holds for it. */
export const namedVoices = (voices, names) =>
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
export function presentLastSample(doc) {
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
export async function readLastSample(deps, context) {
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

