/**
 * admin.js — the admin routes behind /admin/interviews (ADR 0040, D5, D9
 * and D10's deletion rule). Registration is functions/interviews-admin-http.js.
 *
 *   POST   cms/interviews             create one at `draft`, with the consent record
 *   GET    cms/interviews             the list: stage, status, guest, dates (no bodies)
 *   GET    cms/interviews/{id}        the document plus its transcript, read from the container
 *   DELETE cms/interviews/{id}/audio  delete the recording (publisher)
 *
 * Edits go through the existing `updateContentItem` route with its ETag;
 * the upload, fetch, transcribe and draft routes are the other slices'.
 *
 * WHAT IS LOGGED. Ids, counts, bytes and error codes. Never a name, a
 * sentence of the transcript, a URL or a file name: a recording and its
 * transcript are the guest's own words and voice.
 *
 * The create reuses `createContentDocument` (cms/content-create.js), so the
 * seven-day title dedup, the document shape, the id and the actor stamp are
 * the ones every other content item gets — the ADR's "reuse the pipeline,
 * do not copy it".
 */
import { randomUUID } from 'node:crypto';
import { readJsonBodyWithin } from '../http/bounded-body.js';
import { authoredMessage, errorCode, errorResponse } from '../http/error-response.js';
import { createContentDocument } from '../cms/content-create.js';
import { SQL_NOT_SOFT_DELETED } from '../public-reads.js';
import { CONSENT_WORDING_V1, ConsentError, attributeConsent, validateConsent } from './consent.js';
import { checkInterviewFields, interviewStorage } from './sibling-modules.js';
import { INTERVIEW_ID_PATTERN } from './tombstone.js';
import { ownsAudioPath } from './upload.js';
import { recordingInUse } from './enqueue.js';

/** A create body is a form's worth of text; a transcript never comes this way. */
const MAX_CREATE_BYTES = 64 * 1024;
/** Rows the list returns; the interviews are one person's work. */
export const MAX_LISTED_INTERVIEWS = 200;
/** Content ids are UUIDs; migrated ones are Firestore ids. Neither has anything else. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** The stage a new document starts in, before the form has chosen its input. */
export const INITIAL_STAGE = 'created';

/** The fields the form may set on create; everything else is the pipeline's. */
const CREATE_FIELDS = Object.freeze([
  'title',
  'subtitle',
  'date',
  'guest',
  'bio',
  'image',
  'tags',
]);

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const PRIVATE = { 'Cache-Control': 'private, no-store' };
const refused = (status, code, error) => json(status, { ok: false, code, error });

const isInterview = (doc) => String(doc?.type || '').toLowerCase() === 'interview';

const LIST_PROJECTION = [
  'c.id',
  'c.Title',
  'c.title',
  'c.slug',
  'c.subtitle',
  'c.date',
  'c.guest',
  'c.contentStatus',
  'c.Live',
  'c.interview',
  'c.transcription',
  'c.curatedSubpagePath',
  'c.updatedAt',
  'c["Created At"]',
  'c._etag',
].join(', ');

export const LIST_QUERY =
  `SELECT TOP ${MAX_LISTED_INTERVIEWS} ${LIST_PROJECTION} FROM c ` +
  `WHERE LOWER(c.type) = @type AND ${SQL_NOT_SOFT_DELETED}`;

/** One list row: what the admin list shows, nothing the form edits. */
export function toListRow(doc = {}) {
  return {
    id: doc.id,
    title: doc.Title || doc.title || '',
    slug: doc.slug || null,
    subtitle: doc.subtitle || '',
    date: doc.date || null,
    guest: doc.guest || null,
    contentStatus: doc.contentStatus || 'draft',
    live: doc.Live === true,
    stage: doc.interview?.stage || INITIAL_STAGE,
    stageError: doc.interview?.error || null,
    transcription: doc.transcription
      ? { version: doc.transcription.version ?? null, status: doc.transcription.status ?? null }
      : null,
    curatedSubpagePath: doc.curatedSubpagePath || null,
    updatedAt: doc.updatedAt || null,
    createdAt: doc['Created At'] || null,
    etag: doc._etag || null,
  };
}

