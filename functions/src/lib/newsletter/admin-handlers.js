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
import { startBudgetClock } from '../ai/time-budget.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { presentSetting } from '../platform-settings.js';
import { createResendClient } from './resend-client.js';
import { resolveSegmentId } from './handlers.js';
import { ISSUE_ID_PATTERN, describeAiError, draftIntro, suggestSubjects } from './issue.js';
import { reconcileIssue, reconcileIssues, reconcilable, overdue } from './reconcile.js';
import { renderIssue } from './render.js';
import { resolveSendTime } from './schedule.js';
import { applySectionEdit } from './section-edit.js';
import { createIssueActions } from './issue-actions.js';
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
import { parseSenderBody } from './validate.js';
import {
  NEWSLETTER_SENDER_CONFIG_ID,
  checkSendingDomain,
  parseFromAddress,
  presentSender,
  resolveFromAddress,
} from './sender.js';
import {
  BUILT_IN_TEMPLATE_ID,
  NEWSLETTER_SETTINGS_CONFIG_ID,
  missingForSending,
} from './settings.js';
import { renderIssueInTemplate } from './template-layout.js';
import { loadTemplateHtml, sharedTemplateCache } from './template-source.js';

// Section editing lives in section-edit.js since PR #841; re-exported so the
// route tests and any caller keep one import.
export { applySectionEdit, normalizeManualItem } from './section-edit.js';

export const MAX_CUSTOM_NOTE_LENGTH = 2000;
export const MAX_SUBJECT_LENGTH = 120;
export const MAX_PREHEADER_LENGTH = 150;
/** One test email per issue per this long. */
export const TEST_SEND_INTERVAL_MS = 60 * 1000;

const EDITABLE_FIELDS = ['customNote', 'subject', 'preheader', 'sections', 'sendAt', 'etag'];
const LIST_LIMIT = 50;
const PUBLISHED_LIMIT = 100;
/** How many versions an issue remembers (ADR 0033): the last ten saves. */
export const MAX_VERSIONS = 10;
/** Overdue scheduled issues a list read asks Resend about, at most. */
const LIST_RECONCILE_LIMIT = 5;

/** Only these can be deleted: anything else was approved, and Resend has it (a failed one no longer does). */
const DELETABLE = new Set(['draft', 'rejected', 'failed']);
/** A draft, or an issue stuck in `sending` once Resend's Broadcasts list has been checked. */
const REJECTABLE = new Set(['draft', 'sending']);

/** What the preview footer shows before an address is set, so it is obvious. */
const ADDRESS_NOT_SET = '[Postal address not set — add it in Newsletter settings before approving]';

/** Stored fields the page may see. The issue holds nothing private, but a list is a projection. */
const SUMMARY_FIELDS = [
  'id',
  'status',
  'subject',
  'periodStart',
  'periodEnd',
  'itemCount',
  'createdAt',
  'updatedAt',
  'approvedAt',
  'scheduledAt',
  'sentAt',
  'rejectedAt',
  'savedAt',
  'lastError',
  'sendAt',
  'broadcastStatus',
  'reconciledAt',
  'canceledAt',
  'duplicatedFrom',
];

/** The list reads only what it shows, not every issue's sections. */
const SUMMARY_PROJECTION = SUMMARY_FIELDS.map((field) => `c.${field}`).join(', ');

const pick = (doc, fields) =>
  Object.fromEntries(fields.filter((f) => doc[f] !== undefined).map((f) => [f, doc[f]]));

/** A list row: the summary plus the etag, so a card can be deleted without opening it. */
const summarise = (row) => ({
  ...pick(row, SUMMARY_FIELDS),
  etag: row._etag ?? null,
});

/**
 * The `?month=YYYY-MM` window, padded a day each side: the calendar places an
 * issue by the viewer's local date, which can fall in the neighbouring UTC
 * month. The page drops what is outside the month it shows.
 */
function monthWindow(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - day).toISOString(),
    to: new Date(Date.UTC(year, monthNumber, 1) + day).toISOString(),
  };
}

/**
 * When an issue approved (or looked at) at `at` goes out: the issue's own
 * `sendAt` when it is set and still ahead, else the settings slot. An
 * override already in the past is reported, not silently honoured, because
 * Resend refuses a past `scheduled_at`.
 */
export function planFor(issue, settings, at) {
  const override = typeof issue?.sendAt === 'string' ? Date.parse(issue.sendAt) : NaN;
  if (Number.isFinite(override) && override > at.getTime()) {
    return {
      sendNow: false,
      scheduledAt: new Date(override).toISOString(),
      override: true,
    };
  }
  const plan = resolveSendTime(at, settings);
  return Number.isFinite(override) ? { ...plan, overrideExpired: true } : plan;
}

/** The last saved versions, newest first, with the one being replaced in front. */
export function pushVersion(issue, by, at) {
  const snapshot = {
    at,
    by,
    subject: issue.subject ?? '',
    preheader: issue.preheader ?? '',
    customNote: issue.customNote ?? '',
    sections: issue.sections ?? [],
    itemCount: issue.itemCount ?? 0,
  };
  const existing = Array.isArray(issue.versions) ? issue.versions : [];
  return [snapshot, ...existing].slice(0, MAX_VERSIONS);
}

