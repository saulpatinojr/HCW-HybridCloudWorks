/**
 * doc-vault/handlers.js — the routes behind /admin/doc-vault (owner request
 * 2026-10-26). What a document is: ./model.js. Reading an uploaded file:
 * ./markdown.js. This is the store and the HTTP shape.
 *
 *   GET    cms/doc-vault                                   the list (no text); ?view=trash, ?q=, ?category=, ?tag=
 *   POST   cms/doc-vault                                   a pasted document { fields }
 *   POST   cms/doc-vault/upload                            one text or markdown file { filename, text, defaultCategory? }
 *   GET    cms/doc-vault/{id}                              one document, with its text and its earlier versions
 *   PUT    cms/doc-vault/{id}                              edit { fields, etag } (a new version)
 *   DELETE cms/doc-vault/{id}                              to Trash { etag }; { etag, permanent: true } from Trash
 *   POST   cms/doc-vault/{id}/untrash                      out of Trash { etag }
 *   GET    cms/doc-vault/{id}/versions/{version}           one earlier version, with its text
 *   POST   cms/doc-vault/{id}/restore-version              make an earlier version the newest { version, etag }
 *
 * Every route is behind requireRole at publisher (model.js DOC_VAULT_ROLE says
 * why): reads and writes alike, since a private letter is as private to read
 * as to change.
 *
 * VERSIONS, NOT DUPLICATES. Adding a document whose category and title are
 * already in the vault (by paste, by upload, or by renaming an existing one on
 * the edit form) never makes a second copy. A paste or an upload becomes the
 * next version of the document that holds the key; a rename onto a key that is
 * taken is refused (409 DUPLICATE). The ten newest versions are kept, the
 * current one included. Restoring an earlier version writes it as a new newest
 * version, so history only ever grows forward and nothing is lost by restoring.
 *
 * DELETE IS A TRASH, THEN GONE. Deleting moves a document to Trash for 30 days
 * (it keeps its versions, and can be put back); after that it and its versions
 * are removed for good, the next time the list is loaded. "Delete forever" on a
 * document in Trash removes it at once. Both go through eraseDocument, which
 * marks the document `purging` under its etag before it removes anything, so a
 * put-back that races it either wins with the history intact or is refused, and
 * an interrupted delete is finished by the next one. Hard delete alone was the other choice;
 * the vault is the PRIMARY home of this writing, so one wrong click on a letter
 * must not be the end of it. A document in Trash is excluded from the default
 * list, and nothing but the Trash view ever returns one.
 *
 * TWO TABS CANNOT OVERWRITE EACH OTHER. Every write that changes an existing
 * document carries the `etag` of the version the page is showing, is refused
 * before any write when the stored version has moved on, and is written
 * conditioned on that etag, so a write landing in between becomes a 412
 * `code: 'CONFLICT'` rather than an overwrite. Because the old text is archived
 * first, even a lost race loses nothing.
 *
 * WHAT NEVER LEAVES A DOCUMENT. The text, the title, the tags and the link are
 * never logged, never put in an audit row and never put in an error or a
 * refusal. Audit rows carry the document id, the version, the category, the
 * source and the size, written after the work and best-effort, so a failed
 * audit write cannot turn a saved document into a 500 that invites a retry.
 * Opening a document or reading one of its versions writes such a row too
 * (doc_vault_read), so a stolen or shared token that reads the vault leaves a
 * trail of when and which, if never what. The list does not: it returns no text.
 * The document id is derived from a private salt (model.js), so an id in a row
 * confirms nothing about a title. Every answer says `Cache-Control: private,
 * no-store`.
 * An unexpected failure answers a fixed sentence and a correlation id
 * (error-response.js), and the log line holds the error's code, not its words.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { recordMutationAudit } from '../audit.js';
import { isNotProvisioned } from '../ambassador/steps.js';
import { readJsonBodyWithin } from '../http/bounded-body.js';
import { authoredMessage, errorResponse, isAuthoredError } from '../http/error-response.js';
import { MAX_FILE_BYTES, parseVaultFile } from './markdown.js';
import {
  CATEGORIES,
  CONTAINER,
  DOCUMENT_ID_PATTERN,
  DOC_TYPES,
  DOC_VAULT_ROLE,
  MAX_BODY_BYTES,
  MAX_TAG_CHARS,
  SOURCES,
  adminIdOf,
  canonicalCategory,
  fieldsOfVersion,
  readVersionNumber,
  toSummary,
  toVersionView,
  toView,
  validateFields,
  versionDocId,
} from './model.js';
import {
  ALREADY_CURRENT,
  BAD_ID,
  BAD_VERSION,
  DUPLICATE,
  ETAG_REQUIRED,
  IN_TRASH,
  NOT_IN_TRASH,
  NOT_PROVISIONED,
  PURGING,
  Refusal,
  TOO_LARGE,
  VERSION_NOT_FOUND,
  json,
  refuseIf,
  refused,
} from './refusals.js';
import {
  LIST_ACTIVE_QUERY,
  LIST_TRASH_QUERY,
  MAX_LISTED_DOCUMENTS,
  conflict,
  eraseDocument,
  findByKey,
  listVersions,
  patchUnderEtag,
  purgeExpiredTrash,
  readDocument,
  readStored,
  withinWindow,
} from './vault-store.js';
import { addVersion, refuseIfKeyTaken, saveDocument } from './vault-save.js';

export {
  EXPIRED_TRASH_QUERY,
  FIND_BY_KEY_QUERY,
  LIST_ACTIVE_QUERY,
  LIST_TRASH_QUERY,
  MAX_LISTED_DOCUMENTS,
  PURGE_BATCH,
  VERSIONS_QUERY,
  VERSION_IDS_QUERY,
} from './vault-store.js';

export const MAX_SEARCH_CHARS = 200;
export const MAX_TAG_FILTERS = 50;
/** The whole create or edit request, as JSON: quotes and newlines in the text can double in size once escaped. */
export const MAX_REQUEST_BYTES = MAX_BODY_BYTES * 2 + 32 * 1024;
/** The whole upload request: the file and its front matter, escaped, and the file name. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_FILE_BYTES * 2 + 4 * 1024;

/** What an error becomes: a refusal's own answer, the not-provisioned notice, a corrected input, or a fixed 500. */
function answerFor(error, context, what, request) {
  if (error instanceof Refusal) return error.response;
  if (isNotProvisioned(error)) return refused(NOT_PROVISIONED);
  if (isAuthoredError(error)) {
    return refused({
      status: 400,
      code: 'INVALID',
      error: authoredMessage(error, `Could not ${what}.`),
    });
  }
  return errorResponse(context, `Failed to ${what}`, error, 500, request);
}

