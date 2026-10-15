/**
 * Archive a live page, with ten seconds to change your mind (AP-F13, #937).
 *
 * Until 2026-10-15 the row's button was Delete Live Page: one confirm, then
 * `softDeleteLivePage` took the page off the site and stamped it for a
 * cleanup nothing in the API ever ran. Archive is the same first step —
 * `published → archived` through the shared transitions (ADR 0033 §2), so the
 * server writes the audit row and clears every public gate — and the toast it
 * raises carries Undo, the edge back (`archived → published`), for
 * UNDO_WINDOW_MS. After that the page is on the Editor's Archive board, where
 * Restore to live and Delete permanently are explicit.
 *
 * No confirm dialog: the undo is the safety, and a dialog in front of a
 * reversible action trains the hand to click through it. The URL of an
 * archived row is remembered so it leaves the list without a refetch, and
 * comes back the same way when Undo succeeds.
 *
 * Archive needs the publisher role, as the Delete it replaced did: taking a
 * page off the public site is a publisher's action, and the API refuses an
 * editor's `published → archived` (content-update.js), as it refuses the
 * edge back. The refusal is shown under the list like any other.
 *
 * Not every live row can be archived. Live Pages lists every `Live: true`
 * document, and a live page can be in `editing` (sent back to the editor
 * while it stays up) or another status with no edge to `archived`; the API
 * answers that with a 400. So the button is offered only where the
 * transition table has the edge (ARCHIVABLE_STATUSES), and elsewhere it is
 * disabled with a title saying why.
 */
import React, { useCallback, useState } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/components/ui/use-toast';
import { useContentTransitions } from '@/pages/admin/queue/useContentTransitions';
import { ARCHIVED_STATUS } from '@/pages/admin/editor-list/editorItems';
import { contentStatusInfo } from '@/lib/status';
import { getTitle, liveUrlKey } from './liveItems';

/** How long the Undo stays offered. use-toast.js caps a duration at 30 s. */
export const UNDO_WINDOW_MS = 10_000;

/**
 * The contentStatus values the API archives from, as the API reads them:
 * VALID_TRANSITIONS (functions/src/lib/cms/content-status.js) gives
 * `archived` as a next step of `published` and `rejected` only, after the
 * three legacy `published_*` spellings are normalized
 * (content-update-validation.js). Matched exactly, as the server matches
 * them. useLivePageArchive.test.jsx reads the server's table and holds this
 * list to it.
 */
export const ARCHIVABLE_STATUSES = Object.freeze([
  'published',
  'published_blog',
  'published_news',
  'published_both',
  'rejected',
]);

export const NO_CONTENT_RECORD_REASON =
  'A legacy page with no content record cannot be archived here';

/**
 * Why a row cannot be archived, or '' when it can. A legacy blog row is
 * judged by its target, not its own status: the content record behind it is
 * what the transition moves, and its status is not on the row, so the API
 * decides for it as before.
 */
export function archiveBlockedReason(item) {
  if (!archiveTargetId(item)) return NO_CONTENT_RECORD_REASON;
  if (item.__source !== 'content') return '';
  if (ARCHIVABLE_STATUSES.includes(item.contentStatus)) return '';
  const raw = String(item.contentStatus || '');
  const { id, label } = contentStatusInfo(raw);
  // The badge reads `Published` and `published_live` as published; the API
  // does not, and "this one is Published" would contradict itself.
  if (id === 'published' || id === 'rejected') {
    return `This page’s status is written “${raw}”, which Archive does not accept. Open Editor to move it on first.`;
  }
  return `Only a published or rejected page can be archived; this one is ${label}. Open Editor to move it on first.`;
}

/**
 * The content record an archive acts on: the row itself for a content
 * record (that is the document `live=true` listed), the content a legacy
 * blog points at — or nothing, for a legacy page with no content behind it,
 * which the row then cannot archive.
 */
export function archiveTargetId(item) {
  if (item?.__source === 'content') return item.id || '';
  return item?.sourceContentId || item?.publishedContentId || '';
}

export function useLivePageArchive() {
  const transitions = useContentTransitions();
  const [archivingId, setArchivingId] = useState('');
  const [locallyArchivedKeys, setLocallyArchivedKeys] = useState({});

  const remember = useCallback((key, archived) => {
    if (key) setLocallyArchivedKeys((prev) => ({ ...prev, [key]: archived }));
  }, []);

  const undo = useCallback(
    async (item, targetId, handle) => {
      const result = await transitions.transition({ ...item, id: targetId }, 'published', {
        markLive: true,
        reviewNotes: 'Undo: restored to live from Live Pages',
        label: 'Undo',
      });
      if (!result) return;
      handle.dismiss();
      remember(liveUrlKey(item), false);
      toast({ title: 'Back on the site', description: `${getTitle(item)} is live again.` });
    },
    [remember, transitions]
  );

  const archiveLivePage = useCallback(
    async (item) => {
      if (archiveBlockedReason(item)) return null;
      const targetId = archiveTargetId(item);
      setArchivingId(item.id);
      const result = await transitions.transition({ ...item, id: targetId }, ARCHIVED_STATUS, {
        markLive: false,
        reviewNotes: 'Archived from Live Pages',
        label: 'Archive',
      });
      setArchivingId('');
      if (!result) return null;
      remember(liveUrlKey(item), true);
      const handle = toast({
        title: 'Archived',
        description: `${getTitle(item)} is off the site and on the Archive board.`,
        duration: UNDO_WINDOW_MS,
        action: (
          <ToastAction
            altText="Undo and put the page back on the site"
            onClick={() => undo(item, targetId, handle)}
          >
            Undo
          </ToastAction>
        ),
      });
      return result;
    },
    [remember, transitions, undo]
  );

  return {
    archivingId,
    archiveError: Object.values(transitions.errors).find(Boolean) || '',
    locallyArchivedKeys,
    archiveLivePage,
    archiveBlockedReason,
  };
}