/** A version as the page lists it: no sections, which can be large. */
const summariseVersion = (version) => ({
  at: version.at,
  by: version.by ?? null,
  subject: version.subject ?? '',
  preheader: version.preheader ?? '',
  itemCount:
    version.itemCount ??
    (version.sections || []).reduce((sum, s) => sum + (s.items?.length || 0), 0),
  sectionCount: (version.sections || []).length,
});

/**
 * The AI time budget of the two routes that wait on the drafter: regenerate
 * the intro, and suggest subject lines. It is counted from the moment the
 * handler starts, so the reads before the model call spend from it.
 *
 * Neither route has an entry in the client's timeout table (frontend
 * lib/api.js), so both get its 20 s default. 14 s leaves room for the write
 * and the render that follow a regenerated intro, and for the trip to the
 * browser. Inside it, a slow first provider fails over rather than
 * outliving the page (router.js header, SYNCHRONOUS CALLS HAVE A TIME
 * BUDGET). sync-budgets.test.js pins it against the client default.
 */
export const NEWSLETTER_AI_BUDGET_MS = 14_000;

/**
 * The From address to store for a trimmed `raw` (PUT newsletter-sender): ''
 * returns to the default; anything else must parse and sit on a sending
 * domain — the default's, or one Resend lists as verified. `{ error }` is
 * the 400 to return.
 */
async function resolveSender(raw, client) {
  if (!raw) return { from: '' };
  const parsed = parseFromAddress(raw);
  if (!parsed) {
    return {
      error: json(400, {
        ok: false,
        error: 'from must be an email address, optionally as "Name <address>"',
      }),
    };
  }
  const domain = await checkSendingDomain(parsed.domain, client);
  if (!domain.ok) {
    return { error: json(400, { ok: false, code: 'DOMAIN_NOT_SENDING', error: domain.reason }) };
  }
  return { from: parsed.from };
}

/** The issue the path names, or null: not an id, not found, not an issue, or deleted. */
async function readIssueDoc(store, request) {
  const id = String(request.params?.id ?? '');
  if (!ISSUE_ID_PATTERN.test(id)) return null;
  const doc = await store.readDoc('newsletters', id, id);
  return doc?.kind === 'weekly_issue' && doc.status !== 'deleted' ? doc : null;
}

/**
 * An ETag-conditional write of an issue: `{ doc }` as stored (the document
 * passed, when the store returns nothing), or `{ conflict: true }` when the
 * issue changed since it was read (412). Any other failure throws.
 */
async function replaceIssueIfMatch(store, doc) {
  try {
    return { doc: (await store.replaceDocIfMatch('newsletters', doc)) ?? doc };
  } catch (error) {
    if (error?.code === 412) return { conflict: true };
    throw error;
  }
}

/**
 * The list's lazy reconcile: full documents for the overdue scheduled rows,
 * asked of Resend, and the rows replaced by what came back. Silent without
 * a key. Never throws: a list must not fail because Resend did.
 */
async function reconcileOverdueRows({ store, now, clientOrNull }, rows, context) {
  const client = clientOrNull();
  const at = now();
  const candidates = (rows || [])
    .filter((row) => overdue(row, at) && row.broadcastId !== null)
    .slice(0, LIST_RECONCILE_LIMIT);
  if (!client || candidates.length === 0) return { rows, warnings: [] };
  try {
    const issues = (
      await Promise.all(candidates.map((row) => store.readDoc('newsletters', row.id, row.id)))
    ).filter(Boolean);
    const outcome = await reconcileIssues({
      store,
      client,
      issues,
      now,
      all: true,
      limit: LIST_RECONCILE_LIMIT,
      log: context,
    });
    if (outcome.changed.length === 0) return { rows, warnings: outcome.warnings };
    const refreshed = await Promise.all(
      outcome.changed.map((id) => store.readDoc('newsletters', id, id))
    );
    const byId = new Map(refreshed.filter(Boolean).map((doc) => [doc.id, doc]));
    return {
      rows: rows.map((row) => (byId.has(row.id) ? byId.get(row.id) : row)),
      warnings: outcome.warnings,
    };
  } catch (error) {
    context.warn?.(`listNewsletters reconcile skipped: ${errorMeta(error)}`);
    return { rows, warnings: [] };
  }
}

// ── PATCH fields: each normaliser answers `{ value }` or `{ error }` ─────────

function normalizeCustomNote(raw) {
  if (typeof raw !== 'string') return { error: 'customNote must be a string' };
  const note = raw.replace(/\r\n/g, '\n').trim();
  if (note.length > MAX_CUSTOM_NOTE_LENGTH) {
    return { error: `customNote must be at most ${MAX_CUSTOM_NOTE_LENGTH} characters` };
  }
  return { value: note };
}

