/**
 * admin-responses.js — the answers and log fragments every newsletter admin
 * route shares (ADR 0030 §2a; split out of admin-handlers.js for PR #841 so
 * issue-actions.js can give the same answers).
 *
 * Nothing here reads a store or Resend. The responses are fixed sentences;
 * the describers decide what a Resend refusal or a thrown error may say in a
 * LOG LINE and to the OWNER: its status and its machine code, held to the
 * door's code shape. Resend's own sentence can echo the broadcast, so it is
 * in neither (#945).
 */
import { codeShaped } from '../http/error-response.js';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const notFound = () => json(404, { ok: false, error: 'Issue not found' });

/**
 * The caller's view of the issue is stale: it read a version that is no
 * longer stored. Checked BEFORE writing, against the `etag` the caller got
 * from GET, because the server's own read is fresh by definition; comparing
 * only that would let an editor working from an old view overwrite another
 * editor's change without either of them knowing. The etag is REQUIRED on
 * every write: an optional one protects only the callers that remember it.
 */
export const staleView = (body, issue) => body.etag !== issue._etag;

/** A write without the version it was made against cannot be checked, so it is refused. */
export const missingEtag = (body) => typeof body?.etag !== 'string' || body.etag.length === 0;

export const etagRequired = () =>
  json(400, {
    ok: false,
    code: 'ETAG_REQUIRED',
    error: 'etag is required: send the issue.etag from the last read of this issue.',
  });

export const changedElsewhere = () =>
  json(409, {
    ok: false,
    code: 'ISSUE_CHANGED',
    error: 'This issue changed since you opened it. Reload it and try again.',
  });

export const resendNotConfigured = () =>
  json(503, {
    ok: false,
    error: 'Resend is not configured: RESEND_API_KEY is not set',
  });

/** Log lines carry this, never the issue or broadcast id (content-free telemetry). */
export const invocationRef = (context) => `[invocation ${context?.invocationId ?? 'unknown'}]`;

/**
 * An error for a LOG LINE: its name and code only. SDK messages can carry
 * request details such as the document id, so they are never logged.
 */
export const errorMeta = (error) => {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const code =
    typeof error?.code === 'string' || typeof error?.code === 'number' ? ` code ${error.code}` : '';
  return `${name}${code}`;
};

/**
 * Resend's refusal for a LOG LINE: status and error name only, never its
 * message. The name is held to the door's code shape, so a value that is not
 * a machine code is left out (#945).
 *
 * @param {{ status?: number, data?: { name?: unknown } }} result - a resend-client answer
 * @returns {string}
 */
export const describeForLog = (result) => {
  const code = codeShaped(result?.data?.name);
  return `HTTP ${result?.status ?? 0}${code ? ` ${code}` : ''}`;
};

/**
 * Resend's refusal for the OWNER: the status and Resend's error name (a
 * machine code such as `validation_error`). Resend's own sentence used to
 * follow it; it can echo the broadcast (subject, body, postal address) and
 * is a provider's words, so it no longer reaches the issue or the page
 * (#945). Stored on the issue and returned to the page.
 *
 * @param {{ status?: number, data?: { name?: string } }} result - a resend-client answer
 * @returns {string}
 */
export const describeForOwner = (result) => describeForLog(result);
