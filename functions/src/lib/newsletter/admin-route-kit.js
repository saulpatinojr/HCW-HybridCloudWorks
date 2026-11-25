/**
 * admin-route-kit.js — what every newsletter issue route shares: the refusals,
 * the guarded write, and reading the issue (and the settings) for a route
 * (admin-handlers.js holds the routes).
 */
import { json, notFound, staleView, changedElsewhere, missingEtag, etagRequired, errorMeta, invocationRef } from './admin-responses.js';
import { replaceIssueIfMatch } from './admin-issue-store.js';

// ── The issue routes, hoisted out of the factory (PR #841 quality round) ──
//
// Each takes the factory's `ctx` first. What a route refuses, in what order,
// with which status, body and log line, is what it was inside the factory;
// the steps are only named, so each function below is short enough to read
// whole: a refusal check answers the response to send or null, a step that
// can fail answers `{ value }` or `{ response }`.

/** Who acted, for `savedBy`, `approvedBy`, `deletedBy` and a version's `by`. */
export const actorOf = (auth) => auth.user?.oid || auth.user?.sub || null;

export const isDraft = (status) => status === 'draft';

export const aiNotConfigured = () =>
  json(503, { ok: false, error: 'AI drafting is not configured for newsletters.' });

/** The 409 while the settings cannot send; `before` finishes its sentence. */
export const settingsIncomplete = (missing, before) =>
  json(409, {
    ok: false,
    code: 'SETTINGS_INCOMPLETE',
    missingSettings: missing,
    error: `Add the ${missing.join(' and ')} in Newsletter settings before ${before}.`,
  });

/** The reason a write cannot touch `issue` right now, as a response, or null. */
export function refuseWrite(issue, body, allowed, refusal) {
  if (!issue) return notFound();
  if (!allowed(issue.status)) return json(409, { ok: false, error: refusal(issue.status) });
  if (staleView(body, issue)) return changedElsewhere();
  return null;
}

/** The default early check of a write: the body must carry the etag. */
export const requireEtag = (body) => (missingEtag(body) ? { response: etagRequired() } : { value: null });

/**
 * An issue written back and presented, or the 409 when it changed meanwhile.
 * The STORED document is presented, so the answer carries the new etag.
 */
export async function commitIssue(ctx, next, context, settings = null) {
  const written = await replaceIssueIfMatch(ctx.store, next);
  if (written.conflict) return changedElsewhere();
  const shown = settings ?? (await ctx.readSettings());
  return json(200, await ctx.present(written.doc, shown, context));
}

/**
 * The shape every etag-guarded write to one issue shares: the role, the body
 * and its early checks, then — inside the catch-all that turns an exception
 * into the route's 500 — the read, what is refused about the issue, and `act`.
 *
 * @param {object} spec
 * @param {string} spec.role
 * @param {string} spec.label the route name for log lines
 * @param {string} spec.failure the 500's sentence
 * @param {(status: string) => boolean} spec.allowed
 * @param {(status: string) => string} spec.refusal the 409's sentence
 * @param {(body: any) => { response?: object, value?: any }} [spec.prepare] the early checks; requireEtag by default
 * @param {(context: object) => string} [spec.logLabel] how the 500's log line starts; the error's name and code follow it
 * @param {(args: { issue: object, body: object, auth: object, value: any }) => Promise<object>} spec.act
 */
export async function issueWrite(ctx, request, context, spec) {
  const auth = await ctx.guard.requireRole(request, spec.role);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const early = (spec.prepare ?? requireEtag)(body);
  if (early.response) return early.response;
  try {
    const issue = await ctx.readIssue(request);
    const refused = refuseWrite(issue, body, spec.allowed, spec.refusal);
    if (refused) return refused;
    return await spec.act({ issue, body, auth, value: early.value });
  } catch (error) {
    context.error?.(`${spec.logLabel ? spec.logLabel(context) : `${spec.label} failed`}: ${errorMeta(error)}`);
    return json(500, { ok: false, error: spec.failure });
  }
}

/**
 * The reads of a route that answers a failed read with its own 500 rather
 * than a catch-all: the issue, and the settings when asked for.
 * `{ issue, settings }`, or `{ response }`: the 500, or 404 for no issue.
 */
export async function readForRoute(ctx, request, label, context, { withSettings = false } = {}) {
  try {
    const settings = withSettings ? await ctx.readSettings() : null;
    const issue = await ctx.readIssue(request);
    return issue ? { issue, settings } : { response: notFound() };
  } catch (error) {
    context.error?.(`${label} read failed ${invocationRef(context)}: ${errorMeta(error)}`);
    return { response: json(500, { ok: false, error: 'Failed to read the newsletter issue' }) };
  }
}

/**
 * The issue in the chosen design, or the 500 when rendering threw.
 * `{ rendered }` or `{ response }`. `renderSettings` is what the renderer is
 * told beyond the settings: the postal address, and whether this is a test.
 */
export async function renderOr500(ctx, label, { issue, renderSettings, settings }, context) {
  try {
    return { rendered: await ctx.renderChosenDesign(issue, renderSettings, settings, context) };
  } catch (error) {
    context.error?.(`${label} render failed ${invocationRef(context)}: ${errorMeta(error)}`);
    return { response: json(500, { ok: false, error: 'Failed to render the newsletter issue' }) };
  }
}

