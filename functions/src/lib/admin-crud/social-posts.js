/**
 * social-posts.js — the social-post routes of the admin CRUD surface
 * (SocialHubPage.jsx): list filtered to status IN (scheduled, published)
 * newest first (createdAt is sorted in memory — Cosmos ORDER BY drops docs
 * missing the property, same trap as public-reads), create stamps
 * createdAt, edit (ADR 0033 Amplify slice), delete by id. Every route sits
 * behind the editor role guard.
 *
 * Each handler body is a module-level function over `ctx` (guard, store,
 * now, uuid, unpublishSocialPost); the factory at the bottom only wires them.
 */
import { json, LIST_WINDOW, validBody } from '../http/admin-handler.js';
import { recordMutationAudit } from '../audit.js';
import {
  SOCIAL_DEFAULT_STATUSES,
  socialPostEditRefusal,
  validateSocialPostCreate,
  validateSocialPostPatch,
} from './social-post-rules.js';

const createdAtValue = (doc) => {
  const v = doc.createdAt || doc._createdAt || null;
  if (!v) return 0;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

/** The `status` query as a list; the page's defaults when absent. */
function statusesOf(request) {
  const statusParam = String(request.query.get('status') || '').trim();
  if (!statusParam) return SOCIAL_DEFAULT_STATUSES;
  return statusParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GET /api/cms/social-posts?status=a,b&limit= — SocialHubPage list.
 * status=all lists every post regardless of status (CalendarPage reads
 * the unfiltered collection).
 */
async function listSocialPosts(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const statuses = statusesOf(request);
    const limit = Math.min(Math.max(Number(request.query.get('limit')) || 50, 1), 100);

    const unfiltered = statuses.includes('all');
    const items = await ctx.store.queryDocs(
      'social_posts',
      unfiltered
        ? `SELECT TOP ${LIST_WINDOW} * FROM c`
        : `SELECT TOP ${LIST_WINDOW} * FROM c WHERE ARRAY_CONTAINS(@statuses, c.status)`,
      unfiltered ? [] : [{ name: '@statuses', value: statuses }]
    );
    const sorted = items.sort((a, b) => createdAtValue(b) - createdAtValue(a)).slice(0, limit);
    return json(200, {
      success: true,
      items: sorted,
      total: sorted.length,
    });
  } catch (error) {
    context.error('listSocialPosts failed:', error);
    return json(500, { error: 'Failed to list social posts' });
  }
}

/** POST /api/cms/social-posts — create, stamps createdAt (source :273). */
async function createSocialPost(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    if (!body) return json(400, { error: 'Body must be a JSON object' });

    const checked = validateSocialPostCreate(body, ctx.now().getTime());
    if (checked.error) return json(400, { error: checked.error });

    const doc = {
      ...checked.doc,
      id: ctx.uuid(),
      createdAt: ctx.now().toISOString(),
    };
    await ctx.store.upsertDoc('social_posts', doc);
    await recordMutationAudit(ctx.store, {
      action: 'social_post_created',
      actor: auth.user,
      resource: `social_posts:${doc.id}`,
      before: null,
      after: doc,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, id: doc.id, item: doc });
  } catch (error) {
    context.error('createSocialPost failed:', error);
    return json(500, { error: 'Failed to create social post' });
  }
}

/** The stored post an edit applies to, or the refusal (404, 409). */
async function loadEditableSocialPost(store, id, updates) {
  const existing = await store.readDoc('social_posts', id, id);
  if (!existing) return { error: json(404, { error: `social post ${id} not found` }) };
  const refusal = socialPostEditRefusal(existing, updates);
  return refusal ? { error: json(409, { error: refusal }) } : { existing };
}