// ── the store ──────────────────────────────────────────────────────────────

const readId = (request) => {
  const id = String(request.params?.id || '');
  refuseIf(!DOCUMENT_ID_PATTERN.test(id) && BAD_ID);
  return id;
};

/** The JSON body within `maxBytes`, or the 413. */
async function readBody(request, maxBytes) {
  const read = await readJsonBodyWithin(request, maxBytes);
  refuseIf(read.tooLarge && TOO_LARGE);
  return read.body;
}

const readEtag = (body) => {
  const { etag } = body;
  const valid = typeof etag === 'string' && etag.length > 0 && etag.length <= 200;
  refuseIf(!valid && ETAG_REQUIRED);
  return etag;
};

/** The shared front half of every write to an existing document. */
async function loadForWrite(deps, request, maxBytes = MAX_REQUEST_BYTES) {
  const id = readId(request);
  const body = await readBody(request, maxBytes);
  const etag = readEtag(body);
  const current = await readDocument(deps, id);
  if (current._etag !== etag) await conflict(deps, id);
  return { id, body, etag, current };
}

// ── audit ──────────────────────────────────────────────────────────────────

/** One row per action, from ids and counts only: never a title, tag, link or text. */
const audit = (deps, action, { user, context, doc, extra = {} }) =>
  recordMutationAudit(deps.store, {
    action,
    actor: { oid: user.oid, sub: user.sub },
    resource: `${CONTAINER}:${doc.id}`,
    details: {
      documentId: doc.id,
      version: doc.version ?? null,
      category: doc.category ?? null,
      source: doc.source ?? null,
      bytes: doc.bodyBytes ?? null,
      ...extra,
    },
    now: deps.now,
    uuid: deps.uuid,
    context,
  });

