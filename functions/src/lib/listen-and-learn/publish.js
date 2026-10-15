/**
 * Persist generated Listen & Learn episodes.
 *
 * Episodes land as **drafts**. They are AI-written exam guidance published
 * under Saul's name on pages people study from, so nothing reaches the site
 * until it is approved in the admin portal. `status` is the only gate, and the
 * public read filters on it (public-reads.js `getListenAndLearn`).
 *
 * Layout
 *   Cosmos   listen_and_learn/{provider}_{examCode}              — the set (a book or course, ADR 0033 §4)
 *            listen_and_learn_episodes/{areaSlug} @ /setId       — one per area (a chapter)
 *            listen_and_learn_episodes/source_{slug} @ /setId    — one per source episode
 *            listen_and_learn_episodes/manual_{slug} @ /setId    — one per hand-made chapter
 *   Blob     listenandlearn/{provider}/{examCode}/{areaSlug}-{yyyymmddHHMMSS}.mp3
 *
 * AUDIO VERSIONS (ADR 0033 §4). Until 2026-10-03 regenerating an area wrote
 * the new MP3 to the SAME blob path, under a one-year immutable cache
 * header, so a listener who had heard the old take kept hearing it; and the
 * document was replaced wholesale, so a published episode went back to
 * draft, or — when the regeneration failed — off the site. Now every upload
 * carries a version stamp in its path, so regeneration never overwrites, and
 * a chapter carries `versions[]`, one entry per take, exactly one `active`.
 * The top-level `audioUrl` / `audioPath` / `audioBytes` / `durationSeconds` /
 * `speechProvider` / `speechModel` MIRROR the active version, so the public
 * readers and players need no change. A chapter written before versions
 * existed is read as one implicit version (`versionsOf`); its first
 * regeneration writes `versions[]` for real.
 *
 * Two containers rather than an `episodes[]` array on the set: episodes are
 * approved, regenerated and listened to individually, and concurrent array
 * updates on a single document lose writes. `listen_and_learn_episodes` is
 * partitioned on `/setId` precisely because an area slug is unique only within
 * its set — flattening these under `/id` would let AZ-104 and AZ-305 overwrite
 * each other's "manage-governance" episode (see cosmos-client PARTITION_KEY_PATHS).
 *
 * TWO KINDS OF EPISODE (#433). A guide-grounded episode is one scored area of
 * the official study guide; a source-grounded one is built from web pages and
 * YouTube videos the owner chose. Both live in the same container under the
 * same set, because both are Listen & Learn episodes of one certification,
 * and both are reviewed and approved the same way. What tells them apart is
 * `kind`, a STORED field — never inferred from whether `sources` happens to be
 * empty — read through `episodeKindOf`, which is the one place the rule "a
 * document with no `kind` is a guide episode" lives: every episode written
 * before #433 is a guide episode and carries no `kind`. The source list is
 * stored beside the transcript for the same reason the transcript is: a
 * reviewer who cannot see what the model was given is reviewing half of it.
 *
 * Ported from Site-Main `functions/listen-and-learn/publish.js` (088f458).
 * Firestore's `set({merge:true})` has no Cosmos equivalent — an upsert is a
 * whole-document replace — so the two merging writers read first and merge
 * explicitly. That is a round trip, and it is the reason the failure path
 * cannot quietly delete a good episode's transcript.
 */
import { mediaUrlFor } from '../blob-paths.js';
import { AuthoredError } from '../http/error-response.js';

/** A title that yields no id; the sentence is written below (authored, #945). */
export class EpisodeIdError extends AuthoredError {}

export const SET_CONTAINER = 'listen_and_learn';
export const EPISODE_CONTAINER = 'listen_and_learn_episodes';

/** Blob container for episode audio. Declared in infra/main.tf. */
export const AUDIO_CONTAINER = 'listenandlearn';

export const STATUS = {
  draft: 'draft',
  published: 'published',
  failed: 'failed',
  // Kept but off the site (ADR 0033 §4). The public reads select
  // `status = 'published'` in SQL, so an archived chapter leaves the site
  // with no change to any projection; `statusBeforeArchive` is what Restore
  // puts back.
  archived: 'archived',
};

