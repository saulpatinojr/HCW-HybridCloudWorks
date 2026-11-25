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
import { checkInterviewFields } from './sibling-modules.js';
import { deleteInterviewAssets, readTranscript } from './interview-assets.js';
import { recordingInUse } from './enqueue.js';

export { deleteBlobWithVersions, deleteInterviewAssets, ownedRecordingPaths } from './interview-assets.js';

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

const idOf = (request) => {
  const id = String(request.params?.id || '').trim();
  return ID_PATTERN.test(id) ? id : null;
};

/** One route: the role check, then the work. */
const withRole = (deps, role, work) => async (request, context) => {
  const auth = await deps.guard.requireRole(request, role);
  if (auth.error) return auth.error;
  return work(deps, { request, context, user: auth.user });
};

/** The create form's fields, checked: `{ clean }`, or `{ refusal }` with the 400. */
async function createFields(body) {
  const fields = {};
  for (const key of CREATE_FIELDS) if (body[key] !== undefined) fields[key] = body[key];
  const checked = await checkInterviewFields(fields);
  if (!checked.ok) return { refusal: refused(400, 'INVALID_INTERVIEW', checked.error) };
  return { clean: checked.value && typeof checked.value === 'object' ? { ...fields, ...checked.value } : fields };
}

/** The new interview document's data, from the checked fields and the attributed consent. */
function interviewData(clean, consent, user, nowIso) {
  const title = String(clean.title || '').trim();
  return {
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
  };
}

/** Create the document through the content pipeline, write the audit row, and answer with its id and ETag. */
async function storeInterview({ store, now, uuid }, { request, context, user }, clean, consent) {
  const nowIso = now().toISOString();
  const result = await createContentDocument({
    store,
    user,
    data: interviewData(clean, consent, user, nowIso),
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
  context.log?.('[interviews] created an interview');
  return json(200, { ok: true, id: contentId, etag: stored?._etag || null }, PRIVATE);
}

/** POST cms/interviews — editor; `{ title, subtitle, date, guest, bio, image, tags, consent }`. */
async function create(deps, { request, context, user }) {
  try {
    const read = await readJsonBodyWithin(request, MAX_CREATE_BYTES);
    if (read.tooLarge) return refused(413, 'TOO_LARGE', 'The form is too large to be an interview.');
    const body = read.body || {};

    let consent;
    try {
      consent = validateConsent(body.consent, { now: deps.now });
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

    const fields = await createFields(body);
    return fields.refusal ?? (await storeInterview(deps, { request, context, user }, fields.clean, consent));
  } catch (error) {
    return errorResponse(context, 'Failed to create the interview', error, 500, request);
  }
}

/** GET cms/interviews — editor; every interview, newest edit first. */
async function list({ store }, { request, context }) {
  try {
    const rows = await store.queryDocs('content', LIST_QUERY, [{ name: '@type', value: 'interview' }]);
    const interviews = (Array.isArray(rows) ? rows : []).map(toListRow).sort(byUpdatedDesc);
    return json(200, { ok: true, interviews, limit: MAX_LISTED_INTERVIEWS }, PRIVATE);
  } catch (error) {
    return errorResponse(context, 'Failed to list the interviews', error, 500, request);
  }
}

/** The interview the route names: `{ id, doc }`, or `{ refusal }` for a bad id (400) or none (404). */
async function interviewOf({ store }, request) {
  const id = idOf(request);
  if (!id) return { refusal: refused(400, 'INVALID_ID', 'The interview id is not valid.') };
  const doc = await store.readDoc('content', id, id);
  if (!doc || !isInterview(doc)) return { refusal: refused(404, 'NOT_FOUND', 'No interview has that id.') };
  return { id, doc };
}

/** GET cms/interviews/{id} — editor; the document and its transcript. */
async function get(deps, { request, context }) {
  try {
    const found = await interviewOf(deps, request);
    if (found.refusal) return found.refusal;
    const { doc } = found;
    const transcript = await readTranscript({ blobs: deps.blobs, log: context }, doc);
    return json(
      200,
      { ok: true, interview: doc, etag: doc._etag || null, transcript, consentWording: CONSENT_WORDING_V1 },
      PRIVATE
    );
  } catch (error) {
    return errorResponse(context, 'Failed to read the interview', error, 500, request);
  }
}

/**
 * Delete the recording's blobs, unless a step is still working on it:
 * `{ outcome }`, or `{ refusal }` (409 busy, 502 when a blob could not go).
 */
async function deleteRecording({ store, blobs, now }, doc, context) {
  // A download or transcription reading the recording would fail mid-run.
  // Checked before the deletes, not held through them: a transcribe
  // queued in the seconds the deletes take loses its run, and the
  // document patch below then answers 409 CONFLICT on the moved ETag.
  if (await recordingInUse(store, doc, now())) {
    return {
      refusal: refused(
        409,
        'INTERVIEW_BUSY',
        'A step is still working on the recording; delete it once that step has finished.'
      ),
    };
  }
  const outcome = await deleteInterviewAssets({ blobs, log: context }, doc, { scope: 'recording' });
  if (outcome.failed > 0) {
    return { refusal: refused(502, 'DELETE_FAILED', 'The recording could not be deleted; try again.') };
  }
  return { outcome };
}

/** DELETE cms/interviews/{id}/audio — publisher; the recording goes, the transcripts stay. */
async function deleteAudio(deps, { request, context }) {
  try {
    const found = await interviewOf(deps, request);
    const deleted = found.refusal ? found : await deleteRecording(deps, found.doc, context);
    if (deleted.refusal) return deleted.refusal;
    const { id, doc } = found;
    const nowIso = deps.now().toISOString();
    await deps.store.patchDoc(
      'content',
      id,
      { provenance: { ...(doc.provenance || {}), audio: null }, updatedAt: nowIso },
      { ifMatch: doc._etag }
    );
    return json(200, { ok: true, id, deleted: deleted.outcome.deleted }, PRIVATE);
  } catch (error) {
    if (error?.code === 412) {
      return refused(409, 'CONFLICT', 'This interview changed since it was read; reload and try again.');
    }
    return errorResponse(context, 'Failed to delete the recording', error, 500, request);
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
  const deps = { guard, store, blobs, now, uuid, log };
  return {
    create: withRole(deps, 'editor', create),
    list: withRole(deps, 'editor', list),
    get: withRole(deps, 'editor', get),
    deleteAudio: withRole(deps, 'publisher', deleteAudio),
  };
}