function normalizeSubject(raw) {
  const subject = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return { error: `subject must be 1 to ${MAX_SUBJECT_LENGTH} characters` };
  }
  return { value: subject };
}

/** One line in an inbox list, so whitespace collapses like the subject's. */
function normalizePreheader(raw) {
  if (typeof raw !== 'string') return { error: 'preheader must be a string' };
  const preheader = raw.replace(/\s+/g, ' ').trim();
  if (preheader.length > MAX_PREHEADER_LENGTH) {
    return { error: `preheader must be at most ${MAX_PREHEADER_LENGTH} characters` };
  }
  return { value: preheader };
}

/** A per-issue send time (ADR 0033): null (or '') clears it back to the settings slot. */
function normalizeSendAt(raw, now) {
  if (raw === null || raw === '') return { value: null };
  const when = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(when)) return { error: 'sendAt must be an ISO instant or null' };
  if (when <= now().getTime()) return { error: 'sendAt must be in the future' };
  return { value: new Date(when).toISOString() };
}

/** In the order their errors are reported. `sections` is checked against the stored issue, later. */
const PATCH_NORMALIZERS = [
  ['customNote', normalizeCustomNote],
  ['subject', normalizeSubject],
  ['preheader', normalizePreheader],
  ['sendAt', normalizeSendAt],
];

/**
 * The scalar fields of a PATCH body, normalised: `{ patch }` holding only the
 * fields sent, or `{ error }` naming the first one that is not acceptable.
 */
export function parseIssuePatch(body, now) {
  const patch = {};
  for (const [field, normalize] of PATCH_NORMALIZERS) {
    if (body[field] === undefined) continue;
    const result = normalize(body[field], now);
    if (result.error) return { error: result.error };
    patch[field] = result.value;
  }
  return { patch };
}

/**
 * The issue rendered in the design chosen in settings: the built-in one when
 * no template is chosen, else the template, or the built-in one plus
 * `templateProblem` when the template cannot be fetched or used. Never
 * throws for a template problem; the log line carries only its fixed code.
 * `deps` is the factory's { env, fetchImpl, templateCache }.
 */
async function renderChosenDesign(
  { env, fetchImpl, templateCache },
  issue,
  renderSettings,
  settings,
  context
) {
  if (!settings.templateId) {
    templateCache.select(BUILT_IN_TEMPLATE_ID);
    return { ...renderIssue(issue, renderSettings), templateProblem: null };
  }
  const loaded = await loadTemplateHtml({
    templateId: settings.templateId,
    apiKey: readKey(env, 'RESEND_API_KEY'),
    fetch: fetchImpl,
    cache: templateCache,
  });
  const rendered = loaded.problem
    ? {
        ...renderIssue(issue, renderSettings),
        templateProblem: loaded.problem,
      }
    : renderIssueInTemplate(issue, renderSettings, loaded.html);
  if (rendered.templateProblem) {
    context?.warn?.(
      `newsletter template not used [invocation ${context?.invocationId ?? 'unknown'}]: ${rendered.templateProblem.code}`
    );
  }
  return rendered;
}

/** The send plan for the preview, or null when the settings cannot make one. */
function planOrNull(issue, settings, at) {
  try {
    return planFor(issue, settings, at);
  } catch {
    return null;
  }
}

/**
 * An issue as the page receives it: the summary, the editable fields, the
 * preview in the chosen design, and what stands between it and a send.
 * `deps` is the factory's { render, now, sendingEnabled, fromAddress }.
 */
async function presentIssue(
  { render, now, sendingEnabled, fromAddress },
  issue,
  settings,
  context
) {
  const { templateProblem, ...preview } = await render(
    issue,
    { postalAddress: settings.postalAddress || ADDRESS_NOT_SET },
    settings,
    context
  );
  const missing = missingForSending(settings);
  return {
    ok: true,
    issue: {
      ...pick(issue, SUMMARY_FIELDS),
      preheader: issue.preheader ?? '',
      intro: issue.intro ?? '',
      introError: issue.introError ?? null,
      customNote: issue.customNote ?? '',
      sections: issue.sections ?? [],
      problems: issue.problems ?? [],
      broadcastId: issue.broadcastId ?? null,
      sendAt: issue.sendAt ?? null,
      versions: (Array.isArray(issue.versions) ? issue.versions : []).map(summariseVersion),
      // Echo this back as `etag` on PATCH, approve or reject; a stale one is a 409.
      etag: issue._etag ?? null,
    },
    preview,
    readyToSend: missing.length === 0 && !templateProblem,
    missingSettings: missing,
    sendingEnabled: sendingEnabled(),
    sendPlan: planOrNull(issue, settings, now()),
    fromAddress: await fromAddress(context),
    // Set when a template is chosen but the preview is the built-in design.
    templateProblem,
  };
}

/**
 * A read's reconcile: a scheduled issue is asked of Resend before it is
 * shown, so a send that went is never shown as pending (ADR 0033). Silent
 * without a key, and never throws: a read must not fail because Resend did.
 * `{ issue, reconcileWarning }`, the issue as stored afterwards.
 */