// ── the routes ─────────────────────────────────────────────────────────────

const route = (deps, what, work) => async (request, context) => {
  const auth = await deps.guard.requireRole(request, DOC_VAULT_ROLE);
  if (auth.error) return auth.error;
  try {
    return await work(deps, { request, context, user: auth.user });
  } catch (error) {
    return answerFor(error, context, what, request);
  }
};

/**
 * Read the list filters from the query string, or refuse the ones that cannot
 * be right. The page does not send `q` or `tag` (it filters the list it has,
 * in the browser): words in a URL are recorded by request telemetry, so a
 * client that wants a title kept out of it should do the same. They are here
 * for a tool that reads the vault (the Obsidian export) and does not mind.
 */
function readFilters(request) {
  const get = (name) => String(request.query?.get?.(name) ?? '').trim();
  const view = get('view') || 'active';
  refuseIf(!['active', 'trash'].includes(view) && {
    status: 400,
    code: 'INVALID',
    error: 'view must be "active" or "trash".',
  });
  const category = get('category');
  const canonical = category ? canonicalCategory(category) : null;
  refuseIf(category && !canonical && {
    status: 400,
    code: 'INVALID',
    error: `category must be one of: ${CATEGORIES.join(', ')}.`,
  });
  const q = get('q');
  const tag = get('tag');
  refuseIf((q.length > MAX_SEARCH_CHARS || tag.length > MAX_TAG_CHARS) && {
    status: 400,
    code: 'INVALID',
    error: 'That search is too long.',
  });
  return { view, category: canonical, q: q.toLowerCase(), tag: tag.toLowerCase() };
}

const matchesSearch = (row, { category, q, tag }) => {
  if (category && row.category !== category) return false;
  if (tag && !row.tags.some((t) => t.toLowerCase() === tag)) return false;
  if (!q) return true;
  return [row.title, row.category, ...row.tags].some((text) => text.toLowerCase().includes(q));
};

