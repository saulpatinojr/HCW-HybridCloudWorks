/**
 * issue-actions.js — cancel, reschedule and retry an approved issue (ADR 0033
 * Amplify slice; split out of admin-handlers.js for PR #841).
 *
 *   POST /api/cms/newsletters/{id}/cancel     publisher  cancel a scheduled broadcast; the issue returns to Drafts
 *   POST /api/cms/newsletters/{id}/reschedule publisher  move a scheduled broadcast to another time
 *   POST /api/cms/newsletters/{id}/retry      publisher  a failed issue back to a draft for a fresh approval
 *
 * The three share one shape — the role, the etag, the issue as stored, a
 * status it must be in, the caller's view still current — and differ only in
 * what they do once all of that holds. `issueAction` is that shape, and each
 * route hands it the differences. The document transitions at the bottom are
 * pure: the stored issue in, the issue to write out, with `at` the ISO
 * instant of the action. Cancel and a reschedule that Resend refused both
 * release the broadcast the same way, so the shared fields live in one place
 * and the two can only differ in `lastError`.
 *
 * `createIssueActions(deps)` takes the admin factory's own readers and
 * presenters so an issue is read, rendered and shown exactly as the other
 * routes do it; nothing here reads a document the admin routes do not.
 */
import { resolveSegmentId } from './handlers.js';
import {
  changedElsewhere,
  describeForLog,
  describeForOwner,
  errorMeta,
  etagRequired,
  invocationRef,
  json,
  missingEtag,
  notFound,
  resendNotConfigured,
  staleView,
} from './admin-responses.js';
import { parseScheduledAt } from './validate.js';
import { errorCode } from '../http/error-response.js';

/** A scheduled issue Resend holds: the only kind a cancel or reschedule can act on. */
export const scheduledWithBroadcast = (issue) =>
  issue.status === 'scheduled' && Boolean(issue.broadcastId);

/**
 * An ETag-conditional write of `next`: `{ written }` as stored, or
 * `{ changed: true }` when the issue moved on since it was read (412).
 */
async function writeIfCurrent(store, next) {
  try {
    const written = await store.replaceDocIfMatch('newsletters', next);
    return { written: written ?? next };
  } catch (error) {
    if (error?.code === 412) return { changed: true };
    throw error;
  }
}

/**
 * What is refused before the issue is even read: a missing etag, a body the
 * action cannot parse, and — for an action that talks to Resend — a missing
 * key. `{ response }` is the refusal; `{ value }` is what `parse` read.
 */
function refuseEarly(deps, body, action) {
  if (missingEtag(body)) return { response: etagRequired() };
  const parsed = action.parse ? action.parse(body) : {};
  if (parsed.error) return { response: json(400, { ok: false, error: parsed.error }) };
  if (action.needsResend && !deps.clientOrNull()) return { response: resendNotConfigured() };
  return { value: parsed.value };
}

/** The reason an action cannot touch `issue` right now, as a response, or null. */
function refuseAction(issue, body, action) {
  if (!issue) return notFound();
  if (!action.allowed(issue)) return json(409, { ok: false, error: action.refusal(issue.status) });
  if (staleView(body, issue)) return changedElsewhere();
  return null;
}

/**
 * @param {object} action
 * @param {string} action.role
 * @param {string} action.label the route name for log lines
 * @param {string} action.verb for the 500's sentence: "Failed to <verb> the newsletter issue"
 * @param {(issue: object) => boolean} action.allowed
 * @param {(status: string) => string} action.refusal the 409's sentence
 * @param {(body: object) => { error?: string, value?: any }} [action.parse]
 * @param {boolean} [action.needsResend]
 * @param {(args: { issue: object, body: object, value: any, client: object|null }) => Promise<object>} action.act
 */
async function issueAction(deps, request, context, action) {
  const auth = await deps.guard.requireRole(request, action.role);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const early = refuseEarly(deps, body, action);
  if (early.response) return early.response;
  try {
    const issue = await deps.readIssue(request);
    const refused = refuseAction(issue, body, action);
    if (refused) return refused;
    return await action.act({ issue, body, value: early.value, client: deps.clientOrNull() });
  } catch (error) {
    context.error?.(`${action.label} failed ${invocationRef(context)}: ${errorMeta(error)}`);
    return json(500, { ok: false, error: `Failed to ${action.verb} the newsletter issue` });
  }
}

/** The issue written back and presented, or the 409 when it changed meanwhile. */
async function commit(deps, next, context, settings = null) {
  const outcome = await writeIfCurrent(deps.store, next);
  if (outcome.changed) return changedElsewhere();
  const shown = settings ?? (await deps.readSettings());
  return json(200, await deps.present(outcome.written, shown, context));
}

