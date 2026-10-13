/**
 * Persist podcast transcripts — the podcast's own product (#435, #432).
 *
 * A transcript is a two-host script read from something the site already
 * published, plus the audio rendered from it. Two sources feed it: published
 * articles (this slice) and Plaud recordings (#434, later). Both land here,
 * in `podcast_transcripts`, and NOT in `listen_and_learn_episodes`. The
 * owner's ruling (2026-09-08, on #435) is the reason and it is editorial, not
 * technical: Listen & Learn is the Learn section's exam-prep playlist,
 * surfaced per provider, and content transcripts are the written catalogue
 * read aloud for the podcast. Storing the second inside the first's container
 * would have had every Learn playlist reader start serving article episodes.
 * So the two products keep two containers, and the shape below borrows from
 * `listen-and-learn/publish.js` without sharing its storage.
 *
 * Layout
 *   Cosmos   podcast_transcripts/article_{slug} @ /id       — one per article
 *            podcast_transcripts/plaud_{recordingId}          — one per Plaud
 *                                                              library recording
 *            podcast_transcripts/recording_{id}               — one per stored
 *                                                              recording (#442)
 *   Blob     podcast/article/{slug}.mp3, podcast/plaud/{recordingId}.mp3,
 *            podcast/recording/{id}.mp3
 *
 * Every write keys on a source descriptor (`describeArticleSource`,
 * `describeRecordingSource`) so the three kinds share one document shape and
 * one set of writers; the `article`-shaped functions are wrappers kept for
 * the callers that predate the second kind.
 *
 * `/id` rather than a set partition because a transcript has no set: the id is
 * globally unique by construction — `article_` plus the article's slug, which
 * the publish path already keeps unique across the catalogue — so the
 * per-partition uniqueness `listen_and_learn_episodes` needs for repeated area
 * slugs does not arise. Regeneration is therefore idempotent for free, and a
 * regeneration is a whole-document replace, exactly as `saveEpisode` does it:
 * the new draft must not inherit the approval of the version it replaced.
 *
 * `sourceProvider` is recorded when the article names a cloud provider and
 * left null otherwise. It is NOT a refusal condition. The earlier analysis
 * that refused an unknown provider was reasoning about the Learn container,
 * whose listings key on `provider`; nothing here does, and the hub (#442)
 * lists transcripts by date.
 *
 * The container is provisioned by Terraform from infra/cosmos-containers.json.
 * Until that apply runs, every write here answers 404 — `saveTranscript` turns
 * that into a sentence naming the container and the apply, because a
 * generation that spent on a model call and then "failed to save" with a bare
 * `Resource Not Found` sends someone looking at the wrong thing.
 */
import { mediaUrlFor } from '../blob-paths.js';
import { resolveArticleSlug, resolveArticleTitle } from '../listen-and-learn/article-script.js';

export const TRANSCRIPT_CONTAINER = 'podcast_transcripts';

/** Blob container for transcript audio. Declared in infra/storage.tf. */
export const PODCAST_AUDIO_CONTAINER = 'podcast';

export const STATUS = Object.freeze({
  draft: 'draft',
  published: 'published',
  failed: 'failed',
});

/**
 * What a transcript was scripted from. One discriminator field rather than
 * several field prefixes, for the reason `recording-script.js` nests its
 * provenance under `source.kind`: the hub lists every kind in one column.
 *
 *   article    — a published article (#435); id `article_<slug>`
 *   plaud      — a Plaud library recording read through the MCP (#434);
 *                id `plaud_<recordingId>`
 *   recording  — a recording stored in the `recordings` container: a manual
 *                paste, or an upload transcribed by Plaud Embedded (#442);
 *                id `recording_<recordingId>`
 */
export const SOURCE_KINDS = Object.freeze({
  article: 'article',
  plaud: 'plaud',
  recording: 'recording',
});

/**
 * The part of an article's identity that names its transcript and its audio.
 *
 * The slug, normally. It falls back to the document id for a legacy article
 * that was published without one — refusing would leave that article the only
 * kind that cannot be read aloud, for no editorial reason. Either way the key
 * becomes a Cosmos id and a blob path segment, so it is held to the blob path
 * character class; an article whose slug and id both fail it is refused by
 * name rather than stored under a mangled key.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function articleKey(article) {
  for (const candidate of [resolveArticleSlug(article), String(article?.id || '').trim()]) {
    if (candidate && KEY_PATTERN.test(candidate)) return candidate;
  }
  throw new Error(
    `Article ${article?.id || '(no id)'} has neither a slug nor an id usable as a transcript key`
  );
}

/**
 * A recording id as a transcript key. Plaud file ids and the `recordings`
 * container's UUIDs both pass the blob-path character class; anything that
 * does not is refused by name rather than stored under a mangled key.
 */
export function recordingKey(recordingId) {
  const candidate = String(recordingId ?? '').trim();
  if (candidate && KEY_PATTERN.test(candidate)) return candidate;
  throw new Error(`Recording id ${JSON.stringify(candidate)} is not usable as a transcript key`);
}

