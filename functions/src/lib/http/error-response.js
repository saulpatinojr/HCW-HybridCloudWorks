/**
 * error-response.js — standardized error response with correlation IDs and error sanitization (AP-B10).
 *
 * Attaches Azure Functions invocation ID (or traceparent/x-correlation-id) as correlationId.
 * Prevents raw internal stack traces, DB connection strings, and unhandled exception details
 * from leaking to clients in HTTP 5xx responses.
 */
import { randomUUID } from 'node:crypto';

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
 * Build a standardized, sanitized error response.
 *
 * @param {object} context - Azure Functions invocation context or logger
 * @param {string} fallbackMessage - User-facing error message (never leaks internal stacks)
 * @param {any} [error] - Internal error object or message (logged, not returned to client)
 * @param {number} [status=500] - HTTP status code
 * @param {object} [request] - Incoming HTTP request for header correlation
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function errorResponse(context, fallbackMessage, error, status = 500, request = null) {
  const correlationId = getCorrelationId(context, request);

  if (context?.error) {
    context.error(`[${correlationId}] ${fallbackMessage}:`, error);
  }

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
