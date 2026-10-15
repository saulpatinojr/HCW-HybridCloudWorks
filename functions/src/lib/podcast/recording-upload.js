/**
 * Upload audio, have Plaud Embedded transcribe it, keep the transcript (#442).
 *
 *   browser → POST cms/podcast/recordings/upload (base64 JSON)
 *           → blob podcast/uploads/<uuid>.<ext>
 *           → job transcribe-recording-upload { uploadPath, title }
 *           → Plaud Embedded: create, poll to SUCCESS
 *           → recordings/<uuid> { source: 'plaud-embedded', segments, … }
 *
 * The transcript is the artefact worth keeping — it is what "Script this"
 * feeds — and the audio is kept only because Plaud has to fetch it from
 * somewhere. That somewhere is the public media route: the storage account
 * denies direct and SAS reads by network rule, so `mediaUrlFor` is the only
 * URL Plaud can read (plaud-embedded.js says more). The path is server-minted
 * — a v4 UUID, never caller-chosen — so the URL is unguessable, and it is
 * still unauthenticated for as long as the blob exists.
 *
 * **So the blob does not exist for long.** Two things bound it:
 *
 *   1. The job deletes the upload as soon as the transcription reaches a
 *      terminal state — SUCCESS, FAILURE, REVOKED, or a submission that never
 *      happened — in a `finally`, best-effort (a failed delete is logged by
 *      job id and never changes the outcome). The one case that keeps it is
 *      a poll that ran out of time (`PLAUD_EMBEDDED_TIMEOUT`): Plaud may still
 *      be reading the file, and the transcription can be re-read by id for
 *      seven days.
 *   2. A lifecycle rule in infra/storage.tf (`expire-recording-uploads`)
 *      deletes anything under `podcast/uploads/` seven days after creation —
 *      the blob a dead worker or an undelivered message left behind. Seven,
 *      because Plaud retains the transcription for seven days, after which
 *      there is nothing the audio could be re-read for.
 *
 * **Why this route writes to a generated-media container.** blob-paths.js
 * keeps `PUBLIC_MEDIA_CONTAINERS ∩ UPLOAD_CONTAINERS` empty so an editor
 * cannot put an arbitrary file behind an anonymous URL through the generic
 * upload route. This route is deliberately narrower than that one: it
 * accepts three audio media types and nothing else, checks the extension
 * against the declared type, refuses before storing when Plaud Embedded is
 * not configured (an upload nothing can transcribe is a file nobody wanted),
 * and names the blob itself. `podcast` stays out of `UPLOAD_CONTAINERS`, so
 * the generic route still cannot reach it.
 *
 * **Limits.** Base64 JSON, the shape admin-uploads.js already handles, with
 * the same three checks in the same order (Content-Length, base64 length,
 * decoded length) and a 40 MiB ceiling: an hour at 64 kbps is about 29 MB,
 * and the Plaud device records at or below that. A raw-bytes body would
 * halve the memory cost; it would also need a second CORS header allowance
 * and a second upload contract in the browser, which this slice does not
 * take on.
 *
 * The job runs under the platform-jobs timeout, polling every ten seconds
 * (a tenth of Plaud's 60 req/min). Plaud retains the result for seven days,
 * so a job that times out still leaves the `transcriptionId` in its error
 * for an operator to read back by hand.
 */
import { mediaUrlFor } from '../blob-paths.js';
import { PODCAST_AUDIO_CONTAINER } from './store.js';
import {
  PlaudEmbeddedError,
  PlaudEmbeddedNotConfiguredError,
  createTranscription,
  isPlaudEmbeddedConfigured,
  normalizeEmbeddedResult,
  waitForTranscription,
} from './plaud-embedded.js';
import { RECORDINGS_CONTAINER } from './recording-generate.js';

/** The platform job that polls Plaud. Shared with the route that enqueues it. */
export const UPLOAD_JOB_TYPE = 'transcribe-recording-upload';

/** Prefix under the `podcast` container. Validated by blob-paths `isValidBlobPath`. */
export const UPLOAD_PREFIX = 'uploads';

/** What `recordings.source` says for a transcript Plaud Embedded produced. */
export const EMBEDDED_SOURCE = 'plaud-embedded';