async function reconcileForRead({ store, now, clientOrNull }, issue, context) {
  const client = reconcilable(issue) ? clientOrNull() : null;
  if (!client) return { issue, reconcileWarning: null };
  try {
    const outcome = await reconcileIssue({ store, client, issue, now, log: context });
    return { issue: outcome.issue, reconcileWarning: outcome.reason || null };
  } catch (error) {
    context.warn?.(`getNewsletter reconcile skipped: ${errorMeta(error)}`);
    return { issue, reconcileWarning: null };
  }
}

/**
 * The 429 a test send gets inside TEST_SEND_INTERVAL_MS of the issue's last
 * one, or null when a test may go. `at` is the moment being judged.
 */
function testRateLimit(doc, at) {
  const last = Date.parse(doc?.lastTestAt ?? '');
  if (!Number.isFinite(last) || at.getTime() - last >= TEST_SEND_INTERVAL_MS) return null;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((last + TEST_SEND_INTERVAL_MS - at.getTime()) / 1000)
  );
  return json(429, {
    ok: false,
    code: 'TEST_RATE_LIMITED',
    retryAfterSeconds,
    error: `A test of this issue was sent under a minute ago. Try again in ${retryAfterSeconds} seconds.`,
  });
}

/**
 * Write an approval claim's outcome ONLY if the issue is still the claim
 * (`sending`, approved at `approvedAt`). Reject is allowed from `sending` (to
 * clear a stuck send), so an owner can reject while approval is between the
 * claim and Resend's answer; an unconditional write here would silently undo
 * that. The fresh read supplies the ETag the conditional replace needs.
 *
 * @returns {Promise<{ written: true, doc: object } | { written: false, current: object|null }>}
 */
async function settleClaim(store, issueId, approvedAt, next) {
  const current = await store.readDoc('newsletters', issueId, issueId);
  if (current?.status !== 'sending' || current?.approvedAt !== approvedAt) {
    return { written: false, current };
  }
  try {
    const doc = await store.replaceDocIfMatch('newsletters', {
      ...next,
      _etag: current._etag,
    });
    return { written: true, doc: doc ?? next };
  } catch (error) {
    if (error?.code === 412) return { written: false, current: null };
    throw error;
  }
}

// ── The issue routes, hoisted out of the factory (PR #841 quality round) ──
//
// Each takes the factory's `ctx` first. What a route refuses, in what order,
// with which status, body and log line, is what it was inside the factory;
// the steps are only named, so each function below is short enough to read
// whole: a refusal check answers the response to send or null, a step that
// can fail answers `{ value }` or `{ response }`.

/** Who acted, for `savedBy`, `approvedBy`, `deletedBy` and a version's `by`. */
const actorOf = (auth) => auth.user?.oid || auth.user?.sub || null;

const isDraft = (status) => status === 'draft';

const aiNotConfigured = () =>
  json(503, { ok: false, error: 'AI drafting is not configured for newsletters.' });

/** The 409 while the settings cannot send; `before` finishes its sentence. */
const settingsIncomplete = (missing, before) =>
  json(409, {
    ok: false,
    code: 'SETTINGS_INCOMPLETE',
    missingSettings: missing,
    error: `Add the ${missing.join(' and ')} in Newsletter settings before ${before}.`,
  });

/** The reason a write cannot touch `issue` right now, as a response, or null. */
function refuseWrite(issue, body, allowed, refusal) {
  if (!issue) return notFound();
  if (!allowed(issue.status)) return json(409, { ok: false, error: refusal(issue.status) });
  if (staleView(body, issue)) return changedElsewhere();
  return null;
}

/** The default early check of a write: the body must carry the etag. */
const requireEtag = (body) => (missingEtag(body) ? { response: etagRequired() } : { value: null });

/**
 * An issue written back and presented, or the 409 when it changed meanwhile.
 * The STORED document is presented, so the answer carries the new etag.
 */
async function commitIssue(ctx, next, context, settings = null) {
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
 * @param {(error: unknown, context: object) => string} [spec.logFailure] the 500's log line
 * @param {(args: { issue: object, body: object, auth: object, value: any }) => Promise<object>} spec.act
 */
async function issueWrite(ctx, request, context, spec) {
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
    context.error?.(
      spec.logFailure
        ? spec.logFailure(error, context)
        : `${spec.label} failed: ${error?.message ?? error}`
    );
    return json(500, { ok: false, error: spec.failure });
  }
}

/**
 * The reads of a route that answers a failed read with its own 500 rather
 * than a catch-all: the issue, and the settings when asked for.
 * `{ issue, settings }`, or `{ response }`: the 500, or 404 for no issue.
 */
