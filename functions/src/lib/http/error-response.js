/**
 * error-response.js — the one door between an error and an HTTP response body
 * (AP-B10, #945).
 *
 * Two kinds of text can describe a failure. Text the code wrote for the
 * person reading the answer ("title is required", "This draft changed in
 * another tab") may be shown. Text that came from somewhere else — a Cosmos
 * exception, a provider's error body, a socket error — may not: it can carry
 * ids, paths, a vendor's name or a fragment of what was sent, and before this
 * module it reached any signed-in admin, viewer and up.
 *
 * The difference is made explicit with a type. An `AuthoredError` (or a
 * subclass) is the code's own sentence; `authoredMessage` returns it, and
 * returns the caller's safe sentence for anything else. `errorResponse`
 * always answers with the safe sentence. Both attach a correlation id, and
 * the server log keeps that id and the error's code — never its message,
 * because telemetry here is content-free.
 *
 * `functions/src/lib/http/no-raw-error-leaks.test.js` holds the rest of the
 * contract: it fails when error text reaches a response anywhere else.
 */
import { randomUUID } from 'node:crypto';

/** Brand shared across module copies (vitest can load this file twice). */
const AUTHORED = Symbol.for('hcw.authored-error');

/** A code is logged only in this shape, so it can never carry a sentence. */
const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * An error whose message this code wrote for the reader of the answer: a
 * validator's sentence, a typed refusal. Only its subclasses' messages pass
 * `authoredMessage`, so wrapping someone else's text in one is the single
 * way to defeat the door, and the repository guard refuses that too.
 */
export class AuthoredError extends Error {
  /**
   * @param {string} message - the sentence, written in this repository
   * @param {{ code?: string, status?: number, cause?: unknown }} [options]
   */
  constructor(message, { code, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (code !== undefined) this.code = code;
    if (status !== undefined) this.status = status;
  }
}
Object.defineProperty(AuthoredError.prototype, AUTHORED, { value: true });

/**
 * Whether an error carries a sentence this code wrote.
 *
 * @param {unknown} error - anything thrown
 * @returns {boolean}
 */
export function isAuthoredError(error) {
  return Boolean(error) && typeof error === 'object' && error[AUTHORED] === true;
}

/**
 * The door: an authored error's own sentence, or the safe sentence for
 * anything else. The only function that may put an error's message in a
 * response body.
 *
 * @param {unknown} error - anything thrown
 * @param {string} fallback - the safe sentence, written by the caller
 * @returns {string}
 */
export function authoredMessage(error, fallback) {
  if (isAuthoredError(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/**
 * The structured `details` an authored error carries for its reader (a
 * refused write's own answer, say), or undefined for anything else: a
 * provider's error object can carry `details` too, and those stay out.
 *
 * @param {unknown} error - anything thrown
 * @returns {unknown}
 */
export function authoredDetails(error) {
  return isAuthoredError(error) ? error.details : undefined;
}

/**
 * A content-free name for an error, for a log line: its code, its HTTP
 * status, or its class name, in a shape that cannot hold a sentence.
 *
 * @param {unknown} error - anything thrown
 * @returns {string}
 */
export function errorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && CODE_SHAPE.test(code)) return code;
  if (Number.isInteger(code)) return String(code);
  const status = error?.status ?? error?.statusCode;
  if (Number.isInteger(status)) return `HTTP_${status}`;
  const name = error?.name;
  if (typeof name === 'string' && CODE_SHAPE.test(name)) return name;
  return 'UNKNOWN';
}

/**
 * Extract or generate a correlation ID for request tracing.
 *
 * @param {object} [context] - Azure Functions invocation context
 * @param {object} [request] - HTTP request object
 * @returns {string}
 */
export function getCorrelationId(context, request) {
  return (
    context?.invocationId ||
    context?.traceContext?.traceparent ||
    request?.headers?.get?.('x-correlation-id') ||
    request?.headers?.get?.('x-request-id') ||
    randomUUID()
  );
}

/**
 * Log a failure content-free and return the correlation id that ties the
 * answer to the line. The line is the caller's sentence, the error's code and
 * the id; an authored refusal is a warning, anything else an error.
 *
 * @param {object} context - invocation context, or any `{ error, warn }` logger
 * @param {string} sentence - what failed, written by the caller
 * @param {unknown} error - the error behind it (only its code is logged)
 * @param {object} [request] - the HTTP request, for a caller-supplied id
 * @returns {string} the correlation id
 */
export function logFailure(context, sentence, error, request = null) {
  const correlationId = getCorrelationId(context, request);
  const line = `[${correlationId}] ${sentence} (${errorCode(error)})`;
  const write = isAuthoredError(error)
    ? (context?.warn ?? context?.error)
    : (context?.error ?? context?.warn);
  if (typeof write === 'function') write.call(context, line);
  return correlationId;
}

/**
 * The fields of a failure answer for a route with its own response shape:
 * `ok: false`, the door's sentence and the correlation id, logged once.
 *
 * @param {object} context - invocation context or logger
 * @param {string} fallback - the safe sentence for an error the code did not write
 * @param {unknown} error - anything thrown
 * @param {object} [request] - the HTTP request
 * @returns {{ ok: false, error: string, correlationId: string }}
 */
export function failureFields(context, fallback, error, request = null) {
  return {
    ok: false,
    error: authoredMessage(error, fallback),
    correlationId: logFailure(context, fallback, error, request),
  };
}

/**
 * Build a standardized, sanitized error response. The body always carries
 * the safe sentence, whatever the error was.
 *
 * @param {object} context - Azure Functions invocation context or logger
 * @param {string} fallbackMessage - User-facing error message (never leaks internal stacks)
 * @param {any} [error] - Internal error object or message (its code is logged, nothing else)
 * @param {number} [status=500] - HTTP status code
 * @param {object} [request] - Incoming HTTP request for header correlation
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function errorResponse(context, fallbackMessage, error, status = 500, request = null) {
  const correlationId = logFailure(context, fallbackMessage, error, request);

  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
    },
    body: JSON.stringify({
      ok: false,
      error: fallbackMessage,
      correlationId,
    }),
  };
}
