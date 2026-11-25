/**
 * admin-handlers.js — reviewing and approving weekly issues (ADR 0030 §2a).
 *
 *   GET   /api/cms/newsletters               editor     the recent issues
 *   GET   /api/cms/newsletters/{id}          editor     one issue, rendered as it would send
 *   PATCH /api/cms/newsletters/{id}          editor     a draft's subject, preview text, note and sections
 *   POST  /api/cms/newsletters/{id}/intro    editor     regenerate a draft's AI intro
 *   POST  /api/cms/newsletters/{id}/subjects editor     AI subject-line suggestions (no write)
 *   POST  /api/cms/newsletters/{id}/test     publisher  one test email to the reply-to address
 *   POST  /api/cms/newsletters/{id}/approve  publisher  schedule (or send) it through Resend
 *   POST  /api/cms/newsletters/{id}/reject   editor     set aside a draft, or clear a stuck send
 *   POST  /api/cms/newsletters/{id}/save     editor     keep a draft: it moves to the Drafts tab
 *   DELETE /api/cms/newsletters/{id}         editor     delete a draft, rejected or failed issue
 *
 * Added for ADR 0033 (Amplify slice), so an approved issue can be managed
 * from here rather than from Resend's dashboard:
 *
 *   POST  /api/cms/newsletters/{id}/cancel     publisher  cancel a scheduled broadcast; the issue returns to Drafts
 *   POST  /api/cms/newsletters/{id}/reschedule publisher  move a scheduled broadcast to another time
 *   POST  /api/cms/newsletters/{id}/retry      publisher  a failed issue back to a draft for a fresh approval
 *   POST  /api/cms/newsletters/{id}/duplicate  editor     a new draft with this issue's content
 *   POST  /api/cms/newsletter-reconcile        editor     ask Resend where every scheduled issue stands
 *   GET   /api/cms/newsletter-sender           editor     the From address newsletters send from
 *   PUT   /api/cms/newsletter-sender           publisher  change it (validated on a Resend sending domain)
 *
 * ## Scheduled becomes sent by asking Resend (reconcile.js)
 *
 * Approval records `scheduled`; Resend does the sending and tells nobody. So
 * a read of a scheduled issue, a list that finds one overdue, and the
 * reconcile route each read `GET /broadcasts/{id}` and write what it says —
 * `sent` with Resend's `sent_at`, or `failed` with the reason when Resend
 * canceled or lost it. That is the only path to `sent` for a scheduled issue.
 *
 * ## Manual blocks (applySectionEdit, in section-edit.js since PR #841)
 *
 * The owner can add an item of their own — a chosen live article or a custom
 * block with a title, link, summary and image — to any section, or into a
 * section of their own (`manual`, `manual-<slug>`). A manual item carries
 * `manual: true` and is validated like a collected one: plain text, an https
 * link, an https image. Collected items are still never edited.
 *
 * The page's three tabs are views of one list: Review holds drafts not yet
 * saved (and rejected issues), Drafts holds saved drafts, and Published shows
 * scheduled and sent issues on a calendar, one month per `?month=YYYY-MM`
 * request. Deleting marks the issue `deleted` with an ETag-conditional write
 * rather than removing the document, so a delete can never race an approval
 * that has already claimed the issue; a deleted issue reads as not found.
 *
 * `approve` is routed in functions/src/functions/newsletter-admin-http.js and called by the
 * Mailing List page's Approve button. It is refused until the owner sets
 * newsletter_sending_enabled in Terraform.
 *
 * Approval is PUBLISHER, not editor: it emails every confirmed subscriber, which
 * is publishing in every sense the role exists for. It is also the owner's
 * decision of 2026-09-13 that nothing sends without it.
 *
 * ## An issue can be sent at most once, and only as the approver saw it
 *
 * Approval requires the `etag` of the issue the approver was looking at, so an
 * issue edited after they opened it is refused (409) rather than sent with
 * content they never read. It then CLAIMS the issue with an ETag-conditional
 * write from `draft` to `sending` before calling Resend, so two approvals racing
 * — a double click, two tabs, a retry — produce one broadcast; the loser gets a
 * 409. The outcome is written back only while the issue is still that claim, so
 * a reject that lands mid-send stands. A refused broadcast returns the issue to
 * `draft` with the reason; an accepted one makes it `scheduled` (or `sent`).
 *
 * An issue left in `sending` means a process died between the claim and
 * Resend's answer. It is never retried automatically, because a broadcast may
 * already exist; the answer says to check Resend's Broadcasts list, and reject is
 * allowed from `sending` so the owner can clear it once they have looked.
 *
 * ## Editing sections never adds content
 *
 * PATCH may drop items, reorder items within a section, reorder sections and
 * drop whole sections. It may not add an item, move one between sections or
 * change any field of one: titles and URLs come from the published site, and
 * the renderer re-checks every link. An item is identified by its section id
 * and its `url` (items carry no id of their own, and a section never lists
 * the same URL twice); the stored item is what is written back, so the page
 * only ever chooses which stored items remain and in what order.
 *
 * ## A test send cannot reach a subscriber
 *
 * `test` emails ONE address, the reply-to from Newsletter settings, through
 * Resend's single-email endpoint. It never reads an address from the request
 * and never touches a segment or a broadcast, which is why it works while
 * NEWSLETTER_SENDING_ENABLED is off.
 *
 * ## The design is the one that was previewed
 *
 * With a Resend template chosen in Newsletter settings (#557), the preview, the
 * test send and the broadcast are all laid out in it (template-layout.js),
 * from the same cached copy (template-source.js). When the template cannot be
 * fetched or used, the preview and the test send fall back to the built-in
 * design and say why in `templateProblem`. Approval does NOT fall back: it is
 * refused with 409 TEMPLATE_UNUSABLE before the claim, so an issue is never
 * broadcast in a design other than the one the owner chose and previewed.
 */
