/**
 * podbean-error.js — the one error the Podbean client (podbean.js) raises,
 * and the small pieces its sentences are built from: the status with the
 * OAuth code, a transport failure's code, and how a status is classed.
 * podbean.js says what each code means to a caller, and exports
 * PodbeanError again.
 */
import { AuthoredError, codeShaped, errorCode } from '../http/error-response.js';

/**
 * One error type for everything the client raises, so a caller can record it
 * on a document without inspecting the cause.
 *
 * The message is this module's sentence (#945): the operation, the HTTP
 * status and the OAuth `error` code, or the socket's code, and never the
 * API's description, an error body or a socket's text. It is an
 * AuthoredError, so the transcript's host record and the hub store and
 * show it as written; what the API said stays on `detail`, in memory.
 *
 * `status` is the upstream HTTP status, or `null` when no response was had
 * (timeout, DNS, not configured). `detail` is what the API said, flattened
 * from `{ error, error_description }` to one line and scrubbed of the token
 * and the secret. `code` is ours:
 *
 *   NOT_CONFIGURED        a setting is missing; nothing was sent
 *   CREDENTIALS_REJECTED  the token endpoint refused the client id/secret
 *                         (invalid_client, invalid_grant, unauthorized_client,
 *                         or a 401/403 there), or a resource call answered
 *                         401/403 for a reason other than the token — the
 *                         app's permissions, checked in the developer portal
 *   TOKEN_REJECTED        `invalid_token` on a resource call, twice (see above)
 *   STORAGE_LIMIT         `storage_limit_reach`: the plan's monthly upload
 *                         allowance is spent; not retryable until it resets
 *   VALIDATION            any other 400, or a refusal before the network
 *   NOT_FOUND             404
 *   UPSTREAM              anything else; retryable for 408, 429 and 5xx
 *   TIMEOUT, NETWORK      no response from api.podbean.com; retryable
 *   UPLOAD_REJECTED       401/403 from the presigned URL's host — an expired
 *                         URL, never the token; retryable (a re-run mints one)
 *   UPLOAD_FAILED         any other status from that host
 *   UPLOAD_UNREACHABLE    no response from that host; the message names it
 *
 * `retryable` is true when repeating the same call later could succeed
 * without a change on our side.
 */
export class PodbeanError extends AuthoredError {
  /**
   * @param {string} message - the sentence, written in this module
   * @param {{ status?: number|null, code?: string, detail?: string|null, retryable?: boolean }} [options]
   */
  constructor(
    message,
    { status = null, code = 'UPSTREAM', detail = null, retryable = false } = {}
  ) {
    super(message, { code, status });
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/**
 * `400 invalid_grant`, or `503` when the answer carried no code: the parts
 * of a failed answer a stored sentence may name. The description stays out.
 *
 * @param {number} status - the HTTP status
 * @param {unknown} data - the parsed body, or null
 * @returns {string}
 */
export function statusAndCode(status, data) {
  const code = codeShaped(data?.error);
  return code ? `${status} ${code}` : String(status);
}

/**
 * The code a transport failure is known by: its own (`ENOTFOUND`), its
 * cause's (undici's `fetch failed` keeps the socket code there), or its
 * class name. Never its message, which can quote the URL it was given.
 *
 * @param {unknown} error - what fetch threw
 * @returns {string}
 */
export function transportCode(error) {
  for (const candidate of [error?.code, error?.cause?.code]) {
    if (typeof candidate === 'string' && codeShaped(candidate)) return candidate.trim();
  }
  return errorCode(error);
}

/**
 * ` (server_error)` when the answer carried an OAuth `error` code, else
 * nothing: the note a stored sentence may append to a status.
 *
 * @param {unknown} data - the parsed body, or null
 * @returns {string}
 */
export function codeNote(data) {
  const code = codeShaped(data?.error);
  return code ? ` (${code})` : '';
}

/**
 * The code and retryability of an HTTP failure that no more specific rule
 * claimed: 400 is VALIDATION, 404 NOT_FOUND, 408/429/5xx a retryable
 * UPSTREAM, anything else a final UPSTREAM.
 *
 * @param {number} status
 * @returns {{ code: string, retryable: boolean }}
 */
export function classify(status) {
  if (status === 400) return { code: 'VALIDATION', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 408 || status === 429 || status >= 500) {
    return { code: 'UPSTREAM', retryable: true };
  }
  return { code: 'UPSTREAM', retryable: false };
}