/** What an episode was grounded on. See the header. */
export const EPISODE_KIND = Object.freeze({
  guide: 'guide',
  source: 'source',
  // A chapter made by hand from pasted text or an existing content item
  // (ADR 0033 §4), spoken by one narrator from `sourceText`.
  manual: 'manual',
});

/**
 * The one rule for reading `kind`: a document with none is a guide episode,
 * because every episode written before #433 was one and none of them carries
 * the field. Anything that is not a known kind is also read as guide rather
 * than passed through — a reader that branches on the value must not meet a
 * fourth one.
 */
export function episodeKindOf(doc) {
  const kind = doc?.kind;
  return kind === EPISODE_KIND.source || kind === EPISODE_KIND.manual ? kind : EPISODE_KIND.guide;
}

/** The document id of a hand-made chapter: `manual_<slug of its title>`. */
export const MANUAL_CHAPTER_ID_PREFIX = 'manual_';

/**
 * The id of a manual chapter, from its title.
 *
 * @param {string} title - the chapter title
 * @returns {string}
 * @throws {EpisodeIdError}
 */
export function manualChapterId(title) {
  const slug = slugifyTitle(title);
  if (!slug) throw new EpisodeIdError('A chapter needs a title with at least one letter or digit');
  return `${MANUAL_CHAPTER_ID_PREFIX}${slug}`;
}

/**
 * `2026-10-03T14:05:09.123Z` → `20261003140509`: the version stamp a blob
 * path carries, UTC, second resolution. Two takes of one chapter within one
 * second would share a path; the job runs for minutes, so they cannot.
 */
