/**
 * saveContentSchedule and unscheduleContent (PR #841 split of
 * content-workflow.js; ported from Site-Main cms-functions.js :4866).
 */
import { normalizePublishTarget } from '../cms/publish-targets.js';
import { toValidDate } from '../cms/content-status.js';
import { actor, json, readBody, workflowFailure } from './shared.js';

/**
 * Why a schedule cannot be saved, as the response to send, or null.
 *
 * A live page is refused (#1889): saving a schedule writes `Live: false`, so
 * it would take the page off the public site, and the timer never publishes a
 * page that is live, so keeping `Live` instead would leave a schedule that
 * never fires. The Calendar offers only pages that are not live, but the
 * article review page's schedule card (`useScheduleActions` in
 * frontend/src/components/admin/blog-review/useBlogReviewActions.js) calls
 * this for any article, live ones included, so this refusal is what keeps a
 * live page on the site. Unpublish first, as `unscheduleRefusal` says.
 */
function scheduleRefusal(contentId, validId, contentData) {
  if (!validId) return json(400, { error: 'contentId required' });
  if (!contentData) return json(404, { error: `content ${contentId} not found` });
  if (contentData.Live === true) {
    return json(409, { error: 'This content is live; unpublish it before scheduling it.' });
  }
  return null;
}

/**
 * The schedule a body asks for: `{ scheduledIso: null }` for an instant
 * publish, the future date's ISO otherwise, or the 400 refusing it.
 */
function resolveSchedule(instantPublish, scheduledPublishDate, now) {
  if (instantPublish) return { scheduledIso: null };
  const scheduleDate = toValidDate(scheduledPublishDate);
  if (!scheduleDate) return { error: json(400, { error: 'Valid scheduledPublishDate required' }) };
  if (scheduleDate.getTime() <= now().getTime()) {
    return { error: json(400, { error: 'scheduledPublishDate must be in the future' }) };
  }
  return { scheduledIso: scheduleDate.toISOString() };
}

/** POST /api/saveContentSchedule — source :4866; publisher. */
export async function saveContentSchedule({ guard, store, now }, request, context) {
  const auth = await guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const body = await readBody(request);
    const {
      contentId,
      instantPublish = true,
      scheduledPublishDate = null,
      publishTarget = null,
    } = body;
    const validId = Boolean(contentId) && typeof contentId === 'string';
    const contentData = validId ? await store.readDoc('content', contentId, contentId) : null;
    const refusal = scheduleRefusal(contentId, validId, contentData);
    if (refusal) return refusal;

    const resolvedPublishTarget = normalizePublishTarget(
      publishTarget,
      contentData.publishTarget || contentData.type || contentData.contentType
    );
    const nowIso = now().toISOString();
    // A forge-ready item keeps its status: it is already one click from
    // publishing, and a reschedule from the Calendar must not demote it
    // (ADR 0033 Amplify slice). Everything else is approved by scheduling.
    const keepsStatus = String(contentData.contentStatus || '') === 'forge_ready';
    const schedule = resolveSchedule(instantPublish, scheduledPublishDate, now);
    if (schedule.error) return schedule.error;

    await store.patchDoc('content', contentId, {
      ...(keepsStatus ? {} : { contentStatus: 'approved' }),
      publishTarget: resolvedPublishTarget,
      Live: false,
      updatedAt: nowIso,
      updatedBy: actor(user),
      scheduledPublishDate: schedule.scheduledIso,
    });

    return json(200, {
      success: true,
      contentId,
      instantPublish: Boolean(instantPublish),
      scheduledPublishDate: schedule.scheduledIso,
    });
  } catch (error) {
    return workflowFailure(context, 'saveContentSchedule', error, 'Failed to save schedule');
  }
}

/**
 * Why an unschedule cannot proceed, as the response to send, or null when it
 * can (PR #841). The one 200 here is the idempotent case: nothing scheduled.
 */
function unscheduleRefusal(contentId, validId, contentData) {
  if (!validId) return json(400, { error: 'contentId required' });
  if (!contentData) return json(404, { error: `content ${contentId} not found` });
  if (contentData.Live === true) {
    return json(409, { error: 'This content is live; unpublish it instead of unscheduling it.' });
  }
  if (!contentData.scheduledPublishDate) {
    return json(200, { success: true, contentId, alreadyUnscheduled: true });
  }
  return null;
}

/**
 * POST /api/unscheduleContent — publisher (ADR 0033 Amplify slice). Clears
 * the schedule and nothing else: the status stays, so an approved item
 * returns to the Calendar's Unscheduled panel rather than to review.
 */
export async function unscheduleContent({ guard, store, now }, request, context) {
  const auth = await guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const { user } = auth;
  try {
    const { contentId } = await readBody(request);
    const validId = Boolean(contentId) && typeof contentId === 'string';
    const contentData = validId ? await store.readDoc('content', contentId, contentId) : null;
    const refusal = unscheduleRefusal(contentId, validId, contentData);
    if (refusal) return refusal;
    await store.patchDoc('content', contentId, {
      scheduledPublishDate: null,
      updatedAt: now().toISOString(),
      updatedBy: actor(user),
    });
    return json(200, {
      success: true,
      contentId,
      previousScheduledPublishDate: contentData.scheduledPublishDate,
    });
  } catch (error) {
    return workflowFailure(context, 'unscheduleContent', error, 'Failed to unschedule content');
  }
}
