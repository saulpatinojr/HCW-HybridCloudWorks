import { postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';
import { getDestinationUrl, resolveBlogProvider } from './editorDocModel';

// The server calls behind useEditorState's save and publish buttons.

/**
 * Sends the editor's fields to `saveEditorDraft`. Returns the server's reply
 * and the draft as sent (with the TL;DR section moved to the end).
 */
export async function saveDraft({ blogId, fields, expectedEditedAtMs, force, orderedImageUrls }) {
  const { draft, title, authorName, publishedDate, summary, tags, sidebarContent } = fields;
  const normalizedDraft = ensureTldrSectionAtEnd(draft);
  const response = await postJSON('saveEditorDraft', {
    contentId: blogId,
    expectedEditedAtMs,
    force,
    draft: normalizedDraft,
    title,
    authorName,
    publishedDate,
    summary,
    tags,
    sidebarContent,
    orderedImageUrls,
  });
  return { response, normalizedDraft };
}

/** A live item is republished from the editor so the public page stays in sync. */
export async function republishLive({ blog, blogId, setPublishDebug }) {
  const status = String(blog?.contentStatus || '');
  const publishTarget = blog?.publishTarget || blog?.type || null;
  const republishResult = await postJSON('publishContent', {
    contentIds: [blogId],
    publishTarget,
    cloudProvider: resolveBlogProvider(blog),
    landingProvider: blog?.landingProvider || null,
    markLive: true,
    createSlugPageTrigger: true,
    addToCurated: true,
  });

  const mapping =
    Array.isArray(republishResult?.mappings) &&
    republishResult.mappings.find((entry) => entry.contentId === blogId);

  setPublishDebug({
    mode: 'live-republish',
    from: status || null,
    to: 'published',
    contentId: blogId,
    note: 'This live item was republished from the editor so the public page stays in sync.',
    expectedPublicUrl: mapping?.expectedPublicUrl || getDestinationUrl(blog) || null,
  });

  await logAdminAction('content_live_saved_from_editor', {
    contentId: blogId,
    status,
    republished: true,
  });
}

/**
 * Move the item to the queue status the editor's publish chose, through
 * the shared transition, which audits it; live publishing stays on
 * /admin/publish, so the editor goes there.
 */
export async function transitionToQueue({ blogId, targetStatus, setPublishDebug, navigate }) {
  const result = await postJSON('transitionContentStatus', {
    contentId: blogId,
    newStatus: targetStatus,
    reviewNotes: `Published from editor as ${targetStatus.replace(/_/g, ' ')}`,
  });

  setPublishDebug({
    mode: 'queue-transition',
    from: result?.from || null,
    to: result?.to || targetStatus,
    contentId: result?.contentId || blogId,
    note: 'Status transitioned from editor. Final live publishing still occurs from /admin/publish.',
  });

  // transitionContentStatus writes the `audits` row itself; the client
  // copy that doubled it is gone (ADR 0033 §1).
  navigate('/admin/publish');
}