import { readKey } from '../ai/router.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { presentSetting } from '../platform-settings.js';
import { createResendClient } from './resend-client.js';
import { resolveSegmentId } from './handlers.js';
import { createIssueActions } from './issue-actions.js';
import { changedElsewhere, describeForLog, describeForOwner, errorMeta, invocationRef, json, staleView } from './admin-responses.js';
import { resolveFromAddress } from './sender.js';
import { NEWSLETTER_SETTINGS_CONFIG_ID, missingForSending } from './settings.js';
import { sharedTemplateCache } from './template-source.js';
import { settingsIncomplete, isDraft, renderOr500, actorOf } from './admin-route-kit.js';
import { planFor, NEWSLETTER_AI_BUDGET_MS, readIssueDoc } from './admin-issue-store.js';
import { settleClaim, renderChosenDesign, presentIssue } from './admin-patch.js';
import { openSend, test } from './admin-test-route.js';
import { list, get, duplicate, reconcile, getSender, putSender } from './admin-read-routes.js';
import { update, intro, subjects } from './admin-edit-routes.js';
import { save, remove, reject } from './admin-keep-routes.js';

// Section editing lives in section-edit.js since PR #841; re-exported so the
// route tests and any caller keep one import.
export { applySectionEdit, normalizeManualItem } from './section-edit.js';

// The issue routes and their helpers live in the admin-*.js files beside this
// one (the store, the edit checks, the shared route kit, the edit, test,
// keep and read routes); the names callers use are exported again here so
// they keep importing from admin-handlers.js.
export {
  MAX_CUSTOM_NOTE_LENGTH,
  MAX_PREHEADER_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_VERSIONS,
  NEWSLETTER_AI_BUDGET_MS,
  planFor,
  pushVersion,
  TEST_SEND_INTERVAL_MS,
} from './admin-issue-store.js';
export { parseIssuePatch } from './admin-patch.js';

/**
 * The 503 while the owner's switch is off, or null. Judged before anything
 * is read, claimed or sent, whatever the issue or settings say.
 */
const sendingSwitchedOff = (ctx) =>
  ctx.sendingEnabled()
    ? null
    : json(503, {
        ok: false,
        code: 'NEWSLETTER_SENDING_DISABLED',
        error:
          'Sending is switched off. Set newsletter_sending_enabled to true in Terraform to allow approval.',
      });

/**
 * What an approval refuses once the issue is read: incomplete settings, an
 * issue that is not a draft, and a stale view — approve what the approver
 * saw; an issue edited since they opened it is not sent with content they
 * never read. The response, or null.
 */
function refuseApproval(settings, issue, body) {
  const missing = missingForSending(settings);
  if (missing.length) return settingsIncomplete(missing, 'approving');
  if (!isDraft(issue.status)) {
    return json(409, {
      ok: false,
      error: `Only a draft can be approved; this issue is ${issue.status}.`,
    });
  }
  return staleView(body, issue) ? changedElsewhere() : null;
}

/** The send plan, or the 409 when the settings cannot make one: `{ plan }` or `{ response }`. */
function planOr409(ctx, issue, settings, context) {
  try {
    return { plan: planFor(issue, settings, ctx.now()) };
  } catch (error) {
    context.error?.(
      `approveNewsletter send slot invalid ${invocationRef(context)}: ${errorMeta(error)}`
    );
    return {
      response: json(409, {
        ok: false,
        code: 'SETTINGS_INVALID',
        error:
          'The send day, time or time zone in Newsletter settings is not valid. Save them again, then approve.',
      }),
    };
  }
}

