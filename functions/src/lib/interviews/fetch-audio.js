/**
 * fetch-audio.js — an audio URL, fetched by a job into the private container
 * (ADR 0040 D2, #1565).
 *
 *   POST /api/cms/interviews/{id}/audio-from-url { url }
 *     → job interview-fetch-audio { interviewId, sourceUrl }
 *     → guardedFetchStream, piped into interviews-audio/audio/<id>.<ext>
 *     → provenance.audio { container, path, bytes, sha256, contentType,
 *       uploadedAt, sourceUrl }, provenance.source 'url', interview.stage
 *       'fetched'
 *
 * THIS IS SERVER-SIDE REQUEST FORGERY SURFACE: an editor types a URL and
 * the Function App, inside the integration subnet with a managed identity,
 * fetches it. The fetch goes through lib/http/guarded-fetch.js and nowhere
 * else, as the stream variant: https only, the name resolved and refused if
 * private, loopback, link-local or Azure's platform address, the
 * connection pinned, at most 5 redirects each re-checked, a 10-minute
 * deadline over the whole exchange, the 500 MiB cap counted on the stream,
 * a declared Content-Length over the cap refused before a byte is read,
 * and the response type one of the three audio types (every spelling
 * browsers and file hosts use for them) or `application/octet-stream` with
 * an allowed extension on the URL path. There is no host allow-list by
 * default; `INTERVIEW_AUDIO_URL_HOSTS` (comma-separated host suffixes)
 * narrows it without a deploy, and the rule is applied to EVERY redirect
 * hop, so an allowed host cannot hand the fetch to another host.
 *
 * The URL is personal data by association (it names where a guest's voice
 * is kept): it is stored in the provenance block and never logged. Log
 * lines carry the interview id, the byte count, the type and the time.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { storedFailure } from '../http/error-response.js';
import { readSetting } from '../http/read-setting.js';
import { guardedFetchStream, responseMediaType, urlPathExtension } from '../http/guarded-fetch.js';
import { JobFailedError } from '../jobs.js';
import { AUDIO_TYPES, INTERVIEWS_AUDIO_CONTAINER, MAX_AUDIO_BYTES, audioBlobPath, canonicalAudioType } from './storage.js';

export const FETCH_JOB_TYPE = 'interview-fetch-audio';
export const FETCH_JOB_MAX_PAYLOAD_BYTES = 1024;
export const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
export const CONTENT_CONTAINER = 'content';
/** The app setting: comma-separated host suffixes; empty means any public host. */
export const HOSTS_SETTING = 'INTERVIEW_AUDIO_URL_HOSTS';
/** Bytes per uploaded block of the stream upload (the SDK's bufferSize). */
export const UPLOAD_BLOCK_BYTES = 4 * 1024 * 1024;
/** The payload bound leaves room for two ids: a URL longer than this is refused at the route. */
export const MAX_URL_CHARS = 800;

/**
 * The media types a browser or a file host sends for the three audio
 * types, keyed by the canonical type the container stores: the same
 * spellings storage.js's `canonicalAudioType` folds (slice A's upload uses
 * it too). The guard is handed every spelling as an allowed type, and the
 * answer is folded to the canonical type before any other check.
 */