async function readForRoute(ctx, request, label, context, { withSettings = false } = {}) {
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
async function renderOr500(ctx, label, { issue, renderSettings, settings }, context) {
  try {
    return { rendered: await ctx.renderChosenDesign(issue, renderSettings, settings, context) };
  } catch (error) {
    context.error?.(`${label} render failed ${invocationRef(context)}: ${errorMeta(error)}`);
    return { response: json(500, { ok: false, error: 'Failed to render the newsletter issue' }) };
  }
}

// ── PATCH ───────────────────────────────────────────────────────────────────

/**
 * PATCH's early checks, in the order their errors are reported. No body, or
 * not an object, is a write with no etag: the same structured answer reject
 * gives, so a client handles one error shape for both. Then unknown fields,
 * the etag, and the scalar fields. `value` is the patch.
 */
function prepareUpdate(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { response: etagRequired() };
  const unknown = Object.keys(body).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown.length) {
    return { response: json(400, { ok: false, error: `Unknown field(s): ${unknown.join(', ')}` }) };
  }
  if (missingEtag(body)) return { response: etagRequired() };
  const parsed = parseIssuePatch(body, now);
  if (parsed.error) return { response: json(400, { ok: false, error: parsed.error }) };
  return { value: parsed.patch };
}

/**
 * The `sections` edit of a PATCH, checked against the stored issue (the
 * version the etag names): `{ sections, itemCount }` for the patch, `{}`
 * when none was sent, or `{ response }` for an edit that is not allowed.
 */
function sectionsEdit(issue, body) {
  if (body.sections === undefined) return {};
  const edit = applySectionEdit(issue.sections, body.sections);
  if (edit.error) {
    return { response: json(400, { ok: false, code: 'SECTIONS_INVALID', error: edit.error }) };
  }
  return { sections: edit.sections, itemCount: edit.itemCount };
}

function update(ctx, request, context) {
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'updateNewsletter',
    failure: 'Failed to save the newsletter issue',
    allowed: isDraft,
    refusal: (status) => `Only a draft can be edited; this issue is ${status}.`,
    prepare: (body) => prepareUpdate(body, ctx.now),
    act: async ({ issue, body, auth, value: patch }) => {
      const edit = sectionsEdit(issue, body);
      if (edit.response) return edit.response;
      const at = ctx.now().toISOString();
      // The version being replaced goes into history first, so Reset and a
      // later look-back both have what the owner saw before this save.
      const versions = pushVersion(issue, actorOf(auth), at);
      return commitIssue(ctx, { ...issue, ...patch, ...edit, versions, updatedAt: at }, context);
    },
  });
}

// ── The AI routes ───────────────────────────────────────────────────────────

/** An AI write's early checks: the etag, then that a drafter exists. */
function prepareIntro(ctx, body) {
  if (missingEtag(body)) return { response: etagRequired() };
  if (!ctx.drafter) return { response: aiNotConfigured() };
  return { value: null };
}

/** The intro redrafted, or the 502 saying why not: `{ intro }` or `{ response }`. */
async function redraftIntro({ drafter }, issue, settings, budgetLeft, context) {
  let intro;
  try {
    ({ intro } = await draftIntro({
      drafter,
      sections: issue.sections ?? [],
      subject: issue.subject,
      tone: settings.introTone,
      budgetMs: budgetLeft(),
    }));
  } catch (error) {
    context.error?.(
      `regenerateNewsletterIntro AI failed ${invocationRef(context)}: ${errorMeta(error)}`
    );
    return {
      response: json(502, {
        ok: false,
        code: 'AI_FAILED',
        error: `The intro was not regenerated: ${describeAiError(error)}`,
      }),
    };
  }
  if (!intro) {
    return {
      response: json(502, {
        ok: false,
        code: 'AI_FAILED',
        error: 'The intro was not regenerated: the AI returned an empty intro. Try again.',
      }),
    };
  }
  return { intro };
}

/**
 * Regenerate a draft's intro with the builder's own drafter, instruction
 * and saved tone (issue.js draftIntro). Only the intro is written, never the
 * subject, which the owner may have edited. An AI failure writes nothing.
 */
function intro(ctx, request, context) {
  // Counted from the moment the handler starts, so the reads spend from it.
  const budgetLeft = startBudgetClock(ctx.aiBudgetMs);
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'regenerateNewsletterIntro',
    failure: 'Failed to regenerate the intro',
    allowed: isDraft,
    refusal: (status) => `Only a draft's intro can be regenerated; this issue is ${status}.`,
    prepare: (body) => prepareIntro(ctx, body),
    logFailure: (error, log) =>
      `regenerateNewsletterIntro failed ${invocationRef(log)}: ${errorMeta(error)}`,
    act: async ({ issue }) => {
      // The saved tone (Newsletter settings → Content), the same one a build uses.
      const settings = await ctx.readSettings();
      const drafted = await redraftIntro(ctx, issue, settings, budgetLeft, context);
      if (drafted.response) return drafted.response;
      // Conditional on the version read above, so an edit that landed while
      // the model was writing is not overwritten.
      const updated = {
        ...issue,
        intro: drafted.intro,
        introError: null,
        updatedAt: ctx.now().toISOString(),
      };
      return commitIssue(ctx, updated, context, settings);
    },
  });
}

