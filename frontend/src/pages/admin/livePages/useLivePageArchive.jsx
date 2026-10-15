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
 */
import React, { useCallback, useState } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/components/ui/use-toast';
import { useContentTransitions } from '@/pages/admin/queue/useContentTransitions';
import { ARCHIVED_STATUS } from '@/pages/admin/editor-list/editorItems';
import { getTitle, liveUrlKey } from './liveItems';

/** How long the Undo stays offered. use-toast.js caps a duration at 30 s. */
export const UNDO_WINDOW_MS = 10_000;

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
      const targetId = archiveTargetId(item);
      if (!targetId) return null;
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
    canArchive: (item) => Boolean(archiveTargetId(item)),
  };
}