/**
 * The source descriptor every write below keys on: `{ kind, key, id, slug,
 * title, provider }`. `kind` + `key` name the document and the audio blob;
 * the rest is what the listing shows beside the transcript.
 */
export function describeArticleSource(article) {
  return {
    kind: SOURCE_KINDS.article,
    key: articleKey(article),
    id: article?.id || null,
    slug: resolveArticleSlug(article) || null,
    title: resolveArticleTitle(article) || null,
    provider: resolveArticleProvider(article),
  };
}

/**
 * @param {object} params
 * @param {'plaud'|'recording'} [params.kind] where the recording came from
 * @param {string} params.recordingId the Plaud file id, or the `recordings` document id
 * @param {string} [params.title]
 */
export function describeRecordingSource({ kind = SOURCE_KINDS.plaud, recordingId, title }) {
  if (kind !== SOURCE_KINDS.plaud && kind !== SOURCE_KINDS.recording) {
    throw new Error(`Unknown recording source kind "${kind}"`);
  }
  const key = recordingKey(recordingId);
  return {
    kind,
    key,
    id: key,
    slug: null,
    title: String(title || '').trim() || null,
    provider: null,
  };
}

/** `<kind>_<key>`: `article_<slug>`, `plaud_<recordingId>`, `recording_<id>`. */
export function transcriptIdFor(source) {
  return `${source.kind}_${source.key}`;
}

/** Blob path for one transcript's audio. Validated by blob-paths `isValidBlobPath`. */
export function audioPathFor(source) {
  return `${source.kind}/${source.key}.mp3`;
}

/** `article_` + the key. The article-shaped door onto `transcriptIdFor`. */
export function transcriptId(article) {
  return transcriptIdFor(describeArticleSource(article));
}

/** Blob path for one article transcript's audio. */
export function audioPath(article) {
  return audioPathFor(describeArticleSource(article));
}

/**
 * The article's cloud provider as a lowercase slug, or null.
 *
 * Reads the two spellings the admin pages read (`'Cloud Provider'` on the
 * migrated half of the catalogue, `cloudProvider` on the rest) and nothing
 * else. Null is a valid answer — see the header.
 */
export function resolveArticleProvider(article) {
  const raw = String(article?.['Cloud Provider'] || article?.cloudProvider || '')
    .trim()
    .toLowerCase();
  return raw || null;
}

/**
 * Upload transcript audio and return the URL to persist.
 *
 * Site-relative, through the media delivery route, for the reasons
 * `uploadEpisodeAudio` gives: the storage account denies anonymous reads, and
 * a stored absolute URL breaks on any topology change.
 */
export async function uploadSourceAudio({ storage, source, audio, contentType }) {
  const path = audioPathFor(source);

  await storage.uploadBlob(PODCAST_AUDIO_CONTAINER, path, audio, contentType, {
    sourceKind: source.kind,
    sourceId: String(source.id || ''),
    sourceSlug: source.slug || '',
  });

  return { path, url: mediaUrlFor(PODCAST_AUDIO_CONTAINER, path), bytes: audio.length };
}

export function uploadTranscriptAudio({ storage, article, audio, contentType }) {
  return uploadSourceAudio({ storage, source: describeArticleSource(article), audio, contentType });
}

/**
 * The stored transcript shape. Everything the hub's review and the player read.
 *
 * `host` is reserved for #437: the Podbean publish record (episode id, URL,
 * published-at) lands there when an approval pushes the episode to the host.
 * Null until then, and present from the start so the hub can key on it.
 *
 * `source` is the generator's own provenance when it supplies one
 * (`recording-script.js` nests `{ kind: 'plaud', recordingId, … }`) and null
 * for an article, whose provenance is the flat `source*` fields above it.
 * `attributionLeaks` is the recording generator's measurement — transcript
 * speaker labels the finished dialogue repeated — for the hub to show as a
 * review warning; an empty list for every other kind.
 */
export function toTranscriptDocFor({ source, script, audio, now }) {
  return {
    id: transcriptIdFor(source),
    sourceKind: source.kind,
    sourceId: source.id ?? null,
    sourceSlug: source.slug ?? null,
    sourceTitle: source.title ?? null,
    sourceProvider: source.provider ?? null,
    title: script.title,
    summary: script.summary,
    keyTakeaways: script.keyTakeaways,
    // The transcript is the artefact: it is what the hub reviews against the
    // article, the accessible equivalent of the audio, and what #436 re-voices.
    transcript: script.dialogue,
    speakers: script.speakers,
    // Partial coverage is a fact about the transcript, so it travels with it —
    // the review is the only place a cut article can be caught.
    truncated: script.truncated === true,
    audioUrl: audio?.url || null,
    audioPath: audio?.path || null,
    audioBytes: audio?.bytes || null,
    speechProvider: audio?.speechProvider || null,
    speechModel: audio?.speechModel || null,
    // The ElevenLabs plan the audio was rendered on, as the pre-flight read
    // it (ADR 0029 §2a, 2026-09-26). Approval decides from these: free-plan
    // audio has no commercial licence and is not published
    // (speech-licence.js). Null when no provider reported a plan.
    speechTier: audio?.speechTier ?? null,
    speechFreePlan: typeof audio?.speechFreePlan === 'boolean' ? audio.speechFreePlan : null,
    durationSeconds: audio?.durationSeconds ?? null,
    // Set when the script generated but the audio did not — no speech key,
    // a rejected one, or a blob container Terraform has not created yet. The
    // hub shows it so "no player" is explained rather than mysterious.
    audioError: audio?.error || null,
    source: script.source && typeof script.source === 'object' ? script.source : null,
    attributionLeaks: Array.isArray(script.attributionLeaks) ? script.attributionLeaks : [],
    status: STATUS.draft,
    generatedAt: now,
    approvedAt: null,
    approvedBy: null,
    host: null,
  };
}