export const AUDIO_TYPE_ALIASES = Object.freeze({
  'audio/mpeg': Object.freeze(['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg3']),
  'audio/mp4': Object.freeze(['audio/mp4', 'audio/x-m4a', 'audio/m4a']),
  'audio/wav': Object.freeze(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']),
});

export const ACCEPTED_EXTENSIONS = Object.freeze(Object.values(AUDIO_TYPES));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The canonical audio type for a media type or any of its aliases, or null (storage.js). */
export { canonicalAudioType };

/** The canonical type for an extension (`mp3` → `audio/mpeg`), or null. */
export function typeForExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  const found = Object.entries(AUDIO_TYPES).find(([, e]) => e === ext);
  return found ? found[0] : null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/**
 * The URL's shape, checked at the route before the job is queued: https,
 * a host name, no credentials, under the length the payload bound allows.
 * The guard does the network checks when the job runs.
 *
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function checkAudioUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, error: 'url is required.' };
  if (raw.length > MAX_URL_CHARS) return { ok: false, error: `The URL is longer than ${MAX_URL_CHARS} characters.` };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'The URL could not be read.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only an https:// URL is fetched.' };
  if (!parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname.startsWith('[')) {
    return { ok: false, error: 'The URL must name a public host.' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: 'A URL with credentials is not fetched.' };
  return { ok: true, url: parsed.href };
}

/** `{ interviewId, sourceUrl }`, or a refusal. Shared with the route that enqueues. */
export function parseFetchPayload(payload) {
  const interviewId = typeof payload?.interviewId === 'string' ? payload.interviewId.trim() : '';
  if (!ID.test(interviewId)) return { error: 'interviewId is required.' };
  const url = checkAudioUrl(payload?.sourceUrl);
  if (!url.ok) return { error: url.error };
  return { value: { interviewId, sourceUrl: url.url } };
}

/** The host suffixes the setting names, lower-cased; empty means any public host. */
export function allowedHostSuffixes(env = process.env) {
  return readSetting(env, HOSTS_SETTING)
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}

/** True when the setting is empty, or the host is one of its suffixes or under one. */
export function hostAllowed(hostname, suffixes) {
  if (!suffixes.length) return true;
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The container's type for a response: the normalised media type, or the extension for octet-stream. */
export function resolveAudioType(response, finalUrl) {
  const mediaType = responseMediaType(response);
  const canonical = canonicalAudioType(mediaType);
  if (canonical) return canonical;
  if (mediaType === 'application/octet-stream') return typeForExtension(urlPathExtension(finalUrl));
  return null;
}

/**
 * Fetch the URL into the container and record it on the document.
 *
 * @param {object} args
 * @param {string} args.interviewId
 * @param {string} args.sourceUrl
 * @param {{ readDoc: Function, patchDoc: Function }} args.store
 * @param {{ uploadBlobFromStream: Function, deleteBlob: Function }} args.storage
 * @param {Function} [args.fetchStream] - guardedFetchStream by default; tests inject one
 * @param {object} [args.env]
 * @param {() => Date} [args.now]
 * @param {{ log?: Function, warn?: Function }} [args.log]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.uploadId] - names the blob; the job id in production
 * @returns {Promise<{ interviewId: string, bytes: number, contentType: string, path: string }>}
 */
export async function fetchAudioToContainer({
  interviewId,
  sourceUrl,
  store,
  storage,
  fetchStream = guardedFetchStream,
  env = process.env,
  now = () => new Date(),
  log = null,
  signal = null,
  container = CONTENT_CONTAINER,
  uploadId = randomUUID(),
}) {
  const doc = await store.readDoc(container, interviewId, interviewId);
  if (!doc || doc.type !== 'interview') {
    throw new JobFailedError('No interview with that id.', { code: 'INTERVIEW_NOT_FOUND', status: 404 });
  }
  const suffixes = allowedHostSuffixes(env);
  const allowHost = (hostname) => hostAllowed(hostname, suffixes);
  const interview = isObject(doc.interview) ? doc.interview : {};
  const provenance = isObject(doc.provenance) ? doc.provenance : {};
  const recordFailure = async (error) => {
    const sentence = storedFailure(error, 'The download failed.');
    try {
      await store.patchDoc(container, interviewId, { interview: { ...interview, stage: 'failed', error: sentence } });
    } catch (writeError) {
      log?.warn?.(`${FETCH_JOB_TYPE}: failure not recorded (${writeError?.code ?? 'unknown'})`);
    }
    return error;
  };
  if (!allowHost(new URL(sourceUrl).hostname)) {
    throw await recordFailure(
      new JobFailedError('That host is not on the list INTERVIEW_AUDIO_URL_HOSTS allows.', {
        code: 'HOST_NOT_ALLOWED',
        status: 422,
      })
    );
  }
  await store.patchDoc(container, interviewId, { interview: { ...interview, stage: 'fetching', error: null } });

  const startedAt = Date.now();
  let fetched;
  try {
    fetched = await fetchStream(sourceUrl, {
      httpsOnly: true,
      maxRedirects: 5,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_AUDIO_BYTES,
      allowHost,
      allowedTypes: [...Object.values(AUDIO_TYPE_ALIASES).flat(), 'application/octet-stream'],
      allowedExtensions: [...ACCEPTED_EXTENSIONS],
      signal,
    });
  } catch (error) {
    throw await recordFailure(fetchFailure(error));
  }
  const contentType = resolveAudioType(fetched.response, fetched.url);
  if (!contentType) {
    fetched.stream.destroy();
    throw await recordFailure(
      new JobFailedError('The URL did not answer with an mp3, m4a or wav file.', {
        code: 'UNSUPPORTED_TYPE',
        status: 415,
      })
    );
  }
  // Its own blob per fetch (the job id names it), so a second fetch never
  // writes over the recording the document still points at; the one it
  // replaces is listed under `superseded` for slice C's delete helper, and
  // expires under the lifecycle rule in any case.
  const path = audioBlobPath(interviewId, uploadId, AUDIO_TYPES[contentType]);

  // Hash and count as the bytes are pulled through, so nothing flows until
  // the uploader reads; the stream's own error (the cap, the deadline) ends
  // the pipeline and the upload with it.
  const hash = createHash('sha256');
  let bytes = 0;
  const counted = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  let pipeError = null;
  pipeline(fetched.stream, counted, (error) => {
    if (error) pipeError = error;
  });
  const discard = () => storage.deleteBlob(INTERVIEWS_AUDIO_CONTAINER, path).catch(() => {});
  try {
    await storage.uploadBlobFromStream(INTERVIEWS_AUDIO_CONTAINER, path, counted, UPLOAD_BLOCK_BYTES, contentType);
  } catch (error) {
    await discard();
    throw await recordFailure(fetchFailure(pipeError || error));
  }
  if (pipeError) {
    await discard();
    throw await recordFailure(fetchFailure(pipeError));
  }
  if (bytes === 0) {
    await discard();
    throw await recordFailure(new JobFailedError('The URL answered with an empty file.', { code: 'AUDIO_EMPTY', status: 422 }));
  }
  const uploadedAt = now().toISOString();
  const previous = isObject(provenance.audio) && provenance.audio.path ? provenance.audio : null;
  const superseded = [
    ...(previous ? [{ container: previous.container || INTERVIEWS_AUDIO_CONTAINER, path: previous.path, uploadedAt: previous.uploadedAt ?? null }] : []),
    ...(Array.isArray(previous?.superseded) ? previous.superseded : []),
  ];
  await store.patchDoc(container, interviewId, {
    provenance: {
      ...provenance,
      source: 'url',
      audio: {
        container: INTERVIEWS_AUDIO_CONTAINER,
        path,
        bytes,
        sha256: hash.digest('hex'),
        contentType,
        durationSec: null,
        uploadedAt,
        sourceUrl,
        superseded,
      },
    },
    interview: { ...interview, stage: 'fetched', error: null },
  });
  log?.log?.(`${FETCH_JOB_TYPE}: ${bytes} B ${contentType} in ${Date.now() - startedAt} ms`);
  return { interviewId, bytes, contentType, path };
}

/** The guard's or the pipe's failure as a sentence the job may store: its code, never its words. */
function fetchFailure(error) {
  if (error instanceof JobFailedError) return error;
  const code = typeof error?.code === 'string' ? error.code : 'FETCH_FAILED';
  const sentences = {
    URL_REFUSED: 'That URL is not one this site will fetch (a private or unreachable address, or not https).',
    HOST_NOT_ALLOWED: 'The URL, or a redirect from it, led to a host that is not on the list INTERVIEW_AUDIO_URL_HOSTS allows.',
    BODY_TOO_LARGE: 'The file is larger than 500 MiB.',
    FETCH_TIMEOUT: 'The download did not finish within 10 minutes.',
    UNSUPPORTED_TYPE: 'The URL did not answer with an mp3, m4a or wav file.',
    FETCH_STATUS: 'The URL did not answer with the file (not a 2xx status).',
    REDIRECT_LIMIT: 'The URL redirected too many times.',
    REDIRECT_NO_LOCATION: 'The URL redirected nowhere.',
  };
  return new JobFailedError(sentences[code] || 'The download failed.', {
    code,
    status: ['URL_REFUSED', 'HOST_NOT_ALLOWED', 'UNSUPPORTED_TYPE'].includes(code) ? 422 : 502,
  });
}
