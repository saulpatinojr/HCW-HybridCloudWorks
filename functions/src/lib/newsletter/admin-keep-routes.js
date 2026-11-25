/**
 * admin-keep-routes.js — keeping, deleting and rejecting a newsletter issue
 * (admin-handlers.js builds the routes).
 */
import { issueWrite, isDraft, actorOf, commitIssue } from './admin-route-kit.js';
import { json, changedElsewhere } from './admin-responses.js';
import { DELETABLE, replaceIssueIfMatch, REJECTABLE } from './admin-issue-store.js';

// ── Keep, delete, reject ────────────────────────────────────────────────────

/** Keep a draft: it moves to the Drafts tab. */
export function save(ctx, request, context) {
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
export function remove(ctx, request, context) {
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
export function reject(ctx, request, context) {
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

