/**
 * interviews/interview-assets.js — an interview's blobs in the private
 * container (admin.js has the routes; ADR 0040, D10): the recordings a
 * document owns, deleting them with every version, and reading its
 * transcript. Logged by counts and codes, never a name. admin.js
 * re-exports what callers use.
 */
import { errorCode } from '../http/error-response.js';
import { interviewStorage } from './sibling-modules.js';
import { INTERVIEW_ID_PATTERN } from './tombstone.js';
import { ownsAudioPath } from './upload-checks.js';

const isInterview = (doc) => String(doc?.type || '').toLowerCase() === 'interview';

/**
 * The recordings the document names and owns: `provenance.audio.path` and
 * every path under `provenance.audio.superseded` (the recordings earlier
 * uploads replaced, ADR 0040 D1). A path counts only when it is one the
 * upload route could have minted for this interview,
 * `audio/<this id>/<upload id>.<ext>` (`ownsAudioPath`, ./upload.js), so a
 * planted path (another interview's recording, a transcript) is never
 * deleted; how many were refused is logged, never which.
 *
 * @param {object} doc
 * @param {object} [log]
 * @returns {string[]}
 */
export function ownedRecordingPaths(doc = {}, log = {}) {
  const audio = doc?.provenance?.audio;
  if (!audio || typeof audio !== 'object') return [];
  const named = [audio.path, ...(Array.isArray(audio.superseded) ? audio.superseded : [])].filter(
    (path) => path !== undefined && path !== null && path !== ''
  );
  const owned = [...new Set(named.filter((path) => ownsAudioPath(doc.id, path)))];
  const refused = named.length - named.filter((path) => ownsAudioPath(doc.id, path)).length;
  if (refused > 0) {
    log.warn?.(`[interviews] an interview names ${refused} recording path(s) it does not own; not deleted`);
  }
  return owned;
}

/**
 * Every blob name under a prefix, current or only a previous version: the
 * listing includes versions, so a recording whose base blob is already gone
 * but whose versions remain is still found and swept.
 */
async function blobNamesUnder({ blobs }, container, prefix) {
  const client = blobs.getContainerClient(container);
  const names = new Set();
  for await (const item of client.listBlobsFlat({ prefix, includeVersions: true })) {
    if (typeof item?.name === 'string' && item.name.startsWith(prefix)) names.add(item.name);
  }
  return [...names];
}

/**
 * Delete one blob and every version of it (ADR 0040, D10).
 *
 * The content account keeps blob versions, and deleting a versioned blob
 * without naming a version makes the current blob a previous version, which
 * the account's lifecycle rule keeps for up to 30 days. So the base blob is
 * deleted first (the recording stops being current whatever happens next),
 * then every version the container lists (`includeVersions`) is deleted by
 * its `versionId`. Blob soft delete (seven days on this account) then holds
 * the deleted versions, which is the only recovery path.
 *
 * Deleting a previous version needs the `deleteBlobVersion/action` data
 * action, which Storage Blob Data Owner holds; the upload slice granted the
 * Function App that role on the `interviews-audio` container alone
 * (`func_interviews_audio_owner`, infra/storage.tf), live once the owner
 * confirms that HCP Terraform run. The version deletes stay best effort and
 * counted: before the grant is applied a version delete answers 403, is
 * logged by code, and the lifecycle rule removes the version within 30 days;
 * the base delete above is what the caller's success depends on.
 *
 * @param {{ blobs: { getContainerClient: Function, deleteBlob: Function }, log?: object }} deps
 * @param {string} container
 * @param {string} name
 * @returns {Promise<{ versions: number, versionFailures: number }>}
 */
export async function deleteBlobWithVersions({ blobs, log = {} }, container, name) {
  await blobs.deleteBlob(container, name);
  const client = blobs.getContainerClient(container);
  let versions = 0;
  let versionFailures = 0;
  for await (const item of client.listBlobsFlat({ prefix: name, includeVersions: true })) {
    if (item?.name !== name || !item.versionId) continue;
    try {
      await client.getBlobClient(name).withVersion(item.versionId).delete();
      versions += 1;
    } catch (error) {
      versionFailures += 1;
      log.warn?.(`[interviews] a blob version was not deleted (${errorCode(error)})`);
    }
  }
  return { versions, versionFailures };
}

