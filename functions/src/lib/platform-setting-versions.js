/**
 * platform-setting-versions.js — how a platform setting save names the
 * version it replaces (#946): If-Match parsing and matching, the 412 and 428
 * answers, and the conditional write of a setting whose value is the
 * caller's alone. The merged write that uses the same rules stays in
 * platform-settings.js.
 */
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';

/**
 * A JSON response, with the stored document's ETag as an `ETag` header when
 * there is one (#946). The body carries the same value as `etag`, and that is
 * the copy the page reads: cors.js exposes the header, but App Service's own
 * CORS takes precedence over code where it handles a request, so what a
 * browser may read of the headers is not decided here alone.
 *
 * @param {number} status
 * @param {object} body
 * @param {string|null} [etag] Cosmos's `_etag`, already a quoted entity-tag
 */
export const json = (status, body, etag = null) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
  body: JSON.stringify(body),
});

/** How many times a merged save re-reads after a conflicting write before answering 409. */
export const MERGE_WRITE_ATTEMPTS = 3;

/** 412: replaced since the read. 409: created since a read that found nothing. */
export const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

/**
 * The entity-tags an If-Match header names (#946), or null when there is no
 * header. `*` alone comes back as `['*']`; inside a list it is not the
 * grammar (RFC 9110 §13.1.1: `"*" / #entity-tag`) and is dropped, so it can
 * never widen a list into a wildcard. Weak tags are dropped too: If-Match
 * uses the strong comparison, so `W/"…"` can never match, and a header naming
 * nothing else matches nothing.
 *
 * @param {string|null|undefined} header the raw If-Match value
 * @returns {string[]|null}
 */
export function parseIfMatch(header) {
  const raw = String(header ?? '').trim();
  if (!raw) return null;
  if (raw === '*') return ['*'];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && tag !== '*' && !tag.startsWith('W/'));
}

/**
 * Whether the If-Match tags name no particular version: the header was `*`,
 * which matches whatever is stored.
 *
 * @param {string[]} tags from parseIfMatch
 * @returns {boolean}
 */
const namesAnyVersion = (tags) => tags.includes('*');

/**
 * Whether the stored document is a version the If-Match tags name: any stored
 * document for `*`, else the one whose `_etag` is listed. When nothing is
 * stored, no If-Match is satisfied, `*` included.
 *
 * @param {string[]} tags from parseIfMatch
 * @param {object|null} stored the document as read, `_etag` included
 * @returns {boolean}
 */
export function satisfiesIfMatch(tags, stored) {
  if (!stored) return false;
  if (tags.includes('*')) return true;
  return Boolean(stored._etag) && tags.includes(stored._etag);
}

/** The 412 for a save naming a version that is no longer stored. Nothing was written. */
export const settingChanged = () =>
  json(412, {
    code: 'CONFLICT',
    error:
      'This setting was saved somewhere else since this page loaded it. Nothing was saved; reload it to see what is stored now.',
  });

/**
 * The 428 for a save that did not name the version it replaces: no If-Match
 * over a stored document, or `If-Match: *`. Nothing was written.
 */
const versionRequired = () =>
  json(428, {
    code: 'PRECONDITION_REQUIRED',
    error:
      'The save did not name the version of this setting it replaces, so nothing was saved. Reload the page and save again.',
  });

/**
 * Save a setting whose value is the caller's alone, conditioned on the
 * version the caller read (#946).
 *
 * With If-Match, the stored document must be a version it names, and the
 * replace is conditional on that document's ETag, so a save from a page
 * that loaded an older version is a 412 whether the other write landed
 * before this read or between this read and the replace.
 *
 * Without If-Match, the save may only create: the caller is saying nothing
 * was stored when it read. If a document exists by the time it writes, the
 * create's 409 becomes a 428, because the caller has not said which version
 * it would replace. `If-Match: *` is refused with the same 428 before
 * anything is read: it matches whatever is stored, so it names no version
 * either, and honouring it would be the unconditional overwrite under
 * another name (review of #946; the page never sends it). That is what
 * makes the precondition required: no request can overwrite a stored
 * setting without naming the version it read.
 *
 * @param {object} spec the setting's registry entry
 * @param {object} value the normalized value to store
 * @param {{ updatedAt: string, updatedBy: string|null }} meta
 * @param {string[]|null} tags the If-Match tags, or null for none
 * @returns {Promise<{ written: object|null } | { error: object }>} the
 *   document as written (its `_etag` the next save's If-Match), or the
 *   response refusing the save
 */
export async function writeConditional({ store }, spec, value, meta, tags) {
  if (tags && namesAnyVersion(tags)) return { error: versionRequired() };
  const doc = { id: spec.docId, configScope: ADMIN_CONFIG_PARTITION, ...value, ...meta };
  try {
    if (!tags) return { written: await store.createDoc('admin_config', doc) };
    const stored = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
    if (!satisfiesIfMatch(tags, stored)) return { error: settingChanged() };
    const written = await store.replaceDocIfMatch(
      'admin_config',
      { ...doc, _etag: stored._etag },
      { partitionKey: ADMIN_CONFIG_PARTITION }
    );
    return { written };
  } catch (error) {
    if (!isWriteConflict(error)) throw error;
    return { error: tags ? settingChanged() : versionRequired() };
  }
}

/**
 * One merged write: `{ written: true }`, `{}` after a conflict the caller
 * may retry, or `{ error }` with the 412 when the caller named a version.
 */
export async function tryWriteMerged(store, doc, stored, tags) {
  try {
    await replaceOrCreate(store, doc, stored);
    return { written: true };
  } catch (error) {
    if (!isWriteConflict(error)) throw error;
    return tags ? { error: settingChanged() } : {};
  }
}

/** Replace the stored document under the ETag it was read with, or create it when none was stored. */
function replaceOrCreate(store, doc, stored) {
  if (!stored) return store.createDoc('admin_config', doc);
  return store.replaceDocIfMatch(
    'admin_config',
    { ...doc, _etag: stored._etag },
    { partitionKey: ADMIN_CONFIG_PARTITION }
  );
}