/**
 * Everything that can fail on the site's own data, worked out BEFORE the
 * claim so a bad settings document refuses the approval instead of leaving
 * the issue stuck in `sending` with nothing sent: the refusals, the plan,
 * the render, and a template that could not be used. `{ plan, rendered }`
 * or `{ response }`.
 */
async function prepareApproval(ctx, { body, settings, issue }, context) {
  const refused = refuseApproval(settings, issue, body);
  if (refused) return { response: refused };
  const planned = planOr409(ctx, issue, settings, context);
  if (planned.response) return planned;
  const rendered = await renderOr500(
    ctx,
    'approveNewsletter',
    { issue, renderSettings: { postalAddress: settings.postalAddress }, settings },
    context
  );
  if (rendered.response) return rendered;
  // The chosen template could not be fetched or used. The preview showed
  // the built-in design with a warning; sending that instead of the design
  // the owner chose is refused, before anything is claimed.
  const problem = rendered.rendered.templateProblem;
  if (problem) {
    context.error?.(
      `approveNewsletter template unusable ${invocationRef(context)}: ${problem.code}`
    );
    return {
      response: json(409, {
        ok: false,
        code: 'TEMPLATE_UNUSABLE',
        templateProblem: problem,
        // The reason is `templateProblem` beside it (authored); the preview
        // shows it too. The sentence does not repeat it (#945).
        error:
          'The template chosen in Newsletter settings cannot be used. Fix it in Resend or choose the built-in design, check the preview, then approve.',
      }),
    };
  }
  return { plan: planned.plan, rendered: rendered.rendered };
}

/**
 * The issue claimed from `draft` to `sending` with an ETag-conditional
 * write, so two approvals racing produce one broadcast. `{ claim }` — the
 * issue, the claimed document, and `settle`, which writes an outcome only
 * while the issue is still this claim (settleClaim) — or `{ response }`.
 */
async function claimApproval({ store, now }, issue, auth, context) {
  const approvedAt = now().toISOString();
  const claimed = {
    ...issue,
    status: 'sending',
    approvedAt,
    approvedBy: actorOf(auth),
    lastError: null,
    updatedAt: approvedAt,
  };
  try {
    await store.replaceDocIfMatch('newsletters', claimed);
  } catch (error) {
    if (error?.code === 412) return { response: changedElsewhere() };
    context.error?.(
      `approveNewsletter claim failed ${invocationRef(context)}: ${errorMeta(error)}`
    );
    return { response: json(500, { ok: false, error: 'Failed to approve the newsletter issue' }) };
  }
  return {
    claim: { issue, claimed, settle: (next) => settleClaim(store, issue.id, approvedAt, next) },
  };
}

/**
 * A refused broadcast: the issue back to `draft` with the reason. `reason`
 * reaches the issue and the page; `logSummary` is all that is logged.
 */
async function revertClaim({ now }, claim, reason, logSummary, context) {
  const ref = invocationRef(context);
  context.error?.(`approveNewsletter not sent ${ref}: ${logSummary}`);
  await claim
    .settle({
      ...claim.claimed,
      status: 'draft',
      // Not approved after all: nothing was scheduled, so the issue must not
      // read as approved in the list or the preview.
      approvedAt: null,
      approvedBy: null,
      lastError: reason,
      updatedAt: now().toISOString(),
    })
    .catch((error) =>
      context.error?.(`approveNewsletter could not revert ${ref}: ${errorMeta(error)}`)
    );
  return json(502, { ok: false, error: `Resend did not accept the newsletter: ${reason}` });
}

/**
 * No answer at all (timeout, connection reset): Resend may have accepted
 * the broadcast. Returning to draft would invite a second approval and a
 * second send, so the issue stays `sending` for the owner to check.
 */
async function recordNoAnswer({ now }, claim, context) {
  const ref = invocationRef(context);
  context.error?.(`approveNewsletter no answer from Resend ${ref}`);
  await claim
    .settle({
      ...claim.claimed,
      lastError: 'No answer from Resend; it may or may not have accepted the broadcast.',
      updatedAt: now().toISOString(),
    })
    .catch((error) =>
      context.error?.(`approveNewsletter could not record ${ref}: ${errorMeta(error)}`)
    );
  return json(502, {
    ok: false,
    code: 'SEND_OUTCOME_UNKNOWN',
    error:
      "Resend did not answer, so it may have accepted the newsletter. Check Resend's Broadcasts list before anything else; reject this issue here only once you have.",
  });
}