/** Newest edit first; the same instant keeps a steady order by id. */
const byUpdatedDesc = (a, b) =>
  String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')) ||
  String(a.id).localeCompare(String(b.id));

/**
 * The `audits` row for a create: the consent date and the administrator's
 * oid, and nothing else (ADR 0040, D9). The shape is the status
 * transitioner's, so the audit list reads it like any other row.
 */
function createAuditRow(uuid, { user, request, contentId, consent, nowIso }) {
  return {
    id: uuid(),
    timestamp: nowIso,
    action: 'interview_created',
    resourceType: 'content',
    resourceId: contentId,
    resourceTitle: '',
    userId: user.oid || user.sub || null,
    userName: null,
    userEmail: null,
    changes: { before: null, after: { contentStatus: 'draft' }, changedFields: [], notes: '' },
    ipAddress: null,
    userAgent: request.headers?.get?.('user-agent') || null,
    metadata: { consentDate: consent.date, consentWording: consent.wording, authMethod: 'entra_bearer_token' },
    compliance: { dataClassification: 'internal', retentionMonths: 24, identityVerified: true },
  };
}

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
    log.warn?.(`[interviews] ${doc.id} names ${refused} recording path(s) it does not own; not deleted`);
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
  const names = new Set(ownedRecordingPaths(doc, log));
  if (scope === 'interview') {
    for (const prefix of [`audio/${doc.id}/`, `transcripts/${doc.id}/`]) {
      for (const name of await blobNamesUnder({ blobs }, container, prefix)) names.add(name);
    }
  }
  let deleted = 0;
  let failed = 0;
  let versionFailures = 0;
  for (const name of names) {
    try {
      const outcome = await deleteBlobWithVersions({ blobs, log }, container, name);
      deleted += 1;
      versionFailures += outcome.versionFailures;
    } catch (error) {
      failed += 1;
      log.warn?.(`[interviews] a blob of ${doc.id} was not deleted (${errorCode(error)})`);
    }
  }
  log.log?.(
    `[interviews] ${doc.id}: ${deleted} blob(s) deleted, ${failed} failed, ${versionFailures} version(s) kept`
  );
  return { deleted, failed, versionFailures };
}

/**
 * The transcript the document points at, read from the container, or null
 * when there is none yet or it cannot be read (the reason is logged by code).
 */
async function readTranscript({ blobs, log }, doc) {
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
    log.warn?.(`[interviews] transcript v${version} of ${doc.id} was not read (${errorCode(error)})`);
    return null;
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {{ downloadBlob: Function, deleteBlob: Function, getContainerClient: Function }} deps.blobs
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.log]
 */