const countBy = (rows, pick) => {
  const counts = new Map();
  for (const row of rows) for (const key of pick(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/** GET cms/doc-vault */
async function listDocuments(deps, { request }) {
  const filters = readFilters(request);
  await purgeExpiredTrash(deps);
  const rows = await deps.store.queryDocs(
    CONTAINER,
    filters.view === 'trash' ? LIST_TRASH_QUERY : LIST_ACTIVE_QUERY,
    [{ name: '@docType', value: DOC_TYPES.document }]
  );
  const truncated = rows.length > MAX_LISTED_DOCUMENTS;
  const all = rows
    .slice(0, MAX_LISTED_DOCUMENTS)
    .map(toSummary)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const documents = all.filter((row) => matchesSearch(row, filters));
  const categoryCounts = countBy(all, (row) => [row.category]);
  const tagCounts = countBy(all, (row) => row.tags.map((t) => t.toLowerCase()));
  return json(200, {
    ok: true,
    view: filters.view,
    documents,
    total: all.length,
    matching: documents.length,
    truncated,
    limit: MAX_LISTED_DOCUMENTS,
    counts: Object.fromEntries(CATEGORIES.map((c) => [c, categoryCounts.get(c) ?? 0])),
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAG_FILTERS)
      .map(([tag, count]) => ({ tag, count })),
  });
}

/** The status and shape a save answers with. */
function savedAnswer({ outcome, doc }, extra = {}) {
  return json(outcome === 'created' ? 201 : 200, {
    ok: true,
    outcome,
    document: toView(doc),
    ...extra,
  });
}

const AUDIT_FOR_OUTCOME = {
  created: 'doc_vault_created',
  versioned: 'doc_vault_versioned',
  restored: 'doc_vault_untrashed',
};

/** POST cms/doc-vault — { fields } */
async function createDocument(deps, { request, context, user }) {
  const body = await readBody(request, MAX_REQUEST_BYTES);
  const fields = validateFields(body.fields);
  const saved = await saveDocument(deps, {
    fields,
    source: SOURCES.pasted,
    adminId: adminIdOf(user),
  });
  const action = AUDIT_FOR_OUTCOME[saved.outcome];
  if (action) await audit(deps, action, { user, context, doc: saved.doc, extra: { via: 'paste' } });
  return savedAnswer(saved);
}

/**
 * POST cms/doc-vault/upload — { filename, text, defaultCategory? }. One file
 * per request: the page sends a batch one at a time, so a file that fails
 * costs only itself. 201 created; 200 versioned (the title was already here),
 * unchanged (the very same text) or restored (it was in Trash); 400 for a
 * request or a file name the owner can correct; 413 too large; 422 for a file
 * that is not a document.
 */
async function uploadDocument(deps, { request, context, user }) {
  const body = await readBody(request, MAX_UPLOAD_REQUEST_BYTES);
  const parsed = parseVaultFile({
    filename: body.filename,
    text: body.text,
    defaultCategory: body.defaultCategory,
  });
  refuseIf(!parsed.ok && { status: parsed.status, code: parsed.code, error: parsed.error });
  const saved = await saveDocument(deps, {
    fields: parsed.fields,
    source: SOURCES.uploaded,
    adminId: adminIdOf(user),
  });
  const action = AUDIT_FOR_OUTCOME[saved.outcome];
  if (action) await audit(deps, action, { user, context, doc: saved.doc, extra: { via: 'upload' } });
  const { body: _body, ...summary } = toView(saved.doc);
  return json(saved.outcome === 'created' ? 201 : 200, {
    ok: true,
    outcome: saved.outcome,
    document: summary,
    warnings: parsed.warnings,
  });
}

/** GET cms/doc-vault/{id} */
async function getDocument(deps, { request, context, user }) {
  const doc = await readDocument(deps, readId(request));
  const answer = json(200, {
    ok: true,
    document: toView(doc),
    versions: await listVersions(deps, doc),
  });
  // A read of a private document is recorded: who and when, never what.
  await audit(deps, 'doc_vault_read', { user, context, doc });
  return answer;
}

/** PUT cms/doc-vault/{id} — { fields, etag } */
async function updateDocument(deps, { request, context, user }) {
  const { id, body, current } = await loadForWrite(deps, request);
  refuseIf(current.deletedAt && IN_TRASH);
  const fields = validateFields(body.fields);
  await refuseIfKeyTaken(deps, fields, current);
  const saved = await addVersion(deps, {
    current,
    fields,
    source: SOURCES.pasted,
    adminId: adminIdOf(user),
  });
  if (saved.outcome === 'versioned') {
    await audit(deps, 'doc_vault_updated', { user, context, doc: saved.doc });
  }
  return savedAnswer(saved, { id });
}

/** GET cms/doc-vault/{id}/versions/{version} */
async function getVersion(deps, { request, context, user }) {
  const id = readId(request);
  const number = readVersionNumber(request.params?.version);
  refuseIf(number === null && BAD_VERSION);
  const current = await readDocument(deps, id);
  const read = (view, isCurrent) =>
    audit(deps, 'doc_vault_read', {
      user,
      context,
      doc: current,
      extra: { readVersion: view.version },
    }).then(() => json(200, { ok: true, version: { ...view, current: isCurrent } }));
  if (number === current.version) {
    return read(toVersionView({ ...current, savedAt: current.updatedAt }), true);
  }
  refuseIf(!withinWindow(current, number) && VERSION_NOT_FOUND);
  const archived = await readStored(deps, versionDocId(id, number), DOC_TYPES.version);
  refuseIf(!(archived && archived.documentId === id) && VERSION_NOT_FOUND);
  return read(toVersionView(archived), false);
}

/** POST cms/doc-vault/{id}/restore-version — { version, etag } */
async function restoreVersion(deps, { request, context, user }) {
  const { id, body, current } = await loadForWrite(deps, request);
  refuseIf(current.deletedAt && IN_TRASH);
  const number = readVersionNumber(String(body.version ?? ''));
  refuseIf(number === null && BAD_VERSION);
  refuseIf(number === current.version && ALREADY_CURRENT);
  refuseIf(!withinWindow(current, number) && VERSION_NOT_FOUND);
  const archived = await readStored(deps, versionDocId(id, number), DOC_TYPES.version);
  refuseIf(!(archived && archived.documentId === id) && VERSION_NOT_FOUND);
  const fields = validateFields(fieldsOfVersion(archived));
  await refuseIfKeyTaken(deps, fields, current);
  const saved = await addVersion(deps, {
    current,
    fields,
    source: archived.source === SOURCES.uploaded ? SOURCES.uploaded : SOURCES.pasted,
    adminId: adminIdOf(user),
    restoredFromVersion: number,
  });
  if (saved.outcome === 'versioned') {
    await audit(deps, 'doc_vault_version_restored', {
      user,
      context,
      doc: saved.doc,
      extra: { restoredFromVersion: number },
    });
  }
  return savedAnswer(saved, { id });
}

/**
 * DELETE cms/doc-vault/{id} — { etag }: to Trash. { etag, permanent: true }:
 * from Trash, at once.
 */
async function removeDocument(deps, { request, context, user }) {
  const { id, body, etag, current } = await loadForWrite(deps, request);
  if (body.permanent === true) {
    refuseIf(!current.deletedAt && NOT_IN_TRASH);
    await eraseDocument(deps, current);
    await audit(deps, 'doc_vault_deleted_forever', { user, context, doc: current });
    return json(200, { ok: true, deleted: id, permanent: true });
  }
  if (current.deletedAt) {
    return json(200, { ok: true, outcome: 'already_in_trash', document: toSummary(current) });
  }
  const written = await patchUnderEtag(
    deps,
    id,
    { deletedAt: deps.now().toISOString(), deletedBy: adminIdOf(user) },
    etag
  );
  await audit(deps, 'doc_vault_trashed', { user, context, doc: current });
  return json(200, { ok: true, outcome: 'trashed', document: toSummary(written) });
}

/** POST cms/doc-vault/{id}/untrash — { etag } */
async function untrashDocument(deps, { request, context, user }) {
  const { id, etag, current } = await loadForWrite(deps, request);
  refuseIf(!current.deletedAt && NOT_IN_TRASH);
  refuseIf(current.purging && PURGING);
  const key = current.dedupeKey;
  refuseIf(key && (await findByKey(deps, key, id)) && DUPLICATE);
  const written = await patchUnderEtag(deps, id, { deletedAt: null, deletedBy: null }, etag);
  await audit(deps, 'doc_vault_untrashed', { user, context, doc: current, extra: { via: 'trash' } });
  return json(200, { ok: true, outcome: 'restored', document: toView(written) });
}

/** Handler name → what a failure says it was doing, the work. */
const ROUTES = Object.freeze({
  list: ['list documents', listDocuments],
  create: ['save the document', createDocument],
  upload: ['save the uploaded file', uploadDocument],
  get: ['read the document', getDocument],
  update: ['save the document', updateDocument],
  remove: ['delete the document', removeDocument],
  untrash: ['put the document back', untrashDocument],
  getVersion: ['read the version', getVersion],
  restoreVersion: ['restore the version', restoreVersion],
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, createDoc: Function, upsertDoc: Function,
 *   replaceDocIfMatch: Function, patchDoc: Function, deleteDoc: Function,
 *   deleteDocIfMatch: Function }} deps.store
 *   `createDoc` is create-only (409 when the id exists); `upsertDoc` writes the archived versions and the audit rows.
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => string} [deps.newSalt] a fresh secret for the id salt, the first time one is needed
 * @returns {Record<keyof typeof ROUTES, (request: object, context: object) => Promise<object>>}
 */
export function createDocVaultHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  newSalt = () => randomBytes(32).toString('hex'),
}) {
  const deps = { guard, store, now, uuid, newSalt };
  return Object.fromEntries(
    Object.entries(ROUTES).map(([name, [what, work]]) => [name, route(deps, what, work)])
  );
}