export const MAX_AUDIO_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_AUDIO_BASE64_CHARS = Math.ceil(MAX_AUDIO_UPLOAD_BYTES / 3) * 4;
/** The JSON envelope: a title, a file name, a type, key names, escaping. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_AUDIO_BASE64_CHARS + 8 * 1024;
export const MAX_TITLE_CHARS = 200;

/**
 * The audio types Plaud documents (M4A, MP3, WAV), keyed by the canonical
 * media type that is stored and served, with every spelling browsers send
 * for each. The extension must agree with the type for the reason
 * admin-uploads.js gives: the media route serves the stored type verbatim.
 */
const AUDIO_TYPES = [
  { canonical: 'audio/mpeg', aliases: ['audio/mpeg', 'audio/mp3'], extensions: ['mp3'] },
  {
    canonical: 'audio/mp4',
    aliases: ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'],
    extensions: ['m4a'],
  },
  {
    canonical: 'audio/wav',
    aliases: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
    extensions: ['wav'],
  },
];

export const ACCEPTED_AUDIO_EXTENSIONS = Object.freeze(
  AUDIO_TYPES.flatMap((t) => t.extensions)
);

function normalizeMediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function extensionOf(fileName) {
  const segment = String(fileName || '')
    .split(/[\\/]/)
    .pop();
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  return segment.slice(dot + 1).toLowerCase();
}

/**
 * Decide the stored media type and extension for an upload, or refuse.
 *
 * @param {{ contentType: unknown, fileName: unknown }} args
 * @returns {{ ok: true, contentType: string, extension: string } | { ok: false, message: string }}
 */
export function checkAudioUpload({ contentType, fileName }) {
  const declared = normalizeMediaType(contentType);
  const extension = extensionOf(fileName);
  const byType = AUDIO_TYPES.find((t) => t.aliases.includes(declared));
  if (!byType) {
    return {
      ok: false,
      message: `Unsupported audio type; send an ${ACCEPTED_AUDIO_EXTENSIONS.join(', ')} file`,
    };
  }
  if (!byType.extensions.includes(extension)) {
    return { ok: false, message: 'File extension does not match the declared audio type' };
  }
  return { ok: true, contentType: byType.canonical, extension };
}

/** `uploads/<uuid>.<ext>` — the only shape this module writes. */
export function uploadPathFor(id, extension) {
  return `${UPLOAD_PREFIX}/${id}.${extension}`;
}

const UPLOAD_PATH_PATTERN = new RegExp(
  `^${UPLOAD_PREFIX}/[A-Za-z0-9-]{8,64}\\.(${ACCEPTED_AUDIO_EXTENSIONS.join('|')})$`
);

/**
 * Validate the job payload. The path is held to the shape `uploadPathFor`
 * mints — the job builds a public URL from it, so a payload naming any other
 * blob would make the job an oracle for whether that blob exists.
 */
export function parseUploadPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const uploadPath = typeof raw.uploadPath === 'string' ? raw.uploadPath.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!uploadPath) return { error: 'uploadPath is required' };
  if (!UPLOAD_PATH_PATTERN.test(uploadPath)) return { error: 'uploadPath is not an upload path' };
  if (!title) return { error: 'title is required' };
  if (title.length > MAX_TITLE_CHARS) return { error: `title is longer than ${MAX_TITLE_CHARS} characters` };
  return { value: { uploadPath, title } };
}

/**
 * The absolute URL Plaud fetches the audio from: the media route on the
 * API's public origin. `PUBLIC_API_ORIGIN` is the origin the SPA calls the
 * API on (the site's own hostname, since the API is reverse-proxied under
 * /api); without it there is no URL a third party can reach, which is a
 * configuration failure to say plainly rather than a 404 from Plaud.
 */
export function publicAudioUrlFor(uploadPath, env = process.env) {
  const origin = String(env?.PUBLIC_API_ORIGIN || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) {
    throw new PlaudEmbeddedError(
      'PUBLIC_API_ORIGIN is not set to the https origin the media route is served on, so there is no URL Plaud can fetch the audio from'
    );
  }
  return `${origin}${mediaUrlFor(PODCAST_AUDIO_CONTAINER, uploadPath)}`;
}