/** Route id, validated body and the stored post, or the response that refuses the edit. */
async function prepareSocialPostEdit({ store, now }, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body || Object.keys(body).length === 0) {
    return { error: json(400, { error: 'Body must be a non-empty JSON object' }) };
  }
  const checked = validateSocialPostPatch(body, now().getTime());
  if (checked.error) return { error: json(400, { error: checked.error }) };
  const loaded = await loadEditableSocialPost(store, id, checked.updates);
  return loaded.error ? loaded : { id, updates: checked.updates, existing: loaded.existing };
}

/**
 * PATCH /api/cms/social-posts/{id} — edit the caption, URL or time of a
 * post this hub recorded (ADR 0033 Amplify slice: edit + reschedule from
 * the Social Hub and the Calendar). The write is the whole push: the
 * social_posts change feed (lib/triggers/handlers.js socialPosts) sees a
 * changed `caption`/`url`/`scheduledAt` marker with `syncOrigin:
 * 'calendar'` and PUTs the post to Publer for every id it holds. A post
 * Publer has not yet reported ids for is picked up by the next
 * syncSocialCalendar run, and the answer says which.
 */
async function patchSocialPost(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const prepared = await prepareSocialPostEdit(ctx, request);
    if (prepared.error) return prepared.error;
    const { id, updates, existing } = prepared;
    const publerPostIds = Array.isArray(existing.publerPostIds) ? existing.publerPostIds : [];
    const updated = await ctx.store.patchDoc('social_posts', id, {
      ...updates,
      updatedAt: ctx.now().toISOString(),
      updatedBy: auth.user?.email || auth.user?.oid || null,
      // The change feed pushes a calendar-origin edit; a system or publer
      // origin would be skipped as an echo of Publer's own state.
      syncOrigin: 'calendar',
      syncStatus: publerPostIds.length ? 'pending' : existing.syncStatus || 'pending',
    });
    await recordMutationAudit(ctx.store, {
      action: 'social_post_updated',
      actor: auth.user,
      resource: `social_posts:${id}`,
      before: existing,
      after: updated,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, {
      success: true,
      item: updated,
      publer: publerPostIds.length
        ? { push: 'change-feed', postIds: publerPostIds }
        : {
            push: 'next-sync',
            reason: 'Publer has not reported post ids for this record yet',
          },
    });
  } catch (error) {
    context.error('patchSocialPost failed:', error);
    return json(500, { error: 'Failed to update social post' });
  }
}

/** DELETE /api/cms/social-posts/{id} */
async function deleteSocialPost(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    // The `!after` branch of Site-Main's syncSocialPostToPubler: the change
    // feed never delivers a delete, so the Publer un-publish happens here
    // (T-324). Best-effort, before the document goes.
    let publer = { attempted: 0, removed: 0 };
    let existing = null;
    try {
      existing = await ctx.store.readDoc('social_posts', id, id);
    } catch (err) {
      if (err?.statusCode === 404 || err?.code === 404 || err?.code === 'NotFound') {
        existing = null;
      } else {
        throw err;
      }
    }
    if (ctx.unpublishSocialPost && existing) {
      publer = await ctx.unpublishSocialPost(existing);
    }
    await ctx.store.deleteDoc('social_posts', id);
    await recordMutationAudit(ctx.store, {
      action: 'social_post_deleted',
      actor: auth.user,
      resource: `social_posts:${id}`,
      before: existing,
      after: null,
      details: { publer },
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, publer });
  } catch (error) {
    context.error('deleteSocialPost failed:', error);
    return json(500, { error: 'Failed to delete social post' });
  }
}

/**
 * @param {{ guard: object, store: object, now: () => Date, uuid: () => string, unpublishSocialPost: Function|null }} ctx
 */
export function createSocialPostHandlers(ctx) {
  return {
    listSocialPosts: (request, context) => listSocialPosts(ctx, request, context),
    createSocialPost: (request, context) => createSocialPost(ctx, request, context),
    patchSocialPost: (request, context) => patchSocialPost(ctx, request, context),
    deleteSocialPost: (request, context) => deleteSocialPost(ctx, request, context),
  };
}