/** The subject lines suggested, or the 502 saying why not. */
async function suggestSubjectLines(drafter, issue, budgetLeft, context) {
  try {
    const subjects = await suggestSubjects({
      drafter,
      sections: issue.sections ?? [],
      subject: issue.subject,
      budgetMs: budgetLeft(),
    });
    return json(200, { ok: true, subjects });
  } catch (error) {
    context.error?.(
      `suggestNewsletterSubjects AI failed ${invocationRef(context)}: ${errorMeta(error)}`
    );
    return json(502, {
      ok: false,
      code: 'AI_FAILED',
      error: `No subject lines were suggested: ${describeAiError(error)}`,
    });
  }
}

/** Subject-line suggestions for the page to offer. Writes nothing, so no etag. */
async function subjects(ctx, request, context) {
  const budgetLeft = startBudgetClock(ctx.aiBudgetMs);
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  if (!ctx.drafter) return aiNotConfigured();
  const loaded = await readForRoute(ctx, request, 'suggestNewsletterSubjects', context);
  if (loaded.response) return loaded.response;
  return suggestSubjectLines(ctx.drafter, loaded.issue, budgetLeft, context);
}

// ── Sending: the test email and the approval ────────────────────────────────

/**
 * The opening a test send and an approval share: the role, the etag, `gate`
 * (approve's sending switch; nothing for a test), the Resend key, then the
 * settings and the issue. `{ auth, body, apiKey, settings, issue }` or
 * `{ response }`.
 */
async function openSend(ctx, request, context, { role, label, gate = () => null }) {
  const auth = await ctx.guard.requireRole(request, role);
  if (auth.error) return { response: auth.error };
  const body = await request.json().catch(() => null);
  if (missingEtag(body)) return { response: etagRequired() };
  const apiKey = readKey(ctx.env, 'RESEND_API_KEY');
  const refused = gate() ?? (apiKey ? null : resendNotConfigured());
  if (refused) return { response: refused };
  const loaded = await readForRoute(ctx, request, label, context, { withSettings: true });
  return loaded.response ? loaded : { ...loaded, auth, body, apiKey };
}

/**
 * What a test send refuses once the issue is read: incomplete settings, an
 * issue that is not a draft, a second test inside the minute — judged before
 * the stale check, so a second press is "too soon" whichever etag it
 * carries — and a stale view. The response, or null.
 */
function refuseTest(settings, issue, body, at) {
  const missing = missingForSending(settings);
  if (missing.length) return settingsIncomplete(missing, 'sending a test');
  if (!isDraft(issue.status)) {
    return json(409, {
      ok: false,
      error: `Only a draft can be test-sent; this issue is ${issue.status}.`,
    });
  }
  return testRateLimit(issue, at) ?? (staleView(body, issue) ? changedElsewhere() : null);
}

/**
 * `lastTestAt` written with an ETag-conditional replace BEFORE Resend is
 * called, so a double click sends once. `{ claimed }` as stored, or
 * `{ response }`: the loser's 429 (or 409 when an edit got there first), or
 * the 500 for any other failure.
 */
async function claimTestSlot({ store }, issue, at, context) {
  try {
    const claimed = await store.replaceDocIfMatch('newsletters', {
      ...issue,
      lastTestAt: at.toISOString(),
    });
    return { claimed };
  } catch (error) {
    if (error?.code !== 412) {
      context.error?.(`testNewsletter claim failed ${invocationRef(context)}: ${errorMeta(error)}`);
      return { response: json(500, { ok: false, error: 'Failed to send the test email' }) };
    }
    // Another test (or an edit) got there first; say which.
    const current = await store.readDoc('newsletters', issue.id, issue.id).catch(() => null);
    return { response: testRateLimit(current, at) ?? changedElsewhere() };
  }
}

/** The one test email, through Resend's single-email endpoint, and its answer. */
async function sendTestEmail(ctx, { apiKey, settings, rendered, claimed }, context) {
  const ref = invocationRef(context);
  const sentTo = settings.replyTo;
  const client = createResendClient({ apiKey, fetch: ctx.fetchImpl });
  const sent = await client.sendEmail({
    from: await ctx.fromAddress(context),
    to: [sentTo],
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });
  const etag = claimed?._etag ?? null;
  const problem = rendered.templateProblem ? { templateProblem: rendered.templateProblem } : {};
  if (!sent.ok) {
    context.error?.(`testNewsletter not sent ${ref}: ${describeForLog(sent)}`);
    return json(502, {
      ok: false,
      etag,
      ...problem,
      error: `Resend did not accept the test email: ${describeForOwner(sent)}`,
    });
  }
  context.log?.(`testNewsletter sent ${ref}`);
  return json(200, { ok: true, sentTo, etag, ...problem });
}

/**
 * Email ONE test copy of a draft to the reply-to address in Newsletter
 * settings.
 *
 * This cannot reach a subscriber, which is why it is NOT gated on
 * NEWSLETTER_SENDING_ENABLED: the recipient is read from settings, never
 * from the request body, and the call is Resend's single-email endpoint,
 * not a broadcast to the segment. Publisher, because it still sends mail
 * from the newsletter's address.
 *
 * One test per issue per minute (claimTestSlot). A refused send still
 * counts toward the minute. The claim changes the issue's etag, so the
 * answer carries the new one for the page to keep editing with.
 */