/** The plain-text rendering `POST cms/recordings` documents already carry. */
export function renderTranscriptText(segments) {
  return segments
    .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
    .join('\n');
}

/**
 * The `recordings` document for one transcribed upload. The same fields a
 * manual paste writes (`title`, `transcript`, `source`, `status`, `createdAt`)
 * so the hub lists both kinds through one read, plus the structured
 * `segments` the recording generator prefers.
 */
export function toRecordingDoc({ id, title, uploadPath, transcriptionId, result, now }) {
  return {
    id,
    title,
    source: EMBEDDED_SOURCE,
    status: 'new',
    transcript: renderTranscriptText(result.segments),
    segments: result.segments,
    durationMs: result.durationMs,
    language: result.language,
    transcriptionId,
    // Recorded for provenance. The blob itself is deleted once Plaud is done
    // with it (see the header), so this is where the audio WAS, not a player.
    uploadPath,
    createdAt: now,
  };
}

/**
 * Run one upload through Plaud Embedded and store the transcript.
 *
 * @param {object} params
 * @param {string} params.uploadPath
 * @param {string} params.title
 * @param {{ upsertDoc: Function }} params.store
 * @param {{ deleteBlob: Function }} [params.storage] deletes the upload once Plaud is done with it
 * @param {object} [params.env]
 * @param {string} [params.now]
 * @param {number} [params.timeoutMs] the poll budget; the job's own minus headroom
 * @param {{ warn?: Function }} [params.log] content-free; job-level only
 * @param {object} [params.deps] test seams
 * @returns {Promise<{ id: string, transcriptionId: string, segments: number, durationMs: number|null, uploadDeleted: boolean }>}
 */
export async function transcribeUpload({
  uploadPath,
  title,
  store,
  storage = null,
  env = process.env,
  now = new Date().toISOString(),
  timeoutMs = 20 * 60 * 1000,
  log = console,
  deps = {},
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseUploadPayload({ uploadPath, title });
  if (parsed.error) throw new PlaudEmbeddedError(parsed.error);

  const create = deps.createTranscription || createTranscription;
  const wait = deps.waitForTranscription || waitForTranscription;
  const uuid = deps.uuid || (() => crypto.randomUUID());

  // Same sentence the route gives at the door; the job is the guard for a
  // caller that enqueued through the generic route.
  if (!isPlaudEmbeddedConfigured(env)) throw new PlaudEmbeddedNotConfiguredError();

  // The upload is deleted whatever happens below, except when the poll ran
  // out of time — see the header. Best effort: a delete that fails is logged
  // and the transcription's own outcome stands.
  let keepForPlaud = false;
  let uploadDeleted = false;
  const deleteUpload = async () => {
    if (!storage?.deleteBlob) return;
    try {
      await storage.deleteBlob(PODCAST_AUDIO_CONTAINER, parsed.value.uploadPath);
      uploadDeleted = true;
    } catch (err) {
      log?.warn?.(`${UPLOAD_JOB_TYPE}: upload blob not deleted (${err?.code || err?.statusCode || 'error'})`);
    }
  };

  let transcriptionId;
  let result;
  try {
    const fileUrl = publicAudioUrlFor(parsed.value.uploadPath, env);
    ({ transcriptionId } = await create({ fileUrl, env, ...(signal ? { signal } : {}) }));
    const task = await wait({ transcriptionId, env, timeoutMs, ...(signal ? { signal } : {}) });
    result = normalizeEmbeddedResult(task.data);
  } catch (err) {
    keepForPlaud = err?.code === 'PLAUD_EMBEDDED_TIMEOUT';
    throw err;
  } finally {
    if (!keepForPlaud) await deleteUpload();
  }

  const doc = toRecordingDoc({
    id: uuid(),
    title: parsed.value.title,
    uploadPath: parsed.value.uploadPath,
    transcriptionId,
    result,
    now,
  });
  await store.upsertDoc(RECORDINGS_CONTAINER, doc);

  return {
    id: doc.id,
    transcriptionId,
    segments: result.segments.length,
    durationMs: result.durationMs,
    uploadDeleted,
  };
}
