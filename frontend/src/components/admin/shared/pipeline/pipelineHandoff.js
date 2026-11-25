/**
 * Sending work from any admin Page into the Pipeline, and reading it back
 * (#1886).
 *
 * The Pipeline does the drafting, review, scheduling and publishing; a Page
 * only starts a piece and lists the pieces it started. Both go through the
 * routes the Pipeline already has:
 *
 *   start   POST cms/drafts { fields, originRef }: a normal draft on the Drafts
 *           page, with `originRef` checked by the server against the record it
 *           names (functions/src/lib/page-links/origin-ref.js)
 *   list    GET cms/content?originPage=&originId=: every piece that Page sent
 *           for that record, at whatever stage it is now
 *
 * No state is kept here: what stage a piece is at is the content record's own
 * status, read fresh, so the two Pages cannot disagree.
 */
import { getJSON, postJSON } from '@/lib/api';

/** How many pieces a Page lists for one record (the list route allows up to 500). */
export const MAX_PIECES = 100;

/** The Drafts page with one draft open. */
export const draftPath = (id) => `/admin/drafts?draft=${encodeURIComponent(id)}`;

/**
 * Start a draft for a record on a Page. Resolves to the new draft's id, or
 * throws with the server's own sentence (a missing program, a title too long).
 *
 * @param {{ originRef: { page: string, id: string, part?: string|null }, title: string, tags?: string[] }} input
 * @returns {Promise<string>}
 */
export async function startDraftFor({ originRef, title, tags = [] }) {
  const trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Give the piece a working title first.');
  const created = await postJSON('cms/drafts', {
    fields: { title: trimmed, tags },
    originRef: {
      page: originRef.page,
      id: originRef.id,
      ...(originRef.part ? { part: originRef.part } : {}),
    },
  });
  const id = created?.draft?.id;
  if (!created?.ok || !id) throw new Error(created?.error || 'The draft was not created.');
  return id;
}

/**
 * Every piece a Page sent for one record, newest change first.
 *
 * @param {{ page: string, id: string }} ref
 * @returns {Promise<object[]>}
 */
export async function loadPiecesFor({ page, id }) {
  const query = new URLSearchParams({
    originPage: page,
    originId: id,
    sort: 'updatedAt',
    limit: String(MAX_PIECES),
  });
  const res = await getJSON(`cms/content?${query}`);
  return Array.isArray(res?.items) ? res.items : [];
}
