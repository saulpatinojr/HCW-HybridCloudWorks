/**
 * Every mutating action the review queue can take, and the state that tracks
 * them.
 *
 * Extracted from QueuePage.jsx (T-412). This is the page's riskiest
 * code — the bulk paths transition many documents one at a time and each
 * partial failure has to be attributed back to its own card — so isolating it
 * means it can be exercised without rendering four hundred lines of card
 * markup.
 *
 * Three shapes of state live here:
 *
 *  - per-item, keyed by content id: `actionLoading` and `actionError`, so one
 *    card can be spinning or showing a failure without touching its neighbours;
 *  - per-bulk-run: the two in-flight flags and the result banner;
 *  - the confirm-target state machine, which is what the modal reads. Every
 *    destructive path routes through it rather than acting on click.
 *
 * The bulk runs deliberately do not stop on the first failure. They collect
 * failures, remove only the documents that actually transitioned, and write
 * each failure back into `actionError` under its own id — so a run of 40 with
 * 3 failures leaves exactly those 3 on screen with a reason each.
 *
 * Items are mutated optimistically rather than refetched, which is why
 * `setItems` is a parameter.
 *
 * The status moves themselves — approve, reject, restore — are
 * useContentTransitions (ADR 0033 §2), the one copy every review surface
 * uses; this hook adds the queue's selection, confirmation and bulk
 * bookkeeping around it. The server records each transition in `audits`, so
 * no client audit row is written for them; the client-only actions (forge
 * enqueue, bulk soft-delete, permanent delete) still log their own.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { requestContentInspection } from '@/lib/contentWorkflow';
import { getPublishTargetForItem } from '@/lib/contentModel';
import { useContentTransitions } from './useContentTransitions';
import { enqueueForgeBatches, forgeFailureMessage, forgeQueuedMessage } from './forgeSelected';

export { FORGE_MAX_BATCH } from './forgeSelected';

/** `prev` with `id` toggled: removed when present, added when not. */
export function toggleId(prev, id) {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Header select-all over the ids currently on screen: everything visible
 * selected → clear, anything unselected → select all visible.
 */
export function toggleAllIds(prev, visibleIds) {
  const ids = (visibleIds || []).filter(Boolean);
  const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
  return allSelected ? new Set() : new Set(ids);
}

/** The selected ids that are still on screen; a stale selection acts on nothing. */
export function selectedOnScreen(selectedIds, items) {
  return Array.from(selectedIds).filter((id) => items.some((it) => it.id === id));
}

/** Two per-item maps as one: a value in `b` wins unless it is null/undefined. */
function mergeItemMaps(a, b) {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value !== null && value !== undefined) merged[key] = value;
    else if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

/** The banner after a bulk reject: how many went, and how many are left with a reason. */
function bulkRejectMessage(successCount, failureCount) {
  return `Rejected ${successCount} item${successCount === 1 ? '' : 's'}.${
    failureCount ? ` ${failureCount} failed — see red error under each remaining card.` : ''
  }`;
}

/**
 * Soft-deletes every rejected item, a hundred per request, until the server
 * says there are no more (or deleted none on the last pass). Resolves the count.
 */
async function deleteAllRejected() {
  let deletedCount = 0;
  let hasMore = false;

  do {
    const result = await postJSON('deleteRejectedContent', { limit: 100 });
    deletedCount += result.deletedCount || 0;
    hasMore = result.hasMore === true && (result.deletedCount || 0) > 0;
  } while (hasMore);
  return deletedCount;
}

/** Asks for a new hero image; resolves its address or throws the reason. */
async function generateHeroImage(contentId) {
  const result = await postJSON('generateReviewHeroImage', { contentId });
  if (!result?.success) {
    throw new Error(result?.error || 'Image generation failed');
  }
  return result.imageUrl;
}

/** `items` with the new hero image on the one card it was made for. */
const withHeroImage = (contentId, imageUrl) => (prev) =>
  prev.map((item) =>
    item.id === contentId
      ? {
          ...item,
          altCoverImage: imageUrl,
          __regenAt: Date.now(),
        }
      : item
  );

/**
 * "Forge Selected" (Blog Machine T-603): the checked documents, enqueued in
 * chunks by forgeSelected.js; this is the state around that run.
 * `pickIds()` reads the selection still on screen; `clearSelection()` empties it.
 */
function useForgeSelected(pickIds, clearSelection) {
  const [forgingSelected, setForgingSelected] = useState(false);
  const [forgeMessage, setForgeMessage] = useState(null);
  const [forgeError, setForgeError] = useState(null);

  const handleForgeSelected = async () => {
    const ids = pickIds();
    if (ids.length === 0) return;
    setForgingSelected(true);
    setForgeError(null);
    setForgeMessage(null);
    try {
      const { jobIds, failures } = await enqueueForgeBatches(ids);
      if (jobIds.length) {
        await logAdminAction('content_forge_enqueued', { count: ids.length, jobIds });
        clearSelection();
        setForgeMessage(forgeQueuedMessage(ids.length, jobIds, failures));
      }
      if (failures.length) setForgeError(forgeFailureMessage(failures));
    } finally {
      setForgingSelected(false);
    }
  };
  return { forgingSelected, forgeMessage, forgeError, handleForgeSelected };
}

/**
 * Rejects each id in turn through `reject`, never stopping on a failure: a
 * null answer is a failure the transition hook has already written under the
 * card as "Reject failed: <reason>". Resolves the ids that went and the count.
 */
async function rejectEach(ids, reject) {
  let successCount = 0;
  const failures = [];
  for (const contentId of ids) {
    const result = await reject(contentId, { reviewNotes: 'Bulk rejected from queue' });
    if (result) successCount += 1;
    else failures.push(contentId);
  }
  const failedIds = new Set(failures);
  return {
    successCount,
    failureCount: failures.length,
    succeeded: new Set(ids.filter((id) => !failedIds.has(id))),
  };
}

/**
 * @param {object} params
 * @param {Array} params.items the queue items currently on screen
 * @param {Function} params.setItems optimistic updates land through this
 * @param {string} params.statusFilter which filter is showing — the rejected
 *   view keeps an item on screen after a permanent delete, the others do not
 * @param {string} params.contentTypeFilter only used to clear the selection
 */
export function useQueueActions({ items, setItems, statusFilter, contentTypeFilter }) {
  const [localLoading, setActionLoading] = useState({});
  const [localError, setActionError] = useState({});
  const transitions = useContentTransitions();
  const actionLoading = useMemo(
    () => mergeItemMaps(transitions.loading, localLoading),
    [transitions.loading, localLoading]
  );
  const actionError = useMemo(
    () => mergeItemMaps(transitions.errors, localError),
    [transitions.errors, localError]
  );
  const [bulkDeletingRejected, setBulkDeletingRejected] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState(null);
  const [bulkDeleteMessage, setBulkDeleteMessage] = useState(null);
  // { type: 'reject'|'bulkDelete'|'bulkReject'|'restore'|'deleteRejected', id?: string, ids?: string[] }
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkRejecting, setBulkRejecting] = useState(false);

  // Changing filter changes which items are on screen, so a selection made
  // against the old set would bulk-act on items the admin can no longer see.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter, contentTypeFilter]);

  const toggleSelected = useCallback((id) => setSelectedIds((prev) => toggleId(prev, id)), []);

  // Operates on the caller-supplied visible ids rather than `items` so a
  // sorted or paged view selects exactly what the admin is looking at.
  const toggleSelectAll = useCallback(
    (visibleIds) => setSelectedIds((prev) => toggleAllIds(prev, visibleIds)),
    []
  );

  const { forgingSelected, forgeMessage, forgeError, handleForgeSelected } = useForgeSelected(
    () => selectedOnScreen(selectedIds, items),
    () => setSelectedIds(new Set())
  );

  const handleBulkReject = () => {
    const ids = selectedOnScreen(selectedIds, items);
    if (ids.length >= 2) setConfirmTarget({ type: 'bulkReject', ids });
  };

  const doBulkReject = async (ids) => {
    setBulkRejecting(true);
    setBulkDeleteError(null);
    setBulkDeleteMessage(null);
    try {
      const { successCount, failureCount, succeeded } = await rejectEach(ids, transitions.reject);
      setItems((prev) => prev.filter((item) => !succeeded.has(item.id)));
      setSelectedIds(new Set());
      setBulkDeleteMessage(bulkRejectMessage(successCount, failureCount));
    } finally {
      setBulkRejecting(false);
    }
  };

  const handleApprove = async (item) => {
    const contentId = item.id;
    const publishTarget = getPublishTargetForItem(item);
    const result = await transitions.approve(item, {
      publishTarget,
      reviewNotes: `Approved in queue for ${publishTarget} publish stage`,
    });
    if (result) setItems((prev) => prev.filter((entry) => entry.id !== contentId));
  };

  const handleReject = (contentId) => {
    setConfirmTarget({ type: 'reject', id: contentId });
  };

  const doReject = async (contentId) => {
    const result = await transitions.reject(contentId, { reviewNotes: 'Rejected from queue' });
    if (result) setItems((prev) => prev.filter((item) => item.id !== contentId));
  };

  const handleDeleteRejectedNow = () => {
    if (statusFilter === 'rejected') setConfirmTarget({ type: 'bulkDelete' });
    else setBulkDeleteError('Switch the filter to Rejected to bulk delete those items.');
  };

  const doBulkDelete = async () => {
    setBulkDeleteError(null);
    setBulkDeleteMessage(null);
    setBulkDeletingRejected(true);
    try {
      const deletedCount = await deleteAllRejected();
      await logAdminAction('bulk_delete_rejected', { deletedCount, mode: 'soft' });
      setItems([]);
      setBulkDeleteMessage(`Soft-deleted ${deletedCount} rejected items. Recoverable for 7 days.`);
    } catch (err) {
      console.error('Delete rejected error:', err);
      setBulkDeleteError(`Delete rejected failed: ${err.message}`);
    } finally {
      setBulkDeletingRejected(false);
    }
  };

  const handleRestore = (contentId) => {
    setConfirmTarget({ type: 'restore', id: contentId });
  };

  const handlePermanentDelete = (contentId) => {
    setConfirmTarget({ type: 'deleteRejected', id: contentId });
  };

  const doRestore = async (contentId) => {
    const result = await transitions.restore(contentId, {
      reviewNotes: 'Restored from rejected status',
    });
    if (result) setItems((prev) => prev.filter((item) => item.id !== contentId));
  };

  /**
   * One card's own action: its spinner shows `state` while `work` runs, and
   * a failure is logged under `label` and written under the card as
   * "<failure>: <reason>".
   */
  const runItemAction = async (contentId, state, { label, failure }, work) => {
    setActionError((prev) => ({ ...prev, [contentId]: null }));
    setActionLoading((prev) => ({ ...prev, [contentId]: state }));
    try {
      await work();
    } catch (err) {
      console.error(label, err);
      setActionError((prev) => ({ ...prev, [contentId]: `${failure}: ${err.message}` }));
    } finally {
      setActionLoading((prev) => ({ ...prev, [contentId]: null }));
    }
  };
  const dropItem = (contentId) => setItems((prev) => prev.filter((item) => item.id !== contentId));

  const doPermanentDelete = (contentId) =>
    runItemAction(
      contentId,
      'deleting',
      { label: 'Permanent delete error:', failure: 'Permanent delete failed' },
      async () => {
        await postJSON('deleteContentItem', { contentId });
        await logAdminAction('content_deleted_from_rejected_queue', { contentId });
        dropItem(contentId);
      }
    );

  /**
   * Run whatever the confirm modal was opened for.
   *
   * Deliberately NOT memoized. It was `useCallback(..., [confirmTarget])`,
   * which is wrong in a way that only shows up under load: every `do*` below is
   * a fresh closure each render over the current `items` and `selectedIds`, so
   * pinning this to `confirmTarget` captures the versions from whichever render
   * last changed the target and acts on the state as it was then. Memoizing
   * bought nothing either — the dependencies change every render regardless.
   */
  const handleConfirm = async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    const run = {
      reject: () => doReject(target.id),
      bulkDelete: () => doBulkDelete(),
      bulkReject: () => doBulkReject(target.ids || []),
      restore: () => doRestore(target.id),
      deleteRejected: () => doPermanentDelete(target.id),
    };
    if (target) await run[target.type]?.();
  };

  const handleReinspect = (contentId) =>
    runItemAction(
      contentId,
      'inspecting',
      { label: 'Reinspect error:', failure: 'Reinspect failed' },
      async () => {
        await requestContentInspection(contentId);
        dropItem(contentId);
      }
    );

  const handleGenerateHero = (contentId) =>
    runItemAction(
      contentId,
      'generatingHero',
      { label: 'Generate hero error:', failure: 'Image generation failed' },
      async () => {
        const imageUrl = await generateHeroImage(contentId);
        setItems(withHeroImage(contentId, imageUrl));
      }
    );

  return {
    actionLoading,
    actionError,
    bulkDeletingRejected,
    bulkDeleteError,
    bulkDeleteMessage,
    bulkRejecting,
    confirmTarget,
    setConfirmTarget,
    selectedIds,
    toggleSelected,
    toggleSelectAll,
    forgingSelected,
    forgeMessage,
    forgeError,
    handleForgeSelected,
    handleApprove,
    handleBulkReject,
    handleConfirm,
    handleDeleteRejectedNow,
    handleGenerateHero,
    handlePermanentDelete,
    handleReinspect,
    handleReject,
    handleRestore,
  };
}