async function test(ctx, request, context) {
  const opened = await openSend(ctx, request, context, {
    role: 'publisher',
    label: 'testNewsletter',
  });
  if (opened.response) return opened.response;
  const { body, apiKey, settings, issue } = opened;
  const at = ctx.now();
  const refused = refuseTest(settings, issue, body, at);
  if (refused) return refused;
  // In the chosen design; an unusable template falls back to the built-in
  // one for a test, and the answer says so.
  const rendered = await renderOr500(
    ctx,
    'testNewsletter',
    { issue, renderSettings: { postalAddress: settings.postalAddress, testSend: true }, settings },
    context
  );
  if (rendered.response) return rendered.response;
  const claim = await claimTestSlot(ctx, issue, at, context);
  if (claim.response) return claim.response;
  return sendTestEmail(
    ctx,
    { apiKey, settings, rendered: rendered.rendered, claimed: claim.claimed },
    context
  );
}

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

// ── Keep, delete, reject ────────────────────────────────────────────────────

/** Keep a draft: it moves to the Drafts tab. */
function save(ctx, request, context) {
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'saveNewsletter',
    failure: 'Failed to save the issue to Drafts',
    allowed: isDraft,
    refusal: (status) => `Only a draft can be saved to Drafts; this issue is ${status}.`,
    act: async ({ issue, auth }) => {
      // Already saved: nothing to write, and saying so is not an error.
      if (issue.savedAt) {
        return json(200, await ctx.present(issue, await ctx.readSettings(), context));
      }
      const savedAt = ctx.now().toISOString();
      const saved = { ...issue, savedAt, savedBy: actorOf(auth), updatedAt: savedAt };
      return commitIssue(ctx, saved, context);
    },
  });
}

/**
 * Delete a draft, rejected or failed issue: marked `deleted` with an
 * ETag-conditional write rather than removed, so a delete can never race an
 * approval that has already claimed the issue.
 */
function remove(ctx, request, context) {
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'deleteNewsletter',
    failure: 'Failed to delete the newsletter issue',
    allowed: (status) => DELETABLE.has(status),
    refusal: (status) => `A ${status} issue cannot be deleted: it was approved, so Resend has it.`,
    act: async ({ issue, auth }) => {
      const deletedAt = ctx.now().toISOString();
      const written = await replaceIssueIfMatch(ctx.store, {
        ...issue,
        status: 'deleted',
        deletedAt,
        deletedBy: actorOf(auth),
        updatedAt: deletedAt,
      });
      return written.conflict ? changedElsewhere() : json(200, { ok: true, id: issue.id });
    },
  });
}

/**
 * Set aside a draft, or clear a stuck send: an issue in `sending` once
 * Resend's Broadcasts list has been checked. Never one that was scheduled
 * or sent.
 */
