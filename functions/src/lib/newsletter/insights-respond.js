/**
 * insights-respond.js — how a Mailing List page route answers: a Resend
 * refusal or an exception as a content-free response, a relayed or
 * acknowledged call, a page of rows, and the route wrapper that checks the
 * role and the key first (insights-handlers.js holds the routes).
 */
import { ERROR_TEXT_LIMIT, json, rowsOf } from './insights-shared.js';
import { nextCursor } from './insights-read.js';
import { NEWSLETTER_SEGMENT_NAME } from './handlers.js';

// ── Route plumbing ──────────────────────────────────────────────────────────

export const ref = (context) => `[invocation ${context?.invocationId ?? 'unknown'}]`;

/**
 * A Resend failure as an HTTP answer. Logs the route, the status and the
 * invocation only; Resend's name and message go to the caller, trimmed.
 */
export function refused(route, result, context) {
  const status = result?.status ?? 0;
  context.warn?.(`${route} Resend HTTP ${status} ${ref(context)}`);
  // Resend's error name (a code such as `validation_error`) and the status;
  // Resend's own sentence is a provider's words and stays out (#945).
  const name = typeof result?.data?.name === 'string' ? result.data.name : '';
  const text = status
    ? `Resend refused the request (HTTP ${status}${name ? ` ${name}` : ''}).`
    : `No answer from Resend${name ? ` (${name})` : ''}.`;
  const error = text.slice(0, ERROR_TEXT_LIMIT);
  if (status === 429) {
    const seconds = Number.parseInt(String(result?.retryAfter ?? ''), 10);
    const retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 1;
    return json(
      429,
      { ok: false, status, retryAfterSeconds, error },
      { 'Retry-After': String(retryAfterSeconds) }
    );
  }
  return json(502, { ok: false, status, error });
}

/** An exception as a 500. The error's name is logged; nothing else of it is. */
export function failed(route, error, context) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  context.error?.(`${route} failed ${name} ${ref(context)}`);
  return json(500, {
    ok: false,
    error: 'The Newsletter Hub request failed.',
  });
}

/** GET through `call`, projecting the successful body with `project`. */
export async function relay(route, context, call, project) {
  const result = await call();
  if (!result.ok) return refused(route, result, context);
  return json(200, { ok: true, ...project(result) });
}

/**
 * A write through `call`, acknowledged with `{ ok: true, ...body }` and a
 * content-free log line. `onOk` runs first on success (cache invalidation).
 */
export async function acknowledged(route, context, call, { body = {}, onOk } = {}) {
  const result = await call();
  if (!result.ok) return refused(route, result, context);
  onOk?.();
  context.log?.(`${route} ok ${ref(context)}`);
  return json(200, { ok: true, ...body });
}

/** One page of rows under `key`, with Resend's paging beside it. */
export function pageOf(result, key, project) {
  const rows = rowsOf(result);
  return {
    [key]: rows.map(project),
    has_more: Boolean(result.data?.has_more),
    next_after: nextCursor(result, rows),
  };
}

/**
 * A route: the role, then the key (`ctx.open`), then `body` inside the
 * catch-all that turns an exception into a content-free 500. `body` gets
 * `{ client, auth, request, context, route }`.
 */
export const handler = (ctx, route, role, body) => async (request, context) => {
  const opened = await ctx.open(request, role);
  if (opened.response) return opened.response;
  try {
    return await body({ ...opened, request, context, route });
  } catch (error) {
    return failed(route, error, context);
  }
};

/**
 * The Newsletter segment's id, found by name and never created: these are
 * reads, and creating a segment is confirm's job (handlers.js). `{ id }`
 * (null when there is no such segment yet) or `{ result }` for a refusal.
 */
export async function findNewsletterSegment(client) {
  let after;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const listed = await client.listSegments(after);
    if (!listed.ok) return { result: listed };
    const rows = rowsOf(listed);
    const found = rows.find((row) => row?.name === NEWSLETTER_SEGMENT_NAME);
    if (found?.id) return { id: found.id };
    if (!listed.data?.has_more || rows.length === 0) break;
    after = rows[rows.length - 1].id;
  }
  return { id: null };
}