/**
 * Cancel's work once the issue is known to be scheduled. Resend's cancel is
 * `DELETE /broadcasts/{id}` for a `scheduled` one; a refusal comes back with
 * Resend's own sentence, because the plan or the state is what it names. On
 * success the issue is a kept draft again, approvable afresh, with the
 * cancellation recorded.
 */
async function cancelIssue(deps, { issue, client }, context) {
  const deleted = await client.deleteBroadcast(issue.broadcastId);
  if (!deleted.ok) {
    context.error?.(
      `cancelNewsletter refused ${invocationRef(context)}: ${describeForLog(deleted)}`
    );
    return json(502, {
      ok: false,
      code: 'CANCEL_REFUSED',
      error: `Resend did not cancel the broadcast: ${describeForOwner(deleted)}`,
    });
  }
  const response = await commit(deps, canceledIssue(issue, deps.now().toISOString()), context);
  if (response.status === 200) context.log?.(`cancelNewsletter ok ${invocationRef(context)}`);
  return response;
}

/** The new broadcast of a reschedule; a thrown error reads as a refusal with its message. */
async function createRescheduledBroadcast(
  deps,
  client,
  { issue, rendered, settings, scheduledAt },
  context
) {
  try {
    return await client.createBroadcast({
      segmentId: await resolveSegmentId(client),
      from: await deps.fromAddress(context),
      replyTo: settings.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      name: `HybridCloudWorks Weekly ${issue.id.slice('issue-'.length)}`,
      scheduledAt,
    });
  } catch (error) {
    return { ok: false, status: 0, data: { name: errorCode(error) } };
  }
}

/** The old broadcast is gone and no new one exists: say so on the issue, and to the caller. */
async function revertAfterRefusal(deps, issue, created, at, context) {
  context.error?.(
    `rescheduleNewsletter new broadcast refused ${invocationRef(context)}: ${describeForLog(created)}`
  );
  const reverted = revertedIssue(issue, describeForOwner(created), at);
  await deps.store.replaceDocIfMatch('newsletters', reverted).catch((error) => {
    context.error?.(
      `rescheduleNewsletter could not revert ${invocationRef(context)}: ${errorMeta(error)}`
    );
  });
  return json(502, { ok: false, code: 'RESCHEDULE_REFUSED', error: reverted.lastError });
}

/** The 409 of a reschedule whose issue changed while Resend was accepting the new broadcast. */
const changedDuringReschedule = (broadcastId, scheduledAt) =>
  json(409, {
    ok: false,
    code: 'CHANGED_DURING_RESCHEDULE',
    broadcastId,
    error: `Resend accepted broadcast ${broadcastId} for ${scheduledAt}, but this issue changed meanwhile. Reload it; if it does not show the new time, cancel the extra broadcast in Resend.`,
  });

/**
 * Reschedule's work once the issue is known to be scheduled. Resend's update
 * does not take a new `scheduled_at`, so this is a cancel and a fresh
 * broadcast with the same rendered content: the old one is deleted first, and
 * if the new one is refused the issue returns to a draft with the reason
 * rather than standing scheduled against a broadcast that no longer exists.
 */
async function rescheduleIssue(deps, { issue, client, value: scheduledAt }, context) {
  const settings = await deps.readSettings();
  const rendered = await deps.renderChosenDesign(
    issue,
    { postalAddress: settings.postalAddress },
    settings,
    context
  );
  if (rendered.templateProblem) {
    return json(409, {
      ok: false,
      code: 'TEMPLATE_UNUSABLE',
      templateProblem: rendered.templateProblem,
      // The reason is `templateProblem` beside it (authored in
      // template-source/template-layout); the sentence does not repeat it.
      error: 'The template chosen in Newsletter settings cannot be used; templateProblem says why.',
    });
  }
  const deleted = await client.deleteBroadcast(issue.broadcastId);
  if (!deleted.ok) {
    context.error?.(
      `rescheduleNewsletter cancel refused ${invocationRef(context)}: ${describeForLog(deleted)}`
    );
    return json(502, {
      ok: false,
      code: 'CANCEL_REFUSED',
      error: `Resend did not release the current broadcast, so nothing moved: ${describeForOwner(deleted)}`,
    });
  }
  const at = deps.now().toISOString();
  const created = await createRescheduledBroadcast(
    deps,
    client,
    { issue, rendered, settings, scheduledAt },
    context
  );
  if (!created.ok || !created.data?.id)
    return revertAfterRefusal(deps, issue, created, at, context);
  const moved = rescheduledIssue(issue, created.data.id, scheduledAt, at);
  const outcome = await writeIfCurrent(deps.store, moved);
  if (outcome.changed) return changedDuringReschedule(created.data.id, scheduledAt);
  context.log?.(`rescheduleNewsletter ok ${invocationRef(context)}`);
  return json(200, await deps.present(outcome.written, settings, context));
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} deps.now
 * @param {(request: object) => Promise<object|null>} deps.readIssue the issue a request names, or null
 * @param {() => Promise<object>} deps.readSettings Newsletter settings as presented
 * @param {(issue: object, settings: object, context: object) => Promise<object>} deps.present the issue as the page shows it
 * @param {Function} deps.renderChosenDesign the issue in the design settings chose
 * @param {() => object|null} deps.clientOrNull a Resend client, or null without the key
 * @param {(context: object) => Promise<string>} deps.fromAddress the From address a send uses
 * @returns {{ cancel: Function, reschedule: Function, retry: Function }} route handlers `(request, context)`
 */