export function versionStamp(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** A stamped path, or null: `azure/az-104/area-1-20261003140509.mp3`. */
export const STAMPED_PATH_PATTERN = /-(\d{14})\.mp3$/;

/**
 * One audio version from what `renderAudio` returned. `id` is the stamp
 * when the path carries one — stable, sortable, and unique within a chapter
 * — and `legacy` for the implicit version a pre-ADR-0033 document is read
 * as.
 */
export function toVersion(audio, { now, actorId = null, costUsd = null } = {}) {
  if (!audio?.url) return null;
  const stamp = STAMPED_PATH_PATTERN.exec(String(audio.path || ''))?.[1];
  return {
    id: stamp || 'legacy',
    audioUrl: audio.url,
    audioPath: audio.path || null,
    audioBytes: audio.bytes || null,
    durationSeconds: audio.durationSeconds ?? null,
    speechProvider: audio.speechProvider || null,
    speechModel: audio.speechModel || null,
    voice: audio.voice || null,
    generatedAt: now || null,
    generatedBy: actorId,
    costUsd: typeof costUsd === 'number' ? costUsd : null,
    active: true,
  };
}

/**
 * A chapter's versions, oldest first. A document with none but with audio
 * is one implicit, active version built from its top-level fields; one with
 * neither has no versions.
 */
export function versionsOf(doc) {
  if (Array.isArray(doc?.versions) && doc.versions.length > 0) return doc.versions;
  if (!doc?.audioUrl) return [];
  return [
    {
      id: 'legacy',
      audioUrl: doc.audioUrl,
      audioPath: doc.audioPath || null,
      audioBytes: doc.audioBytes || null,
      durationSeconds: doc.durationSeconds ?? null,
      speechProvider: doc.speechProvider || null,
      speechModel: doc.speechModel || null,
      voice: null,
      generatedAt: doc.generatedAt || null,
      generatedBy: null,
      costUsd: null,
      active: true,
    },
  ];
}

export function activeVersionOf(doc) {
  const versions = versionsOf(doc);
  return versions.find((v) => v.active) || versions[versions.length - 1] || null;
}

/** The top-level fields that mirror the active version, from that version. */
export function mirrorActiveVersion(doc) {
  const active = activeVersionOf(doc);
  return {
    ...doc,
    audioUrl: active?.audioUrl || null,
    audioPath: active?.audioPath || null,
    audioBytes: active?.audioBytes || null,
    durationSeconds: active?.durationSeconds ?? null,
    speechProvider: active?.speechProvider || null,
    speechModel: active?.speechModel || null,
  };
}

/**
 * The document after a regeneration landed (ADR 0033 §4): the fresh script
 * and metadata, the previous takes kept and deactivated, the new take
 * active, and the APPROVAL KEPT — a published chapter stays published in
 * its new voice, which is what "regenerate" means to a listener. Where the
 * regeneration produced no audio (speech not configured), the previous
 * active take stays active and `audioError` says why there is no new one.
 * Edits an operator made by hand (a renamed title, a changed order) survive
 * because they are marked when written (`titleEditedAt`, `orderEditedAt`).
 *
 * @param {object|null} existing the stored document, or null for a first take
 * @param {object} fresh the document `toEpisodeDoc` built for this run
 * @param {{ now: string, actorId?: string|null, costUsd?: number|null }} meta
 */
export function mergeRegeneration(existing, fresh, { now, actorId = null, costUsd = null } = {}) {
  const previous = versionsOf(existing).map((v) => ({ ...v, active: false }));
  const incoming = toVersion(
    fresh.audioUrl
      ? {
          url: fresh.audioUrl,
          path: fresh.audioPath,
          bytes: fresh.audioBytes,
          durationSeconds: fresh.durationSeconds,
          speechProvider: fresh.speechProvider,
          speechModel: fresh.speechModel,
          voice: fresh.voice || null,
        }
      : null,
    { now, actorId, costUsd }
  );
  // No new take: the last active one stays active.
  const versions = incoming ? [...previous, incoming] : versionsOf(existing);

  const keepStatus = existing?.status === STATUS.published || existing?.status === STATUS.archived;
  const merged = {
    ...fresh,
    versions,
    status: keepStatus ? existing.status : STATUS.draft,
    approvedAt: keepStatus ? (existing.approvedAt ?? null) : null,
    approvedBy: keepStatus ? (existing.approvedBy ?? null) : null,
    ...(existing?.statusBeforeArchive ? { statusBeforeArchive: existing.statusBeforeArchive } : {}),
    ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
    ...(existing?.titleEditedAt
      ? { title: existing.title, titleEditedAt: existing.titleEditedAt }
      : {}),
    ...(existing?.orderEditedAt
      ? { order: existing.order, orderEditedAt: existing.orderEditedAt }
      : {}),
    ...(existing?.sourceContentId ? { sourceContentId: existing.sourceContentId } : {}),
    firstGeneratedAt: existing?.firstGeneratedAt || existing?.generatedAt || now,
    regeneratedAt: existing ? now : null,
    lastError: null,
    updatedAt: now,
    updatedBy: actorId,
  };
  const mirrored = mirrorActiveVersion(merged);
  // An old take kept active because the new run had no audio still carries
  // the run's explanation.
  return { ...mirrored, audioError: fresh.audioError || null };
}

/** The spellings the pipeline keeps an article's body under, first match wins. */
const SPEAKABLE_FIELDS = Object.freeze(['postContent', 'blogDraft', 'content', 'Content']);

/**
 * The top-level fields a hand-made chapter's text lives in, from a content
 * item's body: the pipeline keeps the article under several spellings
 * (lib/cms/content-quality.js reads the same four), HTML tags are dropped
 * and whitespace collapsed because the text is spoken, not shown.
 */
export function speakableTextOf(item) {
  const field = SPEAKABLE_FIELDS.find((key) => item?.[key]);
  let text = String(field ? item[field] : '');
  let prev;
  // Innermost tags first, repeated until stable: a single pass over
  // `<scr<script>ipt>` leaves `ipt>` behind, and a tag that survives is read
  // aloud as angle brackets.
  do {
    prev = text;
    text = text.replace(/<[^<>]*>/g, ' ');
  } while (text !== prev);
  // `&amp;` is decoded LAST. Decoding it first turns the literal text
  // `&amp;lt;` into `&lt;`, which the next replace then reads as `<` — the
  // double-unescape CodeQL js/double-escaping names (PR #841).
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * The document id of a source-grounded episode: `source_<slug of its title>`.
 *
 * Within the set's partition, so regenerating the same title replaces the
 * same document — idempotent, like a guide area. The underscore is the point:
 * `studyguide.slugify` maps every non-alphanumeric run to a single hyphen, so
 * no guide area can ever produce an id containing `_`, and a guide area named
 * "Source control" (slug `source-control`) cannot collide with a source
 * episode titled "Control" — which `source-control` would have. The id is
 * also the blob path segment, and `_` is within `blob-paths` PATH_PATTERN.
 */
export const SOURCE_EPISODE_ID_PREFIX = 'source_';

/** `Manage Azure identities` → `manage-azure-identities`; same rule as studyguide.js. */
export function slugifyTitle(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The id of a source-grounded episode, from its title.
 *
 * @param {string} title - the episode title
 * @returns {string}
 * @throws {EpisodeIdError}
 */
export function sourceEpisodeId(title) {
  const slug = slugifyTitle(title);
  if (!slug)
    throw new EpisodeIdError('A source-grounded episode needs a title with at least one letter or digit');
  return `${SOURCE_EPISODE_ID_PREFIX}${slug}`;
}

/**
 * Where source episodes sort: after every guide area. `order` is study-guide
 * position for guide episodes and the largest real guide has eight areas, so
 * anything past that keeps the guide's order intact and puts the owner's own
 * episodes at the end of the set. Several source episodes tie, and the sort in
 * handlers.js is stable, so they keep query order among themselves.
 */
export const SOURCE_EPISODE_ORDER = 1000;

/** `azure` + `AZ-104` → `azure_az-104`. Stable, readable, collision-free. */
export function setId(provider, examCode) {
  return `${String(provider).toLowerCase()}_${String(examCode).toLowerCase()}`;
}

/**
 * Blob path for one episode's audio. Validated by blob-paths `isValidBlobPath`.
 * With a `stamp` (every new upload, ADR 0033 §4) the path is per version, so
 * regeneration never overwrites; without one it is the pre-2026-10-03 path,
 * which public-media.js serves with a short cache instead of an immutable one.
 */
export function audioPath(provider, examCode, areaSlug, stamp = null) {
  const suffix = stamp ? `-${stamp}` : '';
  return `${String(provider).toLowerCase()}/${String(examCode).toLowerCase()}/${areaSlug}${suffix}.mp3`;
}

/**
 * Upload episode audio and return the URL to persist.
 *
 * The URL is site-relative and points at the media delivery route, not at the
 * storage account. The account denies anonymous reads outright
 * (`allow_nested_items_to_be_public = false` plus a network deny rule), so a
 * direct blob URL would be dead on arrival — and a stored absolute URL breaks
 * on any topology change. Both reasons are set out in public-media.js.
 */
export async function uploadEpisodeAudio({
  storage,
  provider,
  examCode,
  areaSlug,
  audio,
  contentType,
  stamp = null,
}) {
  const path = audioPath(provider, examCode, areaSlug, stamp);

  await storage.uploadBlob(AUDIO_CONTAINER, path, audio, contentType, {
    provider: String(provider).toLowerCase(),
    examCode: String(examCode).toUpperCase(),
    areaSlug,
  });

  return { path, url: mediaUrlFor(AUDIO_CONTAINER, path), bytes: audio.length };
}

/**
 * The stored episode shape. Everything the admin review and the player read.
 *
 * `kind` is written on every new document, guide episodes included, from
 * #433 on; `sources` is the list `validateGroundingSources` resolved — deduped,
 * classified — and is empty for a guide episode, which is not what makes it
 * one (see the header).
 */
export function toEpisodeDoc({
  area,
  script,
  audio,
  videos,
  examCode,
  provider,
  order,
  now,
  kind = EPISODE_KIND.guide,
  sources = [],
  sourceText = null,
  sourceContentId = null,
}) {
  return {
    id: area.slug,
    setId: setId(provider, examCode),
    provider,
    examCode,
    areaSlug: area.slug,
    areaName: area.name,
    kind: episodeKindOf({ kind }),
    sources: Array.isArray(sources) ? sources : [],
    // What was spoken, kept so a chapter can be regenerated in another voice
    // without the script being written again (ADR 0033 §4). For a dialogue
    // episode the transcript below is that text; `sourceText` is for the
    // hand-made chapter whose text came from an operator or a content item.
    sourceText: typeof sourceText === 'string' && sourceText ? sourceText : null,
    sourceContentId: sourceContentId || null,
    versions: [],
    // Position in the official study guide. Episodes are listened to in the
    // order the exam presents them, which is rarely the order a query returns
    // and never the order exam weighting would give.
    order: Number.isInteger(order) ? order : 0,
    weightLabel: area.weightLabel || '',
    weightLow: area.weightLow ?? null,
    title: script.title,
    summary: script.summary,
    keyTakeaways: script.keyTakeaways,
    // The transcript is kept deliberately: it is the accessible equivalent of
    // the audio, and it is what makes an episode reviewable before approval.
    transcript: script.dialogue,
    speakers: script.speakers,
    audioUrl: audio?.url || null,
    audioPath: audio?.path || null,
    audioBytes: audio?.bytes || null,
    // Provenance for the audio, alongside the approver's for the decision.
    speechProvider: audio?.speechProvider || null,
    speechModel: audio?.speechModel || null,
    durationSeconds: audio?.durationSeconds ?? null,
    // Set when the script generated but synthesis did not — no key yet, or a
    // rejected one. The admin page shows it so "no player" is explained
    // rather than mysterious.
    audioError: audio?.error || null,
    videos: videos || [],
    status: STATUS.draft,
    generatedAt: now,
    approvedAt: null,
    approvedBy: null,
  };
}

/**
 * Write one episode, merging onto any previous generation for the same area
 * (`mergeRegeneration`). Regeneration is idempotent because the document id
 * is the area slug within the set's partition.
 *
 * A merge, not a replace, from ADR 0033 §4 on: a re-run of a whole set must
 * not clear its approvals, and a regenerated chapter keeps its earlier takes
 * as versions. Until then this was a whole-document replace so that a new
 * take could not inherit an approval — which also meant every re-run took a
 * set off the site until each episode was approved again.
 */
export async function saveEpisode(
  store,
  {
    provider,
    examCode,
    area,
    script,
    audio,
    videos,
    order,
    now,
    kind,
    sources,
    sourceText,
    sourceContentId,
    actorId = null,
    costUsd = null,
  }
) {
  const fresh = toEpisodeDoc({
    area,
    script,
    audio,
    videos,
    examCode,
    provider,
    order,
    now,
    kind,
    sources,
    sourceText,
    sourceContentId,
  });
  const existing = await store.readDoc(EPISODE_CONTAINER, fresh.id, fresh.setId);
  const doc = mergeRegeneration(existing || null, fresh, { now, actorId, costUsd });
  await store.upsertDoc(EPISODE_CONTAINER, doc);
  return doc;
}

/**
 * Record that an area failed, so the admin page shows a gap instead of silence.
 *
 * Merges onto whatever is stored. A previous good generation keeps its
 * transcript and audio — and, from ADR 0033 §4 on, its STATUS: a published
 * chapter whose regeneration failed stays published, in its previous take,
 * with `lastError` saying what happened so the card can offer Retry and
 * Keep current. Only a chapter that was never good, or was a draft, is
 * marked failed; replacing a working episode because its *re*generation
 * failed is the bug this used to have.
 *
 * `kind` is written explicitly: a failure marker for a source episode that
 * had never succeeded would otherwise be a document with no `kind`, which
 * `episodeKindOf` reads as guide. The caller's kind wins, then the stored
 * one, then the default.
 */
export async function saveEpisodeFailure(
  store,
  { provider, examCode, area, error, order, now, kind }
) {
  const id = setId(provider, examCode);
  const existing = (await store.readDoc(EPISODE_CONTAINER, area.slug, id)) || {};
  const message = String(error).slice(0, 500);
  const keepLive = existing.status === STATUS.published || existing.status === STATUS.archived;

  await store.upsertDoc(EPISODE_CONTAINER, {
    ...existing,
    id: area.slug,
    setId: id,
    provider,
    examCode,
    areaSlug: area.slug,
    areaName: area.name || existing.areaName || area.slug,
    kind: episodeKindOf(kind ? { kind } : existing),
    weightLabel: area.weightLabel || existing.weightLabel || '',
    order: Number.isInteger(order) ? order : (existing.order ?? 0),
    status: keepLive ? existing.status : STATUS.failed,
    error: keepLive ? (existing.error ?? null) : message,
    lastError: { message, at: now, attempt: 'regeneration' },
    generatedAt: keepLive ? existing.generatedAt || now : now,
    updatedAt: now,
  });
}

/**
 * Upsert the parent document that describes the certification this set
 * belongs to. A merge: the Audio Library fields an operator set (kind,
 * title, author, description, cover, tags, voice — ADR 0033 §4) survive a
 * re-run, and a set with no `kind` is a course, because every set written
 * before the library existed was one. `areaSlugs` is what the admin read
 * compares a guide chapter against to say "not in the current guide".
 */
export async function saveSet(store, { provider, examCode, guide, cert, now, actorId }) {
  const id = setId(provider, examCode);
  const existing = (await store.readDoc(SET_CONTAINER, id, id)) || {};

  const doc = {
    ...existing,
    id,
    provider,
    examCode,
    kind: existing.kind === 'book' ? 'book' : 'course',
    certSlug: cert?.slug || existing.certSlug || String(examCode).toLowerCase(),
    certTitle: cert?.title || existing.certTitle || guide.title,
    title: existing.title || cert?.title || guide.title,
    studyGuideUrl: guide.sourceUrl,
    studyGuideTitle: guide.title,
    areaCount: guide.areas.length,
    areaSlugs: guide.areas.map((area) => area.slug),
    generatedAt: now,
    generatedBy: actorId || null,
    createdAt: existing.createdAt || existing.generatedAt || now,
    updatedAt: now,
    updatedBy: actorId || null,
  };

  await store.upsertDoc(SET_CONTAINER, doc);
  return doc;
}

/**
 * The set a source-grounded episode belongs to, created only if it is missing.
 *
 * A source episode is one episode of a certification, not a guide run, so it
 * must not do what `saveSet` does — stamp `generatedAt` and `studyGuideUrl`
 * as if the guide had been parsed again. If the set exists it is left exactly
 * as it is. If it does not (the owner grounded an episode before ever running
 * the guide), a minimal set is written so the admin list and `getSet` can
 * find the episode: `areaCount` 0 and no study-guide fields, which the guide
 * run fills in when it happens.
 */
export async function ensureSet(store, { provider, examCode, cert, now, actorId }) {
  const id = setId(provider, examCode);
  const existing = await store.readDoc(SET_CONTAINER, id, id);
  if (existing) return existing;

  const doc = {
    id,
    provider,
    examCode,
    kind: 'course',
    certSlug: cert?.slug || String(examCode).toLowerCase(),
    certTitle: cert?.title || String(examCode),
    title: cert?.title || String(examCode),
    studyGuideUrl: null,
    studyGuideTitle: null,
    areaCount: 0,
    generatedAt: now,
    generatedBy: actorId || null,
    createdAt: now,
    updatedAt: now,
    updatedBy: actorId || null,
  };
  await store.upsertDoc(SET_CONTAINER, doc);
  return doc;
}

/**
 * Approve or unapprove a single episode.
 *
 * Publishing stamps who approved it and when — for AI-generated study content
 * the provenance is the point, not decoration.
 */
export async function setEpisodeStatus(
  store,
  { provider, examCode, areaSlug, status, actorId, now }
) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Unknown episode status "${status}"`);
  }
  const id = setId(provider, examCode);

  return store.patchDoc(
    EPISODE_CONTAINER,
    areaSlug,
    {
      status,
      approvedAt: status === STATUS.published ? now : null,
      approvedBy: status === STATUS.published ? actorId || null : null,
    },
    { partitionKey: id }
  );
}