export function createInterviewAdminHandlers({
  guard,
  store,
  blobs,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
}) {
  const idOf = (request) => {
    const id = String(request.params?.id || '').trim();
    return ID_PATTERN.test(id) ? id : null;
  };

  return {
    /** POST cms/interviews — editor; `{ title, subtitle, date, guest, bio, image, tags, consent }`. */
    async create(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const { user } = auth;
      try {
        const read = await readJsonBodyWithin(request, MAX_CREATE_BYTES);
        if (read.tooLarge) return refused(413, 'TOO_LARGE', 'The form is too large to be an interview.');
        const body = read.body || {};

        let consent;
        try {
          consent = validateConsent(body.consent, { now });
        } catch (error) {
          if (error instanceof ConsentError) {
            return refused(
              error.status,
              error.code,
              authoredMessage(error, 'The consent record was refused.')
            );
          }
          throw error;
        }

        const fields = {};
        for (const key of CREATE_FIELDS) if (body[key] !== undefined) fields[key] = body[key];
        const checked = await checkInterviewFields(fields);
        if (!checked.ok) return refused(400, 'INVALID_INTERVIEW', checked.error);
        const clean =
          checked.value && typeof checked.value === 'object' ? { ...fields, ...checked.value } : fields;

        const nowIso = now().toISOString();
        const title = String(clean.title || '').trim();
        const result = await createContentDocument({
          store,
          user,
          data: {
            type: 'interview',
            publishTarget: 'interview',
            cloudProvider: 'Azure',
            'Cloud Provider': 'Azure',
            Title: title,
            title,
            subtitle: clean.subtitle || '',
            date: clean.date || nowIso.slice(0, 10),
            guest: clean.guest || null,
            bio: clean.bio || '',
            image: clean.image || null,
            tags: Array.isArray(clean.tags) ? clean.tags : [],
            qa: [],
            related: { labs: [], learn: [] },
            consent: attributeConsent(consent, user, nowIso),
            provenance: { source: null },
            interview: { stage: INITIAL_STAGE },
            contentStatus: 'draft',
          },
          runEditorialCritique: false,
          interviewAllowed: true,
          now,
          uuid,
        });
        if (result.status !== 200) {
          // 409 duplicate title, 400 taxonomy: the pipeline's own answer, as is.
          return json(result.status, { ok: false, ...result.body });
        }
        const contentId = result.body.contentId;
        await store
          .upsertDoc('audits', createAuditRow(uuid, { user, request, contentId, consent, nowIso }))
          .catch((error) =>
            context.warn?.(`[interviews] the create audit row was not written (${errorCode(error)})`)
          );
        const stored = await store.readDoc('content', contentId, contentId);
        context.log?.(`[interviews] created ${contentId}`);
        return json(200, { ok: true, id: contentId, etag: stored?._etag || null }, PRIVATE);
      } catch (error) {
        return errorResponse(context, 'Failed to create the interview', error, 500, request);
      }
    },

    /** GET cms/interviews — editor; every interview, newest edit first. */
    async list(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const rows = await store.queryDocs('content', LIST_QUERY, [{ name: '@type', value: 'interview' }]);
        const interviews = (Array.isArray(rows) ? rows : []).map(toListRow).sort(byUpdatedDesc);
        return json(200, { ok: true, interviews, limit: MAX_LISTED_INTERVIEWS }, PRIVATE);
      } catch (error) {
        return errorResponse(context, 'Failed to list the interviews', error, 500, request);
      }
    },

    /** GET cms/interviews/{id} — editor; the document and its transcript. */
    async get(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const id = idOf(request);
        if (!id) return refused(400, 'INVALID_ID', 'The interview id is not valid.');
        const doc = await store.readDoc('content', id, id);
        if (!doc || !isInterview(doc)) return refused(404, 'NOT_FOUND', 'No interview has that id.');
        const transcript = await readTranscript({ blobs, log: context }, doc);
        return json(
          200,
          { ok: true, interview: doc, etag: doc._etag || null, transcript, consentWording: CONSENT_WORDING_V1 },
          PRIVATE
        );
      } catch (error) {
        return errorResponse(context, 'Failed to read the interview', error, 500, request);
      }
    },

    /** DELETE cms/interviews/{id}/audio — publisher; the recording goes, the transcripts stay. */
    async deleteAudio(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      try {
        const id = idOf(request);
        if (!id) return refused(400, 'INVALID_ID', 'The interview id is not valid.');
        const doc = await store.readDoc('content', id, id);
        if (!doc || !isInterview(doc)) return refused(404, 'NOT_FOUND', 'No interview has that id.');
        // A download or transcription reading the recording would fail mid-run.
        if (await recordingInUse(store, doc)) {
          return refused(
            409,
            'INTERVIEW_BUSY',
            'A step is still working on the recording; delete it once that step has finished.'
          );
        }
        const outcome = await deleteInterviewAssets({ blobs, log: context }, doc, { scope: 'recording' });
        if (outcome.failed > 0) {
          return refused(502, 'DELETE_FAILED', 'The recording could not be deleted; try again.');
        }
        const nowIso = now().toISOString();
        await store.patchDoc(
          'content',
          id,
          { provenance: { ...(doc.provenance || {}), audio: null }, updatedAt: nowIso },
          { ifMatch: doc._etag }
        );
        return json(200, { ok: true, id, deleted: outcome.deleted }, PRIVATE);
      } catch (error) {
        if (error?.code === 412) {
          return refused(409, 'CONFLICT', 'This interview changed since it was read; reload and try again.');
        }
        return errorResponse(context, 'Failed to delete the recording', error, 500, request);
      }
    },
  };
}
