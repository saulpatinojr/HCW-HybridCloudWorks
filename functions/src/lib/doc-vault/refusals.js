/**
 * doc-vault/refusals.js — the answers the Doc Vault's routes give
 * (doc-vault/handlers.js): the private JSON answer, every refusal by name,
 * and the Refusal a handler throws to answer with one. Nothing here repeats
 * what a request sent: each sentence names a rule, never a title or text.
 */
import { KEPT_VERSIONS, MAX_BODY_BYTES } from './model.js';

// ── answers ────────────────────────────────────────────────────────────────

// Private, never stored by a browser cache or anything between: the body can be a letter.
export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

export const refused = ({ status, code, error }, extra = {}) =>
  json(status, { ok: false, code, error, ...extra });

export const TOO_LARGE = {
  status: 413,
  code: 'TOO_LARGE',
  error: `That is too large to be a document (the text can be at most ${MAX_BODY_BYTES / 1024} KB). Nothing was saved.`,
};
export const NOT_FOUND = { status: 404, code: 'NOT_FOUND', error: 'No such document.' };
export const VERSION_NOT_FOUND = {
  status: 404,
  code: 'VERSION_NOT_FOUND',
  error: `No such version. Only the newest ${KEPT_VERSIONS} versions of a document are kept.`,
};
export const BAD_ID = { status: 400, code: 'BAD_ID', error: 'A document id is required.' };
export const BAD_VERSION = {
  status: 400,
  code: 'BAD_VERSION',
  error: 'version must be a whole number from 1.',
};
export const ETAG_REQUIRED = {
  status: 400,
  code: 'ETAG_REQUIRED',
  error:
    'etag is required: send the etag of the version you are looking at (reload the document).',
};
export const IN_TRASH = {
  status: 409,
  code: 'IN_TRASH',
  error: 'This document is in Trash. Put it back first, then change it.',
};
export const NOT_IN_TRASH = {
  status: 409,
  code: 'NOT_IN_TRASH',
  error: 'This document is not in Trash. Move it to Trash first.',
};
export const PURGING = {
  status: 409,
  code: 'PURGING',
  error:
    'This document is being deleted for good and cannot be put back or changed. Open Trash and choose Delete forever to finish it.',
};
export const ALREADY_CURRENT = {
  status: 409,
  code: 'ALREADY_CURRENT',
  error: 'That is already the newest version.',
};
export const DUPLICATE = {
  status: 409,
  code: 'DUPLICATE',
  error:
    'Another document in the vault, or in its Trash, already has that title in that category. Choose a different title or category.',
};
export const NOT_PROVISIONED = {
  status: 503,
  code: 'NOT_PROVISIONED',
  error:
    'The Doc Vault has no storage yet: the doc_vault container has not been created. See docs/runbooks/doc-vault.md.',
};
export const CONFLICT_MESSAGE =
  'This document changed in another tab or on another device since you opened it. Nothing was saved; reload it to see the latest version.';

/** Thrown inside a handler to answer with a refusal; the route wrapper turns it into the response. */
export class Refusal extends Error {
  constructor(refusal, extra = {}) {
    super(refusal.code);
    this.response = refused(refusal, extra);
    this.refusalCode = refusal.code;
  }
}

export const refuseIf = (refusal, extra) => {
  if (refusal) throw new Refusal(refusal, extra);
};

export const isPreconditionFailure = (error) => error?.code === 412 || error?.code === 404;
