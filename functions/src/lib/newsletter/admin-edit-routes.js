/**
 * admin-edit-routes.js — the issue routes that change a draft's words: the
 * edit (PATCH), the AI intro and the AI subject lines (admin-handlers.js
 * builds the routes).
 */
import { etagRequired, json, missingEtag, invocationRef, errorMeta } from './admin-responses.js';
import { EDITABLE_FIELDS, pushVersion } from './admin-issue-store.js';
import { parseIssuePatch } from './admin-patch.js';
import { applySectionEdit } from './section-edit.js';
import { issueWrite, isDraft, actorOf, commitIssue, aiNotConfigured, readForRoute } from './admin-route-kit.js';
import { draftIntro, describeAiError, suggestSubjects } from './issue.js';
import { startBudgetClock } from '../ai/time-budget.js';

// ── PATCH ───────────────────────────────────────────────────────────────────

/**
 * PATCH's early checks, in the order their errors are reported. No body, or
 * not an object, is a write with no etag: the same structured answer reject
 * gives, so a client handles one error shape for both. Then unknown fields,
 * the etag, and the scalar fields. `value` is the patch.
 */
export function prepareUpdate(body, now) {
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
export function sectionsEdit(issue, body) {
  if (body.sections === undefined) return {};
  const edit = applySectionEdit(issue.sections, body.sections);
  if (edit.error) {
    return { response: json(400, { ok: false, code: 'SECTIONS_INVALID', error: edit.error }) };
  }
  return { sections: edit.sections, itemCount: edit.itemCount };
}

export function update(ctx, request, context) {
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
export function prepareIntro(ctx, body) {
  if (missingEtag(body)) return { response: etagRequired() };
  if (!ctx.drafter) return { response: aiNotConfigured() };
  return { value: null };
}

/** The intro redrafted, or the 502 saying why not: `{ intro }` or `{ response }`. */
export async function redraftIntro({ drafter }, issue, settings, budgetLeft, context) {
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
export function intro(ctx, request, context) {
  // Counted from the moment the handler starts, so the reads spend from it.
  const budgetLeft = startBudgetClock(ctx.aiBudgetMs);
  return issueWrite(ctx, request, context, {
    role: 'editor',
    label: 'regenerateNewsletterIntro',
    failure: 'Failed to regenerate the intro',
    allowed: isDraft,
    refusal: (status) => `Only a draft's intro can be regenerated; this issue is ${status}.`,
    prepare: (body) => prepareIntro(ctx, body),
    logLabel: (log) => `regenerateNewsletterIntro failed ${invocationRef(log)}`,
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
export async function suggestSubjectLines(drafter, issue, budgetLeft, context) {
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
export async function subjects(ctx, request, context) {
  const budgetLeft = startBudgetClock(ctx.aiBudgetMs);
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  if (!ctx.drafter) return aiNotConfigured();
  const loaded = await readForRoute(ctx, request, 'suggestNewsletterSubjects', context);
  if (loaded.response) return loaded.response;
  return suggestSubjectLines(ctx.drafter, loaded.issue, budgetLeft, context);
}

