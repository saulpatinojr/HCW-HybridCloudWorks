/**
 * admin-patch.js — checking an issue edit field by field, and presenting an
 * issue to the page: rendered in the chosen design, with its send plan
 * (admin-handlers.js holds the routes).
 */
import { MAX_CUSTOM_NOTE_LENGTH, MAX_SUBJECT_LENGTH, MAX_PREHEADER_LENGTH, planFor, ADDRESS_NOT_SET, pick, SUMMARY_FIELDS, summariseVersion, TEST_SEND_INTERVAL_MS } from './admin-issue-store.js';
import { BUILT_IN_TEMPLATE_ID, missingForSending } from './settings.js';
import { renderIssue } from './render.js';
import { loadTemplateHtml } from './template-source.js';
import { readKey } from '../ai/router.js';
import { renderIssueInTemplate } from './template-layout.js';
import { reconcilable, reconcileIssue } from './reconcile.js';
import { errorMeta, json } from './admin-responses.js';

// ── PATCH fields: each normaliser answers `{ value }` or `{ error }` ─────────

export function normalizeCustomNote(raw) {
  if (typeof raw !== 'string') return { error: 'customNote must be a string' };
  const note = raw.replace(/\r\n/g, '\n').trim();
  if (note.length > MAX_CUSTOM_NOTE_LENGTH) {
    return { error: `customNote must be at most ${MAX_CUSTOM_NOTE_LENGTH} characters` };
  }
  return { value: note };
}

export function normalizeSubject(raw) {
  const subject = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return { error: `subject must be 1 to ${MAX_SUBJECT_LENGTH} characters` };
  }
  return { value: subject };
}

/** One line in an inbox list, so whitespace collapses like the subject's. */
export function normalizePreheader(raw) {
  if (typeof raw !== 'string') return { error: 'preheader must be a string' };
  const preheader = raw.replace(/\s+/g, ' ').trim();
  if (preheader.length > MAX_PREHEADER_LENGTH) {
    return { error: `preheader must be at most ${MAX_PREHEADER_LENGTH} characters` };
  }
  return { value: preheader };
}

/** A per-issue send time (ADR 0033): null (or '') clears it back to the settings slot. */
export function normalizeSendAt(raw, now) {
  if (raw === null || raw === '') return { value: null };
  const when = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(when)) return { error: 'sendAt must be an ISO instant or null' };
  if (when <= now().getTime()) return { error: 'sendAt must be in the future' };
  return { value: new Date(when).toISOString() };
}

/** In the order their errors are reported. `sections` is checked against the stored issue, later. */
export const PATCH_NORMALIZERS = [
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
export async function renderChosenDesign(
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
export function planOrNull(issue, settings, at) {
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
export async function presentIssue(
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
export async function reconcileForRead({ store, now, clientOrNull }, issue, context) {
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
export function testRateLimit(doc, at) {
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
export async function settleClaim(store, issueId, approvedAt, next) {
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