/**
 * The broadcast exists; the record of it did not save. Say so rather than
 * report a failure that would invite a second approval: the same shape as
 * every other success (issue, preview, sendPlan...), plus `warning`, so a
 * caller handles one payload. The issue is re-read so it shows `sending`,
 * which offers no second approval; the claim stands in if even that read
 * fails.
 */
async function sentButUnrecorded(
  { store, present },
  claim,
  { settings, broadcastId, error },
  context
) {
  const ref = invocationRef(context);
  context.error?.(`approveNewsletter sent but not recorded ${ref}: ${errorMeta(error)}`);
  let latest = claim.claimed;
  try {
    latest = (await store.readDoc('newsletters', claim.issue.id, claim.issue.id)) ?? claim.claimed;
  } catch (readError) {
    context.error?.(`approveNewsletter re-read failed ${ref}: ${errorMeta(readError)}`);
  }
  return json(200, {
    ...(await present(latest, settings, context)),
    warning: `Resend accepted broadcast ${broadcastId}, but the site could not record it. Do not approve again.`,
  });
}

/** An accepted broadcast written to the issue as `scheduled` (or `sent`), and the issue presented. */
async function recordBroadcast(ctx, claim, { settings, plan, broadcastId }, context) {
  const { now, present } = ctx;
  const done = {
    ...claim.claimed,
    status: plan.sendNow ? 'sent' : 'scheduled',
    broadcastId,
    ...(plan.sendNow ? { sentAt: now().toISOString() } : { scheduledAt: plan.scheduledAt }),
    updatedAt: now().toISOString(),
  };
  let outcome;
  try {
    outcome = await claim.settle(done);
  } catch (error) {
    return sentButUnrecorded(ctx, claim, { settings, broadcastId, error }, context);
  }
  if (!outcome.written) {
    // Rejected (or otherwise changed) while Resend was being asked. The
    // broadcast exists and the owner's reject stands, so the only honest
    // answer names the broadcast and what to do about it.
    context.error?.(
      `approveNewsletter broadcast created but issue changed to ${outcome.current?.status ?? 'unknown'} meanwhile ${invocationRef(context)}`
    );
    return json(409, {
      ok: false,
      code: 'CHANGED_DURING_SEND',
      broadcastId,
      error: `Resend accepted broadcast ${broadcastId}, but this issue was changed while it was being sent. If it should not go out, cancel it in Resend's Broadcasts page.`,
    });
  }
  context.log?.(`approveNewsletter ${done.status} ${invocationRef(context)}`);
  return json(200, await present(outcome.doc, settings, context));
}

/** The claim taken to Resend: the segment, the broadcast, and the outcome written back. */
async function broadcastClaim(ctx, claim, { apiKey, settings, plan, rendered }, context) {
  const client = createResendClient({ apiKey, fetch: ctx.fetchImpl });
  let segmentId;
  try {
    segmentId = await resolveSegmentId(client);
  } catch (error) {
    return revertClaim(ctx, claim, `the audience could not be read (${errorMeta(error)})`, errorMeta(error), context);
  }
  const created = await client.createBroadcast({
    segmentId,
    from: await ctx.fromAddress(context),
    replyTo: settings.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    name: `HybridCloudWorks Weekly ${claim.issue.id.slice('issue-'.length)}`,
    scheduledAt: plan.sendNow ? undefined : plan.scheduledAt,
  });
  if (created.status === 0) return recordNoAnswer(ctx, claim, context);
  if (!created.ok || !created.data?.id) {
    return revertClaim(ctx, claim, describeForOwner(created), describeForLog(created), context);
  }
  return recordBroadcast(ctx, claim, { settings, plan, broadcastId: created.data.id }, context);
}

/**
 * Schedule (or send) a draft through Resend: the header's "An issue can be
 * sent at most once, and only as the approver saw it". The owner's switch
 * comes first: while it is off, nothing is read, claimed or sent.
 */