export function createIssueActions(deps) {
  return {
    cancel: (request, context) =>
      issueAction(deps, request, context, {
        role: 'publisher',
        label: 'cancelNewsletter',
        verb: 'cancel',
        needsResend: true,
        allowed: scheduledWithBroadcast,
        refusal: (status) => `Only a scheduled issue can be canceled; this issue is ${status}.`,
        act: (args) => cancelIssue(deps, args, context),
      }),
    reschedule: (request, context) =>
      issueAction(deps, request, context, {
        role: 'publisher',
        label: 'rescheduleNewsletter',
        verb: 'reschedule',
        needsResend: true,
        parse: (body) => parseScheduledAt(body.scheduledAt, deps.now().getTime()),
        allowed: scheduledWithBroadcast,
        refusal: (status) => `Only a scheduled issue can be rescheduled; this issue is ${status}.`,
        act: (args) => rescheduleIssue(deps, args, context),
      }),
    retry: (request, context) =>
      issueAction(deps, request, context, {
        role: 'publisher',
        label: 'retryNewsletter',
        verb: 'retry',
        allowed: (issue) => issue.status === 'failed',
        refusal: (status) => `Only a failed issue can be retried; this issue is ${status}.`,
        act: ({ issue }) => commit(deps, retriedIssue(issue, deps.now().toISOString()), context),
      }),
  };
}

// ── Document transitions (pure) ─────────────────────────────────────────────

/**
 * The fields an issue loses when Resend no longer holds its broadcast: it is
 * a kept draft again, approvable afresh, and the cancellation is recorded.
 */
export function releasedBroadcast(issue, at) {
  return {
    status: 'draft',
    savedAt: issue.savedAt ?? at,
    canceledAt: at,
    canceledBroadcastId: issue.broadcastId,
    broadcastId: null,
    broadcastStatus: null,
    scheduledAt: null,
    approvedAt: null,
    approvedBy: null,
    updatedAt: at,
  };
}

/** After a cancel Resend accepted: released, with any earlier failure cleared. */
export const canceledIssue = (issue, at) => ({
  ...issue,
  ...releasedBroadcast(issue, at),
  lastError: null,
});

/**
 * After a reschedule whose new broadcast Resend refused: the old one is gone
 * and no new one exists, so the issue is released and says why.
 */
export const revertedIssue = (issue, reason, at) => ({
  ...issue,
  ...releasedBroadcast(issue, at),
  lastError: `The previous broadcast was canceled but Resend refused the new one: ${reason}. Approve again to reschedule.`,
});

/** After a reschedule Resend accepted: the same issue against the new broadcast and time. */
export const rescheduledIssue = (issue, broadcastId, scheduledAt, at) => ({
  ...issue,
  broadcastId,
  broadcastStatus: 'scheduled',
  scheduledAt,
  sendAt: scheduledAt,
  rescheduledAt: at,
  lastError: null,
  updatedAt: at,
});

/**
 * A failed issue back to a kept draft for a fresh approval. The failure stays
 * in `lastError` for the page to show until the next approval clears it.
 */
export const retriedIssue = (issue, at) => ({
  ...issue,
  status: 'draft',
  savedAt: issue.savedAt ?? at,
  retriedAt: at,
  failedBroadcastId: issue.broadcastId ?? null,
  broadcastId: null,
  broadcastStatus: null,
  scheduledAt: null,
  sentAt: null,
  approvedAt: null,
  approvedBy: null,
  updatedAt: at,
});