export function toTranscriptDoc({ article, script, audio, now }) {
  return toTranscriptDocFor({ source: describeArticleSource(article), script, audio, now });
}

/**
 * The fields a listing carries. An allowlist, like
 * `LISTEN_AND_LEARN_LIST_FIELDS`: the transcript body is withheld from the
 * list on purpose — it is kilobytes per row and the hub reads it one
 * transcript at a time through the detail route.
 */
export const TRANSCRIPT_LIST_FIELDS = Object.freeze([
  'id',
  'sourceKind',
  'sourceId',
  'sourceSlug',
  'sourceTitle',
  'sourceProvider',
  'title',
  'summary',
  'truncated',
  'audioUrl',
  'audioBytes',
  'durationSeconds',
  'audioError',
  'status',
  'error',
  'generatedAt',
  'approvedAt',
  'approvedBy',
  'host',
]);

/**
 * A Cosmos 404 on a write means the container itself is missing — a document
 * cannot be "not found" on an upsert. Say what that means and what fixes it.
 */
function explainWriteFailure(err) {
  const code = err?.code ?? err?.statusCode;
  if (code !== 404) return err;
  const wrapped = new Error(
    `Cosmos container "${TRANSCRIPT_CONTAINER}" is not provisioned yet, so the transcript could ` +
      `not be saved. It is declared in infra/cosmos-containers.json; run the Terraform apply that ` +
      `creates it, then generate again. Cosmos said: ${err?.message || err}`
  );
  wrapped.cause = err;
  return wrapped;
}

/**
 * Write one transcript as a draft, replacing any previous generation for the
 * same article. A whole-document replace, deliberately: a regenerated
 * transcript must not inherit the approval of the version it replaced.
 */
export async function saveTranscriptFor(store, { source, script, audio, now }) {
  const doc = toTranscriptDocFor({ source, script, audio, now });
  try {
    await store.upsertDoc(TRANSCRIPT_CONTAINER, doc);
  } catch (err) {
    throw explainWriteFailure(err);
  }
  return doc;
}

export function saveTranscript(store, { article, script, audio, now }) {
  return saveTranscriptFor(store, { source: describeArticleSource(article), script, audio, now });
}

/**
 * Record that a generation failed, so the hub shows a gap instead of silence.
 *
 * Merges onto whatever is stored, like `saveEpisodeFailure`: a previous good
 * transcript keeps its text and audio and is merely marked failed — replacing
 * it wholesale would destroy a working transcript because its *re*generation
 * failed.
 */
export async function markTranscriptFailedFor(store, { source, error, now }) {
  const id = transcriptIdFor(source);
  const existing = (await store.readDoc(TRANSCRIPT_CONTAINER, id, id)) || {};

  const doc = {
    ...existing,
    id,
    sourceKind: source.kind,
    sourceId: source.id || existing.sourceId || null,
    sourceSlug: source.slug || existing.sourceSlug || null,
    sourceTitle: source.title || existing.sourceTitle || null,
    sourceProvider: source.provider ?? existing.sourceProvider ?? null,
    status: STATUS.failed,
    error: String(error).slice(0, 500),
    generatedAt: now,
    host: existing.host ?? null,
  };
  try {
    await store.upsertDoc(TRANSCRIPT_CONTAINER, doc);
  } catch (err) {
    throw explainWriteFailure(err);
  }
  return doc;
}

export function markTranscriptFailed(store, { article, error, now }) {
  return markTranscriptFailedFor(store, { source: describeArticleSource(article), error, now });
}

/**
 * Approve or unapprove a single transcript.
 *
 * Publishing stamps who approved it and when. This is the act that will put
 * an AI-read episode under the owner's name on the podcast feed (#437 hangs
 * the host publish on it), so the provenance is the point.
 */
export async function setTranscriptStatus(store, { id, status, actorId, now }) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Unknown transcript status "${status}"`);
  }

  return store.patchDoc(
    TRANSCRIPT_CONTAINER,
    id,
    {
      status,
      approvedAt: status === STATUS.published ? now : null,
      approvedBy: status === STATUS.published ? actorId || null : null,
    },
    { partitionKey: id }
  );
}
