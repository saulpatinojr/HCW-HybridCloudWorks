/**
 * blogs.js — the one blog route of the admin CRUD surface.
 *
 * DELETE /api/cms/blogs/{id} — publisher. Site-Main's createSlugPageOnTrigger
 * wrote the curated slug-page fields ONTO the blog document, so removing
 * the slug page is removing the document (T-324, the first of the three
 * deletes the change feed cannot see). Audited.
 */
import { json } from '../http/admin-handler.js';
import { AUDIT_TTL_SECONDS } from '../audit.js';

/** The Change history row a blog delete writes. */
function blogDeletedAudit({ now, uuid }, { user, request, id, existing }) {
  return {
    id: uuid(),
    action: 'blog_deleted',
    userId: user?.oid || user?.sub || null,
    userEmail: user?.email || null,
    timestamp: now().toISOString(),
    ttl: AUDIT_TTL_SECONDS,
    details: {
      blogId: id,
      slug: existing.slug || existing.Slug || null,
      curatedSubpagePath: existing.curatedSubpagePath || null,
    },
    userAgent: request.headers?.get?.('user-agent') || null,
    contentId: existing.sourceContentId || null,
    contentTitle: existing.Title || existing.title || '',
    compliance: {
      schemaVersion: 1,
      detailsSanitized: true,
      identityVerified: true,
      appendOnly: true,
    },
  };
}

async function deleteBlog(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    const existing = await ctx.store.readDoc('blogs', id, id);
    if (!existing) return json(404, { error: `Blog ${id} not found` });
    await ctx.store.deleteDoc('blogs', id, id);
    await ctx.store.upsertDoc(
      'admin_audit_logs',
      blogDeletedAudit(ctx, { user: auth.user, request, id, existing })
    );
    return json(200, { success: true, blogId: id });
  } catch (error) {
    context.error('deleteBlog failed:', error);
    return json(500, { error: 'Failed to delete blog' });
  }
}

/** @param {{ guard: object, store: object, now: () => Date, uuid: () => string }} ctx */
export function createBlogHandlers(ctx) {
  return {
    deleteBlog: (request, context) => deleteBlog(ctx, request, context),
  };
}