/**
 * Delete an interview's blobs from the private container, each with every
 * version it has (`deleteBlobWithVersions`). Best effort, one blob at a
 * time, so one failure does not keep the others; the counts are returned
 * and logged, never a name.
 *
 * Two scopes (ADR 0040, D10):
 *   - `interview` (the default; `deleteContentItem`'s hook, after the
 *     tombstone, ./tombstone.js): the WHOLE `audio/<id>/` and
 *     `transcripts/<id>/` prefixes, not only the paths the document names,
 *     so a recording an upload committed while the delete was starting goes
 *     too.
 *   - `recording` (DELETE cms/interviews/{id}/audio): the recording the
 *     document points at and every recording it superseded; transcripts
 *     stay.
 *
 * An id that is not shaped like one is refused before any listing: an empty
 * or slash-bearing id would turn `audio/<id>/` into a prefix that reaches
 * other interviews.
 *
 * @param {{ blobs: { deleteBlob: Function, getContainerClient: Function }, log?: object }} deps
 * @param {object} doc - the content document
 * @param {{ scope?: 'interview' | 'recording' }} [options]
 * @returns {Promise<{ deleted: number, failed: number, versionFailures: number }>}
 */
export async function deleteInterviewAssets({ blobs, log = {} }, doc, { scope = 'interview' } = {}) {
  const none = { deleted: 0, failed: 0, versionFailures: 0 };
  if (!doc || !isInterview(doc)) return none;
  if (!INTERVIEW_ID_PATTERN.test(String(doc.id || ''))) {
    log.warn?.('[interviews] an interview id is not shaped like one; nothing deleted');
    return none;
  }
  const storage = await interviewStorage();
  const container = storage.INTERVIEWS_AUDIO_CONTAINER;
  const names = await namesToDelete({ blobs, log }, container, doc, scope);
  const counts = await deleteEach({ blobs, log }, container, names);
  log.log?.(
    `[interviews] one interview: ${counts.deleted} blob(s) deleted, ${counts.failed} failed, ${counts.versionFailures} version(s) kept`
  );
  return counts;
}

/** The blobs a scope deletes: the recordings the document owns, and for a whole interview both its prefixes. */
async function namesToDelete({ blobs, log }, container, doc, scope) {
  const names = new Set(ownedRecordingPaths(doc, log));
  if (scope !== 'interview') return names;
  for (const prefix of [`audio/${doc.id}/`, `transcripts/${doc.id}/`]) {
    for (const name of await blobNamesUnder({ blobs }, container, prefix)) names.add(name);
  }
  return names;
}

/** Delete each blob with its versions, one at a time; a failure is counted and logged by code. */
async function deleteEach({ blobs, log }, container, names) {
  const counts = { deleted: 0, failed: 0, versionFailures: 0 };
  for (const name of names) {
    try {
      const outcome = await deleteBlobWithVersions({ blobs, log }, container, name);
      counts.deleted += 1;
      counts.versionFailures += outcome.versionFailures;
    } catch (error) {
      counts.failed += 1;
      log.warn?.(`[interviews] a blob of an interview was not deleted (${errorCode(error)})`);
    }
  }
  return counts;
}

/**
 * The transcript the document points at, read from the container, or null
 * when there is none yet or it cannot be read (the reason is logged by code).
 */
export async function readTranscript({ blobs, log }, doc) {
  const version = doc?.transcription?.version;
  if (!Number.isInteger(version) || version < 1) return null;
  try {
    const storage = await interviewStorage();
    const bytes = await blobs.downloadBlob(
      storage.INTERVIEWS_AUDIO_CONTAINER,
      storage.transcriptBlobPath(doc.id, version)
    );
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return {
      version,
      text: typeof parsed?.text === 'string' ? parsed.text : '',
      segments: Array.isArray(parsed?.segments) ? parsed.segments : [],
    };
  } catch (error) {
    log.warn?.(`[interviews] transcript v${version} was not read (${errorCode(error)})`);
    return null;
  }
}