function reject(ctx, request, context) {
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'rejectNewsletter',
    failure: 'Failed to reject the newsletter issue',
    allowed: (status) => REJECTABLE.has(status),
    refusal: (status) => `A ${status} issue cannot be rejected.`,
    act: ({ issue }) => {
      const rejectedAt = ctx.now().toISOString();
      const rejected = { ...issue, status: 'rejected', rejectedAt, updatedAt: rejectedAt };
      return commitIssue(ctx, rejected, context);
    },
  });
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
    async list(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const month = request.query?.get?.('month') ?? null;
      if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return json(400, { ok: false, error: 'month must be YYYY-MM' });
      }
      try {
        let rows;
        if (month) {
          // Published: what went out, or will, in that month.
          const { from, to } = monthWindow(month);
          rows = await store.queryDocs(
            'newsletters',
            `SELECT TOP ${PUBLISHED_LIMIT} ${SUMMARY_PROJECTION}, c.broadcastId, c._etag FROM c WHERE c.kind = 'weekly_issue' AND ((c.status = 'sent' AND c.sentAt >= @from AND c.sentAt < @to) OR ((c.status = 'scheduled' OR c.status = 'failed') AND c.scheduledAt >= @from AND c.scheduledAt < @to)) ORDER BY c.createdAt DESC`,
            [
              { name: '@from', value: from },
              { name: '@to', value: to },
            ]
          );
        } else {
          rows = await store.queryDocs(
            'newsletters',
            `SELECT TOP ${LIST_LIMIT} ${SUMMARY_PROJECTION}, c.broadcastId, c._etag FROM c WHERE c.kind = 'weekly_issue' AND c.status != 'deleted' ORDER BY c.createdAt DESC`,
            []
          );
        }
        // Scheduled issues whose time has passed: ask Resend before answering,
        // so the list never shows a send as pending after it went (ADR 0033).
        const reconciled = await reconcileOverdueRows(ctx, rows || [], context);
        return json(200, {
          ok: true,
          issues: reconciled.rows.map(summarise),
          ...(reconciled.warnings.length ? { reconcileWarnings: reconciled.warnings } : {}),
        });
      } catch (error) {
        context.error?.(`listNewsletters failed: ${error?.message ?? error}`);
        return json(500, {
          ok: false,
          error: 'Failed to list newsletter issues',
        });
      }
    },

    async get(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const stored = await readIssue(request);
        if (!stored) return notFound();
        const { issue, reconcileWarning } = await reconcileForRead(ctx, stored, context);
        return json(200, {
          ...(await present(issue, await readSettings(), context)),
          ...(reconcileWarning ? { reconcileWarning } : {}),
        });
      } catch (error) {
        context.error?.(`getNewsletter failed: ${error?.message ?? error}`);
        return json(500, {
          ok: false,
          error: 'Failed to read the newsletter issue',
        });
      }
    },

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

    /**
     * A new kept draft with this issue's subject, preview text, note, intro
     * and sections, under today's id (or a suffixed one when today's is taken).
     * Nothing about the source changes.
     */
    async duplicate(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const source = await readIssue(request);
        if (!source) return notFound();
        const at = now();
        const day = at.toISOString().slice(0, 10);
        let id = `issue-${day}`;
        for (let n = 2; n < 100; n += 1) {
          const taken = await store.readDoc('newsletters', id, id);
          if (!taken || taken.status === 'deleted') break;
          id = `issue-${day}-${n}`;
        }
        const stamp = at.toISOString();
        const doc = {
          id,
          kind: 'weekly_issue',
          version: 1,
          status: 'draft',
          periodStart: source.periodStart ?? null,
          periodEnd: source.periodEnd ?? null,
          subject: source.subject ?? '',
          preheader: source.preheader ?? '',
          intro: source.intro ?? '',
          introError: null,
          customNote: source.customNote ?? '',
          sections: source.sections ?? [],
          itemCount: source.itemCount ?? 0,
          problems: [],
          duplicatedFrom: source.id,
          savedAt: stamp,
          savedBy: auth.user?.oid || auth.user?.sub || null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        await store.upsertDoc('newsletters', doc);
        const stored = (await store.readDoc('newsletters', id, id)) ?? doc;
        return json(200, await present(stored, await readSettings(), context));
      } catch (error) {
        context.error?.(`duplicateNewsletter failed: ${errorMeta(error)}`);
        return json(500, {
          ok: false,
          error: 'Failed to duplicate the newsletter issue',
        });
      }
    },

    /** Ask Resend where every scheduled issue stands, now, and write what it says. */
    async reconcile(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const client = clientOrNull();
      if (!client) return resendNotConfigured();
      try {
        const rows = await store.queryDocs(
          'newsletters',
          `SELECT TOP ${PUBLISHED_LIMIT} * FROM c WHERE c.kind = 'weekly_issue' AND (c.status = 'scheduled' OR c.status = 'sending') AND IS_DEFINED(c.broadcastId)`,
          []
        );
        const outcome = await reconcileIssues({
          store,
          client,
          issues: rows || [],
          now,
          all: true,
          limit: PUBLISHED_LIMIT,
          log: context,
        });
        return json(200, { ok: true, ...outcome });
      } catch (error) {
        context.error?.(`reconcileNewsletters failed: ${errorMeta(error)}`);
        return json(500, {
          ok: false,
          error: 'Failed to reconcile newsletter issues with Resend',
        });
      }
    },

    /** GET /api/cms/newsletter-sender — the From address, and whether it is the default. */
    async getSender(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const doc = await store.readDoc(
          'admin_config',
          NEWSLETTER_SENDER_CONFIG_ID,
          ADMIN_CONFIG_PARTITION
        );
        return json(200, { ok: true, ...presentSender(doc) });
      } catch (error) {
        context.error?.(`getNewsletterSender failed: ${errorMeta(error)}`);
        return json(500, {
          ok: false,
          error: 'Failed to read the newsletter sender',
        });
      }
    },

    /**
     * PUT /api/cms/newsletter-sender { from } — publisher. An empty `from`
     * returns to the default. Any other address must parse and sit on a
     * sending domain: the default's, or one Resend lists as verified.
     */
    async putSender(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      const requested = parseSenderBody(await request.json().catch(() => null));
      if (requested.error) return json(400, { ok: false, error: requested.error });
      try {
        const resolved = await resolveSender(requested.from, clientOrNull());
        if (resolved.error) return resolved.error;
        const doc = {
          id: NEWSLETTER_SENDER_CONFIG_ID,
          configScope: ADMIN_CONFIG_PARTITION,
          from: resolved.from,
          updatedAt: now().toISOString(),
          updatedBy: auth.user?.oid || auth.user?.sub || null,
        };
        await store.upsertDoc('admin_config', doc);
        return json(200, { ok: true, ...presentSender(doc) });
      } catch (error) {
        context.error?.(`putNewsletterSender failed: ${errorMeta(error)}`);
        return json(500, {
          ok: false,
          error: 'Failed to save the newsletter sender',
        });
      }
    },

    save: (request, context) => save(ctx, request, context),

    remove: (request, context) => remove(ctx, request, context),

    reject: (request, context) => reject(ctx, request, context),
  };
}
