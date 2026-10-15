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
 * A provider's value as a code a sentence may carry: an integer, or a string
 * in the code shape (`invalid_grant`, `missing_permissions`, `ENOTFOUND`).
 * Anything else, a sentence, a URL, echoed request data, an object, is '',
 * so a sentence this code writes around a provider's value can name its code
 * and never its words (#945). Callers fall back to the HTTP status or a fixed
 * word when it is ''.
 *
 * @param {unknown} value - the provider's field
 * @returns {string}
 */
export function codeShaped(value) {
  if (Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return CODE_SHAPE.test(trimmed) ? trimmed : '';
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
 * Everything content-free an operator diagnoses an error by, as `key=value`
 * pairs for a log line: its class name, its code (a provider's or Node's,
 * `ECONNRESET`, `invalid_grant`, `429`), its HTTP status, a Cosmos substatus,
 * and the code of its cause (undici's `fetch failed` keeps the socket code
 * there). Each value must fit CODE_SHAPE, so none can carry a sentence; the
 * message and the stack are never read.
 *
 * @param {unknown} error - anything thrown
 * @returns {string} e.g. `name=Error code=429 status=429 substatus=3200`
 */
export function errorFacts(error) {
  if (!error || typeof error !== 'object') return `type=${error === null ? 'null' : typeof error}`;
  const facts = [];
  /** Keep one fact when its value has the code shape. */
  const add = (key, value) => {
    const text = Number.isInteger(value) ? String(value) : value;
    if (typeof text === 'string' && CODE_SHAPE.test(text)) facts.push(`${key}=${text}`);
  };
  add('name', error.name);
  add('code', error.code);
  add('status', error.status ?? error.statusCode);
  add('substatus', error.substatus);
  add('cause', error.cause?.code ?? error.cause?.name);
  return facts.join(' ') || 'type=object';
}

/**
 * Log a failure content-free and return the correlation id that ties the
 * answer to the line. The line is the caller's sentence, the error's
 * content-free facts (errorFacts: name, code, status, substatus, cause code)
 * and the id; an authored refusal is a warning, anything else an error.
 *
 * @param {object} context - invocation context, or any `{ error, warn }` logger
 * @param {string} sentence - what failed, written by the caller
 * @param {unknown} error - the error behind it (never its message or stack)
 * @param {object} [request] - the HTTP request, for a caller-supplied id
 * @returns {string} the correlation id
 */
export function logFailure(context, sentence, error, request = null) {
  const correlationId = getCorrelationId(context, request);
  const line = `[${correlationId}] ${sentence} (${errorFacts(error)})`;
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

/** A correlation id in a shape that cannot carry a sentence. */
const CORRELATION_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * What a document stores about a failure, written at the moment of failure
 * so that no later read can serve someone else's words (#945): an authored
 * error's own sentence, or the caller's sentence with the error's code and,
 * when there is one, the correlation id of the log line that has the rest.
 * Always one string, so a field that held `error.message` keeps its shape.
 *
 * @param {unknown} error - anything thrown
 * @param {string} fallback - what failed, written by the caller
 * @param {{ correlationId?: string|null }} [options] - the log line's id, when the site logged one
 * @returns {string} e.g. `The job failed (ECONNRESET; reference inv-123).`
 */
export function storedFailure(error, fallback, { correlationId = null } = {}) {
  if (isAuthoredError(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  const code = errorCode(error);
  const parts = [code === 'UNKNOWN' ? 'no code' : code];
  if (typeof correlationId === 'string' && CORRELATION_SHAPE.test(correlationId)) {
    parts.push(`reference ${correlationId}`);
  }
  return `${String(fallback).replace(/\.$/, '')} (${parts.join('; ')}).`;
}

/**
 * Log a failure content-free (logFailure) and return what to store about it
 * (storedFailure), tied together by the same correlation id.
 *
 * @param {object} context - invocation context or logger
 * @param {string} fallback - what failed, written by the caller
 * @param {unknown} error - anything thrown
 * @returns {string}
 */
export function recordedFailure(context, fallback, error) {
  const correlationId = logFailure(context, fallback.replace(/\.$/, ''), error);
  return storedFailure(error, fallback, { correlationId });
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