async function approve(ctx, request, context) {
  const opened = await openSend(ctx, request, context, {
    role: 'publisher',
    label: 'approveNewsletter',
    gate: () => sendingSwitchedOff(ctx),
  });
  if (opened.response) return opened.response;
  const { auth, body, apiKey, settings, issue } = opened;
  const prepared = await prepareApproval(ctx, { body, settings, issue }, context);
  if (prepared.response) return prepared.response;
  const claimed = await claimApproval(ctx, issue, auth, context);
  if (claimed.response) return claimed.response;
  return broadcastClaim(ctx, claimed.claim, { apiKey, settings, ...prepared }, context);
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, queryDocs: Function, upsertDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {() => Date} [deps.now]
 * @param {{ generateDraft: Function } | null} [deps.drafter] the builder's drafter; null refuses the AI routes
 * @param {ReturnType<import('./template-source.js').createTemplateCache>} [deps.templateCache]
 * @param {number} [deps.aiBudgetMs] the AI routes' time budget; injected for tests
 */
export function createNewsletterAdminHandlers({
  guard,
  store,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  drafter = null,
  templateCache = sharedTemplateCache,
  aiBudgetMs = NEWSLETTER_AI_BUDGET_MS,
}) {
  async function readSettings() {
    const doc = await store.readDoc(
      'admin_config',
      NEWSLETTER_SETTINGS_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
    return presentSetting('newsletter-settings', doc).value;
  }

  const readIssue = (request) => readIssueDoc(store, request);

  /** A Resend client, or null without the key. Reads that reconcile use it; nothing else does. */
  const clientOrNull = () => {
    const apiKey = readKey(env, 'RESEND_API_KEY');
    return apiKey ? createResendClient({ apiKey, fetch: fetchImpl }) : null;
  };

  /** Where this send comes from: the owner's sender, or the default (sender.js). */
  const fromAddress = (context) => resolveFromAddress(store, context);

  // Terraform's newsletter_sending_enabled. Anything but the exact string
  // "true" is off, so a missing or mistyped setting cannot send.
  const sendingEnabled = () => env?.NEWSLETTER_SENDING_ENABLED === 'true';

  /** The issue in the chosen design (renderChosenDesign), with this factory's template source. */
  const render = (issue, renderSettings, settings, context) =>
    renderChosenDesign({ env, fetchImpl, templateCache }, issue, renderSettings, settings, context);

  /** An issue as the page receives it (presentIssue), rendered through `render`. */
  const present = (issue, settings, context) =>
    presentIssue({ render, now, sendingEnabled, fromAddress }, issue, settings, context);

  // cancel, reschedule and retry live in issue-actions.js (PR #841); they
  // read, render and present an issue through the same functions as the
  // routes below.
  const actions = createIssueActions({
    guard,
    store,
    now,
    readIssue,
    readSettings,
    present,
    renderChosenDesign: render,
    clientOrNull,
    fromAddress,
  });

  /**
   * What the routes hoisted out of this factory (`update`, `intro`, `test`,
   * `approve`, the reads' reconciles) need from it: the dependencies and the
   * shared readers.
   */
  const ctx = {
    guard,
    store,
    env,
    fetchImpl,
    now,
    clientOrNull,
    readSettings,
    readIssue,
    renderChosenDesign: render,
    present,
    fromAddress,
    sendingEnabled,
    drafter,
    aiBudgetMs,
  };

  return {
    list: (request, context) => list(ctx, request, context),

    get: (request, context) => get(ctx, request, context),

    update: (request, context) => update(ctx, request, context),

    intro: (request, context) => intro(ctx, request, context),

    subjects: (request, context) => subjects(ctx, request, context),

    test: (request, context) => test(ctx, request, context),

    approve: (request, context) => approve(ctx, request, context),

    /**
     * Cancel a scheduled broadcast. Resend's cancel is `DELETE /broadcasts/{id}`
     * for a `scheduled` one; a refusal comes back with Resend's own sentence,
     * because the plan or the state is what it names. On success the issue
     * is a kept draft again, approvable afresh, with the cancellation recorded.
     */
    cancel: actions.cancel,

    /**
     * Move a scheduled broadcast. Resend's update does not take a new
     * `scheduled_at`, so this is a cancel and a fresh broadcast with the same
     * rendered content: the old one is deleted first, and if the new one is
     * refused the issue returns to a draft with the reason rather than
     * standing scheduled against a broadcast that no longer exists.
     */
    reschedule: actions.reschedule,

    /**
     * A failed issue back to a kept draft, so it can be approved again. The
     * failure stays in `lastError` for the page to show until the next
     * approval clears it.
     */
    retry: actions.retry,

    duplicate: (request, context) => duplicate(ctx, request, context),

    reconcile: (request, context) => reconcile(ctx, request, context),

    getSender: (request, context) => getSender(ctx, request, context),

    putSender: (request, context) => putSender(ctx, request, context),

    save: (request, context) => save(ctx, request, context),

    remove: (request, context) => remove(ctx, request, context),

    reject: (request, context) => reject(ctx, request, context),
  };
}
